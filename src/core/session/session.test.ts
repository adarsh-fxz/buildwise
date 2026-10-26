import { describe, expect, it } from 'vitest';
import {
  activeCheckpoint,
  type CheckEvidence,
  createSession,
  HINT_LEVELS,
  MAX_CHECKPOINTS,
  type Session,
  type SessionEvent,
  summarize,
  transition,
} from './session';

const PASSING: CheckEvidence = { errors: 0, tests: 'passed' };
const plan = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ title: `Step ${String(i + 1)}`, description: `Do step ${String(i + 1)}` }));

/** Applies events that must all be accepted. */
function apply(session: Session, ...events: SessionEvent[]): Session {
  return events.reduce((current, event) => {
    const result = transition(current, event);
    if (!result.ok) {
      throw new Error(`${event.type} was rejected: ${result.reason}`);
    }
    return result.session;
  }, session);
}

function rejection(session: Session, event: SessionEvent) {
  const result = transition(session, event);
  return result.ok ? 'accepted' : result.reason;
}

const hint: SessionEvent = { type: 'hint-requested' };
const reveal: SessionEvent = { type: 'solution-revealed' };
const checks = (evidence: CheckEvidence = PASSING): SessionEvent => ({ type: 'checks-reported', evidence });
const building = (steps = 2) => apply(createSession('Add pagination'), { type: 'plan-ready', checkpoints: plan(steps) });

describe('createSession', () => {
  it('starts in planning with a trimmed goal', () => {
    expect(createSession('  Add pagination ')).toEqual({
      goal: 'Add pagination',
      phase: 'planning',
      checkpoints: [],
      independentCheckPassed: false,
    });
  });

  it('refuses an empty goal', () => {
    expect(() => createSession('   ')).toThrow(RangeError);
  });
});

describe('planning', () => {
  it('activates the first checkpoint when a plan arrives', () => {
    const session = building(3);
    expect(session.phase).toBe('building');
    expect(session.checkpoints.map((c) => c.status)).toEqual(['active', 'pending', 'pending']);
    expect(activeCheckpoint(session)?.title).toBe('Step 1');
  });

  it.each([
    ['no checkpoints', plan(0)],
    ['too many checkpoints', plan(MAX_CHECKPOINTS + 1)],
    ['a blank title', [{ title: ' ', description: 'x' }]],
    ['a blank description', [{ title: 'x', description: '' }]],
  ])('rejects a plan with %s', (_, checkpoints) => {
    expect(rejection(createSession('goal'), { type: 'plan-ready', checkpoints })).toBe('invalid-plan');
  });

  it('accepts no other events', () => {
    const session = createSession('goal');
    expect(rejection(session, hint)).toBe('wrong-phase');
    expect(rejection(session, checks())).toBe('wrong-phase');
  });
});

describe('hints and reveals', () => {
  it('climbs one level per request and stops at the last level', () => {
    let session = building();
    for (let level = 1; level <= HINT_LEVELS; level++) {
      session = apply(session, hint);
      expect(activeCheckpoint(session)?.hintsUsed).toBe(level);
    }
    expect(rejection(session, hint)).toBe('hint-limit-reached');
  });

  it('keeps the solution locked until every hint level is used', () => {
    let session = building();
    for (let level = 0; level < HINT_LEVELS; level++) {
      expect(rejection(session, reveal)).toBe('reveal-locked');
      session = apply(session, hint);
    }
    session = apply(session, reveal);
    expect(activeCheckpoint(session)?.solutionRevealed).toBe(true);
  });

  it('resets the ladder for the next checkpoint', () => {
    const session = apply(building(), hint, hint, checks());
    expect(activeCheckpoint(session)).toMatchObject({ title: 'Step 2', hintsUsed: 0 });
    expect(session.checkpoints[0]).toMatchObject({ status: 'passed', hintsUsed: 2 });
  });
});

describe('passing checkpoints', () => {
  it.each<[string, CheckEvidence]>([
    ['compile errors', { errors: 1, tests: 'passed' }],
    ['failing tests', { errors: 0, tests: 'failed' }],
  ])('refuses to pass with %s', (_, evidence) => {
    const session = building();
    expect(rejection(session, checks(evidence))).toBe('checks-failing');
  });

  it('passes with a clean compile when there are no tests to run', () => {
    const session = apply(building(), checks({ errors: 0, tests: 'not-run' }));
    expect(activeCheckpoint(session)?.title).toBe('Step 2');
  });

  it('moves to the independent check after the last checkpoint', () => {
    const session = apply(building(2), checks(), checks());
    expect(session.phase).toBe('independent-check');
    expect(activeCheckpoint(session)).toBeUndefined();
  });
});

describe('independent check', () => {
  const checking = () => apply(building(1), checks());

  it('refuses all assistance', () => {
    expect(rejection(checking(), hint)).toBe('assistance-disabled');
    expect(rejection(checking(), reveal)).toBe('assistance-disabled');
  });

  it('completes the session when checks pass', () => {
    expect(rejection(checking(), checks({ errors: 2, tests: 'not-run' }))).toBe('checks-failing');
    const session = apply(checking(), checks());
    expect(session).toMatchObject({ phase: 'complete', independentCheckPassed: true });
  });
});

describe('ending', () => {
  it.each([
    ['planning', () => createSession('goal')],
    ['building', () => building()],
    ['the independent check', () => apply(building(1), checks())],
  ])('can end early during %s', (_, start) => {
    const session = apply(start(), { type: 'ended' });
    expect(session).toMatchObject({ phase: 'complete', independentCheckPassed: false });
  });

  it('accepts nothing once complete', () => {
    const session = apply(building(), { type: 'ended' });
    expect(rejection(session, { type: 'ended' })).toBe('wrong-phase');
    expect(rejection(session, hint)).toBe('wrong-phase');
  });
});

it('never mutates the session it was given', () => {
  const session = Object.freeze(building());
  const snapshot = structuredClone(session);
  apply(session, hint, hint, hint, reveal, checks());
  expect(session).toEqual(snapshot);
});

describe('summarize', () => {
  it('counts help used and checkpoints passed without help', () => {
    const session = apply(
      building(3),
      checks(), // step 1: unassisted
      hint,
      checks(), // step 2: one hint
      hint,
      hint,
      hint,
      reveal,
      checks(), // step 3: revealed
      checks(), // independent check
    );
    expect(summarize(session)).toEqual({
      checkpointsTotal: 3,
      checkpointsPassed: 3,
      checkpointsUnassisted: 1,
      hintsUsed: 4,
      solutionsRevealed: 1,
      independentCheckPassed: true,
    });
  });

  it('reports partial progress for a session ended early', () => {
    const session = apply(building(3), checks(), { type: 'ended' });
    expect(summarize(session)).toMatchObject({ checkpointsTotal: 3, checkpointsPassed: 1 });
  });
});
