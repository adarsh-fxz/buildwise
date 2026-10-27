import { formatProblem, type Problem } from '../checks/output';
import type { CheckReport } from '../checks/report';
import { describeError } from '../mentor/errors';
import type { Mentor, Review } from '../mentor/mentor';
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
  toolsPass,
  type ToolEvidence,
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

export type Activity = 'thinking' | 'checking' | 'reviewing';

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
  private challengeTask: string | undefined;
  private activity: Activity | undefined;

  constructor(
    private readonly mentor: Mentor,
    /** Called with the goal and current step, so related files can be found. */
    private readonly context: (focus: string) => Promise<RepositoryContext>,
    private readonly onChange: (state: TutorState) => void = () => undefined,
  ) {}

  get state(): TutorState {
    return {
      session: this.session,
      transcript: [...this.transcript],
      activity: this.activity,
      // Explaining is for tool errors; a failed review already says what is missing.
      canExplain: Boolean(this.lastFailure?.problems.length) && this.session?.phase === 'building',
    };
  }

  async start(goal: string): Promise<void> {
    if (this.activity || (this.session && this.session.phase !== 'complete')) return;
    const session = createSession(goal);
    this.transcript = [{ from: 'learner', kind: 'goal', text: session.goal, label: 'Goal' }];
    this.hintsForCheckpoint = [];
    this.lastFailure = undefined;
    this.challengeTask = undefined;

    await this.run('thinking', async () => {
      const plan = await this.mentor.plan(session.goal, await this.context(session.goal));
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
      // Reviewing is only worth a request once the tools pass; failing code can't pass anyway.
      const review = toolsPass(report.evidence) ? await this.reviewWork(before, report) : undefined;
      const evidence: CheckEvidence = {
        ...report.evidence,
        review: review === undefined ? 'not-run' : review.passes ? 'passed' : 'failed',
      };
      const scope = review ? `${report.scope} and a code review` : report.scope;

      const result = transition(before, { type: 'checks-reported', evidence });
      if (!result.ok) {
        if (result.reason === 'checks-failing') {
          this.lastFailure = report;
          this.add({
            from: 'buildwise',
            kind: 'check',
            text: describeFailure({ ...report, scope }, evidence, review),
            label: 'Check',
            tone: 'error',
            problems: report.problems,
          });
          await this.hintAfterFailure(review && !review.passes ? review.feedback : describeProblems(report));
        } else {
          this.notice(REJECTION_MESSAGES[result.reason]);
        }
        return;
      }

      const next = result.session;
      const passed = before.checkpoints.findIndex((c) => c.status === 'active');
      const praise = review?.feedback ? ` ${review.feedback}` : '';
      const notes = report.notes.length ? ` ${report.notes.join(' ')}` : '';
      if (next.phase === 'independent-check') {
        this.activity = 'thinking';
        this.emit();
        const task = await this.mentor.challenge(next, await this.contextFor(next));
        this.commitPass(next);
        this.challengeTask = task;
        this.notice(`Checkpoint ${String(passed + 1)} passes, checked with ${scope}.${praise} That was the last one.${notes}`, 'success');
        this.add({ from: 'mentor', kind: 'challenge', text: task, label: 'Independent check' });
        this.notice('Do this one without help: hints and questions are off. Check your work when it is done.');
      } else if (next.phase === 'complete') {
        this.commitPass(next);
        this.notice(`The independent check passes, checked with ${scope}.${praise}${notes}`, 'success');
        this.finish(next);
      } else {
        this.commitPass(next);
        const upcoming = activeCheckpoint(next);
        this.notice(
          `Checkpoint ${String(passed + 1)} passes, checked with ${scope}.${praise} Next: ${upcoming?.title ?? ''}.${notes}`,
          'success',
        );
      }
    });
  }

  /**
   * Gives the next hint, aimed at what the check found. It counts as a hint,
   * and does nothing in the independent check or once hints run out.
   */
  private async hintAfterFailure(failure: string): Promise<void> {
    const session = this.session;
    if (!session) return;
    const result = transition(session, { type: 'hint-requested' });
    if (!result.ok) return;
    this.activity = 'thinking';
    this.emit();
    const level = activeCheckpoint(result.session)?.hintsUsed ?? 0;
    const text = await this.mentor.hint(result.session, level, [...this.hintsForCheckpoint], await this.contextFor(result.session), failure);
    this.session = result.session;
    this.hintsForCheckpoint.push(text);
    this.add({ from: 'mentor', kind: 'hint', text, label: `Hint ${String(level)} of ${String(HINT_LEVELS)}` });
  }

  /** Asks whether the saved code does what the current step, or the independent-check task, asks. */
  private async reviewWork(session: Session, report: CheckReport): Promise<Review> {
    this.activity = 'reviewing';
    this.emit();
    const current = activeCheckpoint(session);
    const task =
      session.phase === 'independent-check'
        ? (this.challengeTask ?? 'The independent check task.')
        : `${current?.title ?? ''}: ${current?.description ?? ''}`;
    return this.mentor.review(session, task, report.files, await this.contextFor(session));
  }

  private contextFor(session: Session): Promise<RepositoryContext> {
    const current = activeCheckpoint(session);
    const step =
      session.phase === 'independent-check' ? this.challengeTask : current && `${current.title}: ${current.description}`;
    return this.context([session.goal, step].filter(Boolean).join('\n'));
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
      const commit = await work(result.session, await this.contextFor(result.session));
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

/** The headline, review feedback and notes of a failed check; the errors travel separately as `problems`. */
export function describeFailure(report: CheckReport, evidence: CheckEvidence, review?: Review): string {
  const lines = [`Not passing yet: ${describeEvidence(evidence)}, checked with ${report.scope}.`];
  if (review && !review.passes) lines.push(review.feedback);
  return [...lines, ...report.notes].join('\n');
}

const MAX_PROBLEMS_FOR_HINT = 3;
const MAX_TEST_OUTPUT_FOR_HINT = 1500;

/** What a failed check found, briefly, for the hint that follows it. */
function describeProblems(report: CheckReport): string {
  const lines = [describeEvidence(report.evidence), ...report.problems.slice(0, MAX_PROBLEMS_FOR_HINT).map(formatProblem)];
  if (report.testOutput) lines.push(report.testOutput.slice(-MAX_TEST_OUTPUT_FOR_HINT));
  return lines.join('\n');
}

export function describeEvidence(evidence: ToolEvidence | CheckEvidence): string {
  const { errors, tests, changedFiles } = evidence;
  if (changedFiles === 0) return 'no files saved in this session yet';
  if (errors === 0 && tests !== 'failed' && 'review' in evidence && evidence.review === 'failed') {
    return 'the code does not do what this step asks yet';
  }
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
