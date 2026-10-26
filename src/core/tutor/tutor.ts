import type { Problem } from '../checks/output';
import type { CheckReport } from '../checks/report';
import { describeError } from '../mentor/errors';
import type { Mentor } from '../mentor/mentor';
import type { RepositoryContext } from '../mentor/prompts';
import {
  activeCheckpoint,
  type CheckEvidence,
  createSession,
  HINT_LEVELS,
  type RejectionReason,
  type Session,
  type SessionEvent,
  summarize,
  type SessionSummary,
  transition,
} from '../session/session';

export type EntryKind =
  | 'goal'
  | 'plan'
  | 'hint'
  | 'solution'
  | 'question'
  | 'answer'
  | 'challenge'
  | 'explanation'
  | 'check'
  | 'notice'
  | 'summary';

export interface TranscriptEntry {
  readonly from: 'learner' | 'mentor' | 'buildwise';
  readonly kind: EntryKind;
  readonly text: string;
  /** Short tag shown above the message, such as "Hint 2 of 3". */
  readonly label?: string;
  /** Set when the entry reports a success or a failure. */
  readonly tone?: 'success' | 'error';
  /** The errors behind a failed check. */
  readonly problems?: readonly Problem[];
  /** The numbers behind a session summary. */
  readonly summary?: SessionSummary;
}

export type Activity = 'thinking' | 'checking';

export interface TutorState {
  readonly session: Session | undefined;
  readonly transcript: readonly TranscriptEntry[];
  /** What the tutor is waiting on, if anything. Actions are ignored meanwhile. */
  readonly activity: Activity | undefined;
  /** Whether the last check failed and can be explained. */
  readonly canExplain: boolean;
}

const REJECTION_MESSAGES: Record<RejectionReason, string> = {
  'wrong-phase': 'That is not available right now.',
  'invalid-plan': 'The plan came back malformed. Try describing the goal differently.',
  'hint-limit-reached': 'That was the last hint for this checkpoint. Keep going, or reveal the solution.',
  'reveal-locked': `The solution unlocks after hint ${String(HINT_LEVELS)}.`,
  'assistance-disabled': 'Help is off for the independent check. This one is yours.',
  'checks-failing': 'Not passing yet.',
};

/**
 * Runs a session: applies learner actions to the policy, asks the mentor for
 * words, and keeps the transcript. A step is committed only after the mentor
 * succeeds, so a failed request never uses up a hint.
 */
export class Tutor {
  private session: Session | undefined;
  private transcript: TranscriptEntry[] = [];
  private hintsForCheckpoint: string[] = [];
  private lastFailure: CheckReport | undefined;
  private activity: Activity | undefined;

  constructor(
    private readonly mentor: Mentor,
    private readonly context: () => Promise<RepositoryContext>,
    private readonly onChange: (state: TutorState) => void = () => undefined,
  ) {}

  get state(): TutorState {
    return {
      session: this.session,
      transcript: [...this.transcript],
      activity: this.activity,
      canExplain: this.lastFailure !== undefined && this.session?.phase === 'building',
    };
  }

  async start(goal: string): Promise<void> {
    if (this.activity || (this.session && this.session.phase !== 'complete')) return;
    const session = createSession(goal);
    this.transcript = [{ from: 'learner', kind: 'goal', text: session.goal, label: 'Goal' }];
    this.hintsForCheckpoint = [];
    this.lastFailure = undefined;

    await this.run('thinking', async () => {
      const plan = await this.mentor.plan(session.goal, await this.context());
      const result = transition(session, { type: 'plan-ready', checkpoints: plan });
      if (!result.ok) {
        this.notice(REJECTION_MESSAGES[result.reason]);
        return;
      }
      this.session = result.session;
      const steps = result.session.checkpoints.map((c, i) => `${String(i + 1)}. ${c.title}: ${c.description}`);
      this.add({ from: 'mentor', kind: 'plan', text: steps.join('\n'), label: 'Plan' });
      this.notice('Start with checkpoint 1. Ask for a hint when you are stuck, and check your work when you think it is done.');
    });
  }

  async hint(): Promise<void> {
    await this.step({ type: 'hint-requested' }, async (next, context) => {
      const level = activeCheckpoint(next)?.hintsUsed ?? 0;
      const text = await this.mentor.hint(next, level, [...this.hintsForCheckpoint], context);
      return () => {
        this.hintsForCheckpoint.push(text);
        this.add({ from: 'mentor', kind: 'hint', text, label: `Hint ${String(level)} of ${String(HINT_LEVELS)}` });
      };
    });
  }

  async reveal(): Promise<void> {
    await this.step({ type: 'solution-revealed' }, async (next, context) => {
      const text = await this.mentor.solution(next, context);
      return () => {
        this.add({ from: 'mentor', kind: 'solution', text, label: 'Solution' });
      };
    });
  }

  async ask(question: string): Promise<void> {
    const trimmed = question.trim();
    if (trimmed === '') return;
    await this.step({ type: 'question-asked' }, async (next, context) => {
      const text = await this.mentor.answer(next, trimmed, context);
      return () => {
        this.add({ from: 'learner', kind: 'question', text: trimmed });
        this.add({ from: 'mentor', kind: 'answer', text });
      };
    });
  }

