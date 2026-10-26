import { describe, expect, it, vi } from 'vitest';
import type { Mentor } from '../mentor/mentor';
import { activeCheckpoint, type CheckEvidence } from '../session/session';
import { describeEvidence, Tutor } from './tutor';

const PASSING: CheckEvidence = { errors: 0, tests: 'not-run', changedFiles: 1 };
const FAILING: CheckEvidence = { errors: 2, tests: 'not-run', changedFiles: 1 };

function fakeMentor(overrides: Partial<Mentor> = {}): Mentor {
  return {
    plan: vi.fn().mockResolvedValue([
      { title: 'Read the page param', description: 'From the URL.' },
      { title: 'Limit the query', description: 'One page of rows.' },
    ]),
    hint: vi.fn((_session, level: number) => Promise.resolve(`hint ${String(level)}`)),
    solution: vi.fn().mockResolvedValue('the solution'),
    answer: vi.fn().mockResolvedValue('an answer'),
    challenge: vi.fn().mockResolvedValue('a related task'),
    ...overrides,
  };
}

async function startedTutor(mentor = fakeMentor()) {
  const tutor = new Tutor(mentor, () => Promise.resolve({ files: ['src/index.ts'] }));
  await tutor.start('Add pagination');
  return tutor;
}

const last = (tutor: Tutor) => tutor.state.transcript.at(-1);
const current = (tutor: Tutor) => {
  const { session } = tutor.state;
  if (!session) throw new Error('Expected a session');
  return activeCheckpoint(session);
};

describe('Tutor', () => {
  it('plans the goal and shows the plan', async () => {
    const tutor = await startedTutor();
    expect(tutor.state.session?.phase).toBe('building');
    expect(tutor.state.transcript[0]).toEqual({ from: 'learner', text: 'Add pagination', label: 'Goal' });
    expect(tutor.state.transcript[1]).toMatchObject({ from: 'mentor', label: 'Plan' });
    expect(tutor.state.transcript[1]?.text).toContain('1. Read the page param: From the URL.');
  });

  it('gives escalating hints and passes the earlier ones along', async () => {
    const hint = vi.fn((_session, level: number) => Promise.resolve(`hint ${String(level)}`));
    const tutor = await startedTutor(fakeMentor({ hint }));
    await tutor.hint();
    await tutor.hint();
    expect(last(tutor)).toEqual({ from: 'mentor', text: 'hint 2', label: 'Hint 2 of 3' });
    expect(hint).toHaveBeenLastCalledWith(expect.anything(), 2, ['hint 1'], expect.anything());
  });

  it('does not use up a hint when the mentor fails', async () => {
    const mentor = fakeMentor({ hint: vi.fn().mockRejectedValue(new Error('network down')) });
    const tutor = await startedTutor(mentor);
    await tutor.hint();
    expect(current(tutor)?.hintsUsed).toBe(0);
    expect(last(tutor)).toEqual({ from: 'buildwise', text: 'network down' });
    expect(tutor.state.busy).toBe(false);
  });

  it('refuses a reveal before the last hint without calling the mentor', async () => {
    const solution = vi.fn();
    const tutor = await startedTutor(fakeMentor({ solution }));
    await tutor.reveal();
    expect(solution).not.toHaveBeenCalled();
    expect(last(tutor)?.text).toBe('The solution unlocks after hint 3.');
  });

  it('records a question and its answer', async () => {
    const tutor = await startedTutor();
    await tutor.ask('  What is an offset?  ');
    expect(tutor.state.transcript.slice(-2)).toEqual([
      { from: 'learner', text: 'What is an offset?' },
      { from: 'mentor', text: 'an answer' },
    ]);
    expect(current(tutor)?.questionsAsked).toBe(1);
  });

  it('explains failing checks and does not advance', async () => {
    const tutor = await startedTutor();
    await tutor.check(FAILING, '3 open files');
    expect(last(tutor)?.text).toBe('Not passing yet: 2 errors (checked 3 open files).');
    expect(current(tutor)?.title).toBe('Read the page param');
  });

  it('runs a whole session through the independent check to a summary', async () => {
    const tutor = await startedTutor();
    await tutor.hint();
    await tutor.check(PASSING, 'all files');
    expect(last(tutor)?.text).toBe('Checkpoint 1 passes. Next: Limit the query.');

    await tutor.check(PASSING, 'all files');
    expect(tutor.state.session?.phase).toBe('independent-check');
    expect(tutor.state.transcript).toContainEqual({ from: 'mentor', text: 'a related task', label: 'Independent check' });

    await tutor.hint();
    expect(last(tutor)?.text).toBe('Help is off for the independent check. This one is yours.');

    await tutor.check(PASSING, 'all files');
    expect(tutor.state.session?.phase).toBe('complete');
    expect(last(tutor)).toMatchObject({ label: 'Session summary' });
    expect(last(tutor)?.text).toContain('Checkpoints passed: 2 of 2, 1 without help.');
    expect(last(tutor)?.text).toContain('Independent check: passed.');
  });

  it('keeps the last checkpoint open if the challenge cannot be generated', async () => {
    const mentor = fakeMentor({ challenge: vi.fn().mockRejectedValue(new Error('timeout')) });
    const tutor = await startedTutor(mentor);
    await tutor.check(PASSING, 'all files');
    await tutor.check(PASSING, 'all files');
    expect(tutor.state.session?.phase).toBe('building');
    expect(last(tutor)?.text).toBe('timeout');
  });

  it('allows a new goal after a failed plan', async () => {
    const plan = vi.fn().mockRejectedValueOnce(new Error('offline'));
    const tutor = await startedTutor(fakeMentor({ plan }));
    expect(tutor.state.session).toBeUndefined();
    plan.mockResolvedValueOnce([{ title: 'One step', description: 'Do it.' }]);
    await tutor.start('Try again');
    expect(tutor.state.session?.phase).toBe('building');
  });

  it('ignores actions while a request is in flight', async () => {
    let release: (text: string) => void = () => undefined;
    const hint = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
    const tutor = await startedTutor(fakeMentor({ hint }));
    const first = tutor.hint();
    expect(tutor.state.busy).toBe(true);
    await tutor.hint();
    release('only hint');
    await first;
    expect(hint).toHaveBeenCalledTimes(1);
  });

  it('summarizes a session ended early', async () => {
    const tutor = await startedTutor();
    tutor.end();
    expect(tutor.state.session?.phase).toBe('complete');
    expect(last(tutor)?.text).toContain('Checkpoints passed: 0 of 2');
  });

  it('notifies on every change', async () => {
    const onChange = vi.fn();
    const tutor = new Tutor(fakeMentor(), () => Promise.resolve({ files: [] }), onChange);
    await tutor.start('goal');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ busy: true }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ busy: false }));
  });
});

describe('describeEvidence', () => {
  it('reads naturally', () => {
    expect(describeEvidence({ errors: 1, tests: 'not-run', changedFiles: 2 })).toBe('1 error');
    expect(describeEvidence({ errors: 0, tests: 'failed', changedFiles: 1 })).toBe('0 errors, tests failed');
    expect(describeEvidence({ errors: 0, tests: 'passed', changedFiles: 0 })).toBe(
      'no files saved since this checkpoint started',
    );
  });
});
