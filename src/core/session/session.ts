// The tutoring policy. The model generates hints and plans, but whether a
// hint, a reveal or a checkpoint pass is allowed is decided here.

export const MAX_CHECKPOINTS = 6;
/** Hint levels per checkpoint: 1 asks a question, 2 points at code, 3 explains. */
export const HINT_LEVELS = 3;

export type Phase = 'planning' | 'building' | 'independent-check' | 'complete';

export interface CheckpointPlan {
  readonly title: string;
  readonly description: string;
}

export interface Checkpoint extends CheckpointPlan {
  readonly status: 'pending' | 'active' | 'passed';
  /** Highest hint level given so far; 0 means no hints. */
  readonly hintsUsed: number;
  readonly questionsAsked: number;
  readonly solutionRevealed: boolean;
}

export interface Session {
  readonly goal: string;
  readonly phase: Phase;
  readonly checkpoints: readonly Checkpoint[];
  readonly independentCheckPassed: boolean;
}

/** What the learner's tools reported for their current code. */
export interface ToolEvidence {
  readonly errors: number;
  readonly tests: 'passed' | 'failed' | 'not-run';
  /** Files saved during the session. Zero means no work to check. */
  readonly changedFiles: number;
}

/**
 * Tool results plus a review of whether the code does what the checkpoint
 * asks. Code that compiles can still do nothing, so both must pass. The
 * review can only block a pass: it is not run when the tools fail.
 */
export interface CheckEvidence extends ToolEvidence {
  readonly review: 'passed' | 'failed' | 'not-run';
}

export type SessionEvent =
  | { readonly type: 'plan-ready'; readonly checkpoints: readonly CheckpointPlan[] }
  | { readonly type: 'hint-requested' }
  | { readonly type: 'question-asked' }
  | { readonly type: 'solution-revealed' }
  | { readonly type: 'checks-reported'; readonly evidence: CheckEvidence }
  | { readonly type: 'ended' };

/** Events handled per phase; `ended` is handled the same way in every phase. */
type PhaseEvent = Exclude<SessionEvent, { readonly type: 'ended' }>;

export type RejectionReason =
  | 'wrong-phase'
  | 'invalid-plan'
  | 'hint-limit-reached'
  | 'reveal-locked'
  | 'assistance-disabled'
  | 'checks-failing';

export type TransitionResult =
  | { readonly ok: true; readonly session: Session }
  | { readonly ok: false; readonly reason: RejectionReason };

export function createSession(goal: string): Session {
  const trimmed = goal.trim();
  if (trimmed === '') {
    throw new RangeError('A session needs a goal');
  }
  return { goal: trimmed, phase: 'planning', checkpoints: [], independentCheckPassed: false };
}

export function transition(session: Session, event: SessionEvent): TransitionResult {
  if (session.phase === 'complete') {
    return reject('wrong-phase');
  }
  if (event.type === 'ended') {
    return accept({ ...session, phase: 'complete' });
  }

  switch (session.phase) {
    case 'planning':
      return event.type === 'plan-ready' ? startBuilding(session, event.checkpoints) : reject('wrong-phase');
    case 'building':
      return build(session, event);
    case 'independent-check':
      return independentCheck(session, event);
  }
}

export function activeCheckpoint(session: Session): Checkpoint | undefined {
  return session.checkpoints.find((checkpoint) => checkpoint.status === 'active');
}

export interface SessionSummary {
  readonly checkpointsTotal: number;
  readonly checkpointsPassed: number;
  /** Passed with no hints, questions or reveal. */
  readonly checkpointsUnassisted: number;
  readonly hintsUsed: number;
  readonly questionsAsked: number;
  readonly solutionsRevealed: number;
  readonly independentCheckPassed: boolean;
}

