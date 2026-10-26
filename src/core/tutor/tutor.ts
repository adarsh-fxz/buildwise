import { describeError, type Mentor } from '../mentor/mentor';
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

export interface TranscriptEntry {
  readonly from: 'learner' | 'mentor' | 'buildwise';
  readonly text: string;
  /** Short tag shown above the message, such as "Hint 2 of 3". */
  readonly label?: string;
}

export interface TutorState {
  readonly session: Session | undefined;
  readonly transcript: readonly TranscriptEntry[];
  readonly busy: boolean;
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
  private busy = false;

  constructor(
    private readonly mentor: Mentor,
    private readonly context: () => Promise<RepositoryContext>,
    private readonly onChange: (state: TutorState) => void = () => undefined,
  ) {}

  get state(): TutorState {
    return { session: this.session, transcript: [...this.transcript], busy: this.busy };
  }

  async start(goal: string): Promise<void> {
    if (this.busy || (this.session && this.session.phase !== 'complete')) return;
    const session = createSession(goal);
    this.transcript = [{ from: 'learner', text: session.goal, label: 'Goal' }];
    this.hintsForCheckpoint = [];

    await this.run(async () => {
      const plan = await this.mentor.plan(session.goal, await this.context());
      const result = transition(session, { type: 'plan-ready', checkpoints: plan });
      if (!result.ok) {
        this.notice(REJECTION_MESSAGES[result.reason]);
        return;
      }
      this.session = result.session;
      const steps = result.session.checkpoints.map((c, i) => `${String(i + 1)}. ${c.title}: ${c.description}`);
      this.say('mentor', steps.join('\n'), 'Plan');
      this.notice('Start with checkpoint 1. Ask for a hint when you are stuck, and check your work when you think it is done.');
    });
  }

  async hint(): Promise<void> {
    await this.step({ type: 'hint-requested' }, async (next, context) => {
      const level = activeCheckpoint(next)?.hintsUsed ?? 0;
      const text = await this.mentor.hint(next, level, [...this.hintsForCheckpoint], context);
      return () => {
        this.hintsForCheckpoint.push(text);
        this.say('mentor', text, `Hint ${String(level)} of ${String(HINT_LEVELS)}`);
      };
    });
  }

  async reveal(): Promise<void> {
    await this.step({ type: 'solution-revealed' }, async (next, context) => {
      const text = await this.mentor.solution(next, context);
      return () => {
        this.say('mentor', text, 'Solution');
      };
    });
  }

  async ask(question: string): Promise<void> {
    const trimmed = question.trim();
    if (trimmed === '') return;
    await this.step({ type: 'question-asked' }, async (next, context) => {
      const text = await this.mentor.answer(next, trimmed, context);
      return () => {
        this.say('learner', trimmed);
        this.say('mentor', text);
      };
    });
  }

  /** `scope` says what was checked, such as "4 open files". */
  async check(evidence: CheckEvidence, scope: string): Promise<void> {
    const before = this.session;
    await this.step(
      { type: 'checks-reported', evidence },
      async (next, context) => {
        const passed = before?.checkpoints.findIndex((c) => c.status === 'active') ?? -1;
        if (next.phase === 'independent-check') {
          const task = await this.mentor.challenge(next, context);
          return () => {
            this.hintsForCheckpoint = [];
            this.notice(`Checkpoint ${String(passed + 1)} passes. That was the last one.`);
            this.say('mentor', task, 'Independent check');
            this.notice('Do this one without help: hints and questions are off. Check your work when it is done.');
          };
        }
        return () => {
          this.hintsForCheckpoint = [];
          if (next.phase === 'complete') {
            this.notice('The independent check passes.');
            this.finish(next);
          } else {
            const upcoming = activeCheckpoint(next);
            this.notice(`Checkpoint ${String(passed + 1)} passes. Next: ${upcoming?.title ?? ''}.`);
          }
        };
      },
      (reason) =>
        reason === 'checks-failing' ? `Not passing yet: ${describeEvidence(evidence)} (checked ${scope}).` : undefined,
    );
  }

  end(): void {
    if (this.busy || !this.session) return;
    const result = transition(this.session, { type: 'ended' });
    if (result.ok) {
      this.session = result.session;
      this.finish(result.session);
      this.emit();
    }
  }

  private finish(session: Session): void {
    this.say('buildwise', formatSummary(summarize(session)), 'Session summary');
  }

  /**
   * Validates an event against the policy, runs the mentor work, and commits
   * the new session only if that work succeeds.
   */
  private async step(
    event: SessionEvent,
    work: (next: Session, context: RepositoryContext) => Promise<() => void>,
    explain: (reason: RejectionReason) => string | undefined = () => undefined,
  ): Promise<void> {
    if (this.busy || !this.session) return;
    const result = transition(this.session, event);
    if (!result.ok) {
      this.notice(explain(result.reason) ?? REJECTION_MESSAGES[result.reason]);
      this.emit();
      return;
    }
    await this.run(async () => {
      const commit = await work(result.session, await this.context());
      this.session = result.session;
      commit();
    });
  }

  private async run(work: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.emit();
    try {
      await work();
    } catch (error) {
      this.notice(describeError(error));
    } finally {
      this.busy = false;
      this.emit();
    }
  }

  private say(from: TranscriptEntry['from'], text: string, label?: string): void {
    this.transcript.push(label === undefined ? { from, text } : { from, text, label });
  }

  private notice(text: string): void {
    this.say('buildwise', text);
  }

  private emit(): void {
    this.onChange(this.state);
  }
}

export function describeEvidence({ errors, tests }: CheckEvidence): string {
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