  /** Explaining a failure is help, so it counts as a question. */
  async explain(): Promise<void> {
    const failure = this.lastFailure;
    if (!failure) return;
    await this.step({ type: 'question-asked' }, async (next, context) => {
      const text = await this.mentor.explain(next, failure, context);
      return () => {
        this.add({ from: 'mentor', kind: 'explanation', text, label: 'About these errors' });
      };
    });
  }

  /** `collect` runs the learner's tools; it may take a while. */
  async check(collect: () => Promise<CheckReport>): Promise<void> {
    const phase = this.session?.phase;
    if (this.activity || (phase !== 'building' && phase !== 'independent-check')) return;

    await this.run('checking', async () => {
      const report = await collect();
      const before = this.session;
      if (!before) return;
      const result = transition(before, { type: 'checks-reported', evidence: report.evidence });
      if (!result.ok) {
        if (result.reason === 'checks-failing') {
          this.lastFailure = report;
          this.add({
            from: 'buildwise',
            kind: 'check',
            text: describeFailure(report),
            label: 'Check',
            tone: 'error',
            problems: report.problems,
          });
        } else {
          this.notice(REJECTION_MESSAGES[result.reason]);
        }
        return;
      }

      const next = result.session;
      const passed = before.checkpoints.findIndex((c) => c.status === 'active');
      const notes = report.notes.length ? ` ${report.notes.join(' ')}` : '';
      if (next.phase === 'independent-check') {
        this.activity = 'thinking';
        this.emit();
        const task = await this.mentor.challenge(next, await this.context());
        this.commitPass(next);
        this.notice(`Checkpoint ${String(passed + 1)} passes, checked with ${report.scope}. That was the last one.${notes}`, 'success');
        this.add({ from: 'mentor', kind: 'challenge', text: task, label: 'Independent check' });
        this.notice('Do this one without help: hints and questions are off. Check your work when it is done.');
      } else if (next.phase === 'complete') {
        this.commitPass(next);
        this.notice(`The independent check passes, checked with ${report.scope}.${notes}`, 'success');
        this.finish(next);
      } else {
        this.commitPass(next);
        const upcoming = activeCheckpoint(next);
        this.notice(
          `Checkpoint ${String(passed + 1)} passes, checked with ${report.scope}. Next: ${upcoming?.title ?? ''}.${notes}`,
          'success',
        );
      }
    });
  }

  end(): void {
    if (this.activity || !this.session) return;
    const result = transition(this.session, { type: 'ended' });
    if (result.ok) {
      this.session = result.session;
      this.finish(result.session);
      this.emit();
    }
  }

  private commitPass(next: Session): void {
    this.session = next;
    this.hintsForCheckpoint = [];
    this.lastFailure = undefined;
  }

  private finish(session: Session): void {
    const summary = summarize(session);
    this.add({ from: 'buildwise', kind: 'summary', text: formatSummary(summary), label: 'Session summary', summary });
  }

  /**
   * Validates an event against the policy, runs the mentor work, and commits
   * the new session only if that work succeeds.
   */
  private async step(
    event: SessionEvent,
    work: (next: Session, context: RepositoryContext) => Promise<() => void>,
  ): Promise<void> {
    if (this.activity || !this.session) return;
    const result = transition(this.session, event);
    if (!result.ok) {
      this.notice(REJECTION_MESSAGES[result.reason]);
      this.emit();
      return;
    }
    await this.run('thinking', async () => {
      const commit = await work(result.session, await this.context());
      this.session = result.session;
      commit();
    });
  }

  private async run(activity: Activity, work: () => Promise<void>): Promise<void> {
    this.activity = activity;
    this.emit();
    try {
      await work();
    } catch (error) {
      this.notice(describeError(error), 'error');
    } finally {
      this.activity = undefined;
      this.emit();
    }
  }

  private add(entry: TranscriptEntry): void {
    this.transcript.push(entry);
  }

  private notice(text: string, tone?: TranscriptEntry['tone']): void {
    this.add(tone ? { from: 'buildwise', kind: 'notice', text, tone } : { from: 'buildwise', kind: 'notice', text });
  }

  private emit(): void {
    this.onChange(this.state);
  }
}

/** The headline and notes of a failed check; the errors travel separately as `problems`. */
export function describeFailure(report: CheckReport): string {
  return [`Not passing yet: ${describeEvidence(report.evidence)}, checked with ${report.scope}.`, ...report.notes].join('\n');
}

export function describeEvidence({ errors, tests, changedFiles }: CheckEvidence): string {
  if (changedFiles === 0) return 'no files saved since this checkpoint started';
  const parts = [`${String(errors)} ${errors === 1 ? 'error' : 'errors'}`];
  if (tests !== 'not-run') parts.push(`tests ${tests}`);
  return parts.join(', ');
}

export function formatSummary(summary: SessionSummary): string {
  const help = [
    `${String(summary.hintsUsed)} ${summary.hintsUsed === 1 ? 'hint' : 'hints'}`,
    `${String(summary.questionsAsked)} ${summary.questionsAsked === 1 ? 'question' : 'questions'}`,
    `${String(summary.solutionsRevealed)} ${summary.solutionsRevealed === 1 ? 'solution' : 'solutions'} revealed`,
  ];
  return [
    `Checkpoints passed: ${String(summary.checkpointsPassed)} of ${String(summary.checkpointsTotal)}, ${String(summary.checkpointsUnassisted)} without help.`,
    `Help used: ${help.join(', ')}.`,
    `Independent check: ${summary.independentCheckPassed ? 'passed' : 'not completed'}.`,
  ].join('\n');
}