export function summarize(session: Session): SessionSummary {
  const passed = session.checkpoints.filter((checkpoint) => checkpoint.status === 'passed');
  return {
    checkpointsTotal: session.checkpoints.length,
    checkpointsPassed: passed.length,
    checkpointsUnassisted: passed.filter(
      (c) => c.hintsUsed === 0 && c.questionsAsked === 0 && !c.solutionRevealed,
    ).length,
    hintsUsed: session.checkpoints.reduce((total, checkpoint) => total + checkpoint.hintsUsed, 0),
    questionsAsked: session.checkpoints.reduce((total, checkpoint) => total + checkpoint.questionsAsked, 0),
    solutionsRevealed: session.checkpoints.filter((checkpoint) => checkpoint.solutionRevealed).length,
    independentCheckPassed: session.independentCheckPassed,
  };
}

function startBuilding(session: Session, plan: readonly CheckpointPlan[]): TransitionResult {
  const valid =
    plan.length > 0 &&
    plan.length <= MAX_CHECKPOINTS &&
    plan.every((step) => step.title.trim() !== '' && step.description.trim() !== '');
  if (!valid) {
    return reject('invalid-plan');
  }
  const checkpoints = plan.map(
    (step, index): Checkpoint => ({
      title: step.title.trim(),
      description: step.description.trim(),
      status: index === 0 ? 'active' : 'pending',
      hintsUsed: 0,
      questionsAsked: 0,
      solutionRevealed: false,
    }),
  );
  return accept({ ...session, phase: 'building', checkpoints });
}

function build(session: Session, event: PhaseEvent): TransitionResult {
  const index = session.checkpoints.findIndex((checkpoint) => checkpoint.status === 'active');
  const current = session.checkpoints[index];
  if (!current) {
    throw new Error('Invariant violated: building with no active checkpoint');
  }

  switch (event.type) {
    case 'hint-requested':
      if (current.hintsUsed >= HINT_LEVELS) {
        return reject('hint-limit-reached');
      }
      return accept(updateCheckpoint(session, index, { hintsUsed: current.hintsUsed + 1 }));

    case 'question-asked':
      return accept(updateCheckpoint(session, index, { questionsAsked: current.questionsAsked + 1 }));

    case 'solution-revealed':
      if (current.hintsUsed < HINT_LEVELS) {
        return reject('reveal-locked');
      }
      return accept(updateCheckpoint(session, index, { solutionRevealed: true }));

    case 'checks-reported': {
      if (!isPassing(event.evidence)) {
        return reject('checks-failing');
      }
      const passed = updateCheckpoint(session, index, { status: 'passed' });
      const isLast = index === session.checkpoints.length - 1;
      return accept(
        isLast
          ? { ...passed, phase: 'independent-check' }
          : updateCheckpoint(passed, index + 1, { status: 'active' }),
      );
    }

    case 'plan-ready':
      return reject('wrong-phase');
  }
}

function independentCheck(session: Session, event: PhaseEvent): TransitionResult {
  switch (event.type) {
    case 'hint-requested':
    case 'question-asked':
    case 'solution-revealed':
      return reject('assistance-disabled');
    case 'checks-reported':
      return isPassing(event.evidence)
        ? accept({ ...session, phase: 'complete', independentCheckPassed: true })
        : reject('checks-failing');
    case 'plan-ready':
      return reject('wrong-phase');
  }
}

function isPassing(evidence: CheckEvidence): boolean {
  return toolsPass(evidence) && evidence.review === 'passed';
}

export function toolsPass(evidence: ToolEvidence): boolean {
  return evidence.changedFiles > 0 && evidence.errors === 0 && evidence.tests !== 'failed';
}

function updateCheckpoint(session: Session, index: number, changes: Partial<Checkpoint>): Session {
  return {
    ...session,
    checkpoints: session.checkpoints.map((checkpoint, i) =>
      i === index ? { ...checkpoint, ...changes } : checkpoint,
    ),
  };
}

function accept(session: Session): TransitionResult {
  return { ok: true, session };
}

function reject(reason: RejectionReason): TransitionResult {
  return { ok: false, reason };
}
