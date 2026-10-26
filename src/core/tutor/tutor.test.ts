import { describe, expect, it, vi } from 'vitest';
import type { CheckReport } from '../checks/report';
import type { Mentor } from '../mentor/mentor';
import { activeCheckpoint, type ToolEvidence } from '../session/session';
import { describeEvidence, describeFailure, Tutor } from './tutor';

const PASSING: ToolEvidence = { errors: 0, tests: 'not-run', changedFiles: 1 };
const FAILING: ToolEvidence = { errors: 2, tests: 'not-run', changedFiles: 1 };

const report = (evidence: ToolEvidence, extra: Partial<CheckReport> = {}): CheckReport => ({
  evidence,
  scope: 'tsc',
  problems: [],
  files: [{ path: 'src/lib/utils.ts', content: 'export const isEven = (n: number) => n % 2 === 0;' }],
  notes: [],
  ...extra,
});
const collect = (evidence: ToolEvidence, extra: Partial<CheckReport> = {}) => () =>
  Promise.resolve(report(evidence, extra));

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
    explain: vi.fn().mockResolvedValue('what the error means'),
    review: vi.fn().mockResolvedValue({ passes: true, feedback: 'It works.' }),
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
    expect(tutor.state.transcript[0]).toEqual({ from: 'learner', kind: 'goal', text: 'Add pagination', label: 'Goal' });
    expect(tutor.state.transcript[1]).toMatchObject({ from: 'mentor', kind: 'plan', label: 'Plan' });
    expect(tutor.state.transcript[1]?.text).toContain('1. Read the page param: From the URL.');
  });

  it('gives escalating hints and passes the earlier ones along', async () => {
    const hint = vi.fn((_session, level: number) => Promise.resolve(`hint ${String(level)}`));
    const tutor = await startedTutor(fakeMentor({ hint }));
    await tutor.hint();
    await tutor.hint();
    expect(last(tutor)).toEqual({ from: 'mentor', kind: 'hint', text: 'hint 2', label: 'Hint 2 of 3' });
    expect(hint).toHaveBeenLastCalledWith(expect.anything(), 2, ['hint 1'], expect.anything());
  });

  it('does not use up a hint when the mentor fails', async () => {
    const mentor = fakeMentor({ hint: vi.fn().mockRejectedValue(new Error('network down')) });
    const tutor = await startedTutor(mentor);
    await tutor.hint();
    expect(current(tutor)?.hintsUsed).toBe(0);
    expect(last(tutor)).toEqual({ from: 'buildwise', kind: 'notice', text: 'network down', tone: 'error' });
    expect(tutor.state.activity).toBeUndefined();
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
      { from: 'learner', kind: 'question', text: 'What is an offset?' },
      { from: 'mentor', kind: 'answer', text: 'an answer' },
    ]);
    expect(current(tutor)?.questionsAsked).toBe(1);
  });

  it('explains failing checks and does not advance', async () => {
    const tutor = await startedTutor();
    await tutor.check(collect(FAILING));
    expect(last(tutor)).toEqual({
      from: 'buildwise',
      kind: 'check',
      text: 'Not passing yet: 2 errors, checked with tsc.',
      label: 'Check',
      tone: 'error',
      problems: [],
    });
    expect(current(tutor)?.title).toBe('Read the page param');
  });

  it('runs a whole session through the independent check to a summary', async () => {
    const tutor = await startedTutor();
    await tutor.hint();
    await tutor.check(collect(PASSING));
    expect(last(tutor)).toMatchObject({ text: 'Checkpoint 1 passes, checked with tsc and a code review. It works. Next: Limit the query.', tone: 'success' });

    await tutor.check(collect(PASSING));
    expect(tutor.state.session?.phase).toBe('independent-check');
    expect(tutor.state.transcript).toContainEqual({
      from: 'mentor',
      kind: 'challenge',
      text: 'a related task',
      label: 'Independent check',
    });

    await tutor.hint();
    expect(last(tutor)?.text).toBe('Help is off for the independent check. This one is yours.');

    await tutor.check(collect(PASSING));
    expect(tutor.state.session?.phase).toBe('complete');
    expect(last(tutor)).toMatchObject({ kind: 'summary', label: 'Session summary' });
    expect(last(tutor)?.summary).toMatchObject({ checkpointsPassed: 2, checkpointsUnassisted: 1, independentCheckPassed: true });
    expect(last(tutor)?.text).toContain('Checkpoints passed: 2 of 2, 1 without help.');
    expect(last(tutor)?.text).toContain('Independent check: passed.');
  });

  it('keeps the last checkpoint open if the challenge cannot be generated', async () => {
    const mentor = fakeMentor({ challenge: vi.fn().mockRejectedValue(new Error('timeout')) });
    const tutor = await startedTutor(mentor);
    await tutor.check(collect(PASSING));
    await tutor.check(collect(PASSING));
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
    expect(tutor.state.activity).toBe('thinking');
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
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ activity: 'thinking' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ activity: undefined }));
  });
});

describe('checks', () => {
  it('shows a checking activity while the tools run', async () => {
    const tutor = await startedTutor();
    let finish: (value: CheckReport) => void = () => undefined;
    const running = tutor.check(() => new Promise((resolve) => (finish = resolve)));
    expect(tutor.state.activity).toBe('checking');
    finish(report(PASSING));
    await running;
    expect(tutor.state.activity).toBeUndefined();
  });

  it('does not run the tools before a plan exists', async () => {
    const tutor = new Tutor(fakeMentor(), () => Promise.resolve({ files: [] }));
    const run = vi.fn(() => Promise.resolve(report(PASSING)));
    await tutor.check(run);
    expect(run).not.toHaveBeenCalled();
  });

  it('reports a tool that crashed instead of hanging', async () => {
    const tutor = await startedTutor();
    await tutor.check(() => Promise.reject(new Error('spawn npx ENOENT')));
    expect(last(tutor)?.text).toBe('spawn npx ENOENT');
    expect(tutor.state.activity).toBeUndefined();
  });

  it('explains the last failure as a counted question', async () => {
    const explain = vi.fn().mockResolvedValue('TS2345 means the types do not match.');
    const tutor = await startedTutor(fakeMentor({ explain }));
    expect(tutor.state.canExplain).toBe(false);

    const failure = report(FAILING, { problems: [{ file: 'src/a.ts', line: 3, code: 'TS2345', message: 'Bad argument.' }] });
    await tutor.check(() => Promise.resolve(failure));
    expect(tutor.state.canExplain).toBe(true);
    expect(last(tutor)?.problems).toEqual(failure.problems);

    await tutor.explain();
    expect(explain).toHaveBeenCalledWith(expect.anything(), failure, expect.anything());
    expect(last(tutor)).toEqual({
      from: 'mentor',
      kind: 'explanation',
      text: 'TS2345 means the types do not match.',
      label: 'About these errors',
    });
    expect(current(tutor)?.questionsAsked).toBe(1);

    await tutor.check(collect(PASSING));
    expect(tutor.state.canExplain).toBe(false);
  });

  it('adds notes about tools that could not run', async () => {
    const tutor = await startedTutor();
    await tutor.check(collect(PASSING, { scope: 'editor errors', notes: ['The type check could not run.'] }));
    expect(last(tutor)?.text).toBe(
      'Checkpoint 1 passes, checked with editor errors and a code review. It works. Next: Limit the query. The type check could not run.',
    );
  });
});

describe('review', () => {
  it('refuses code that compiles but does not do the step, and says what is missing', async () => {
    const review = vi.fn().mockResolvedValue({ passes: false, feedback: 'isEven never returns anything.' });
    const tutor = await startedTutor(fakeMentor({ review }));
    await tutor.check(collect(PASSING));
    expect(current(tutor)?.title).toBe('Read the page param');
    expect(review).toHaveBeenCalledWith(
      expect.anything(),
      'Read the page param: From the URL.',
      [{ path: 'src/lib/utils.ts', content: 'export const isEven = (n: number) => n % 2 === 0;' }],
      expect.anything(),
    );
    const entry = tutor.state.transcript.find((e) => e.kind === 'check');
    expect(entry?.text).toBe(
      'Not passing yet: the code does not do what this step asks yet, checked with tsc and a code review.\nisEven never returns anything.',
    );
    expect(tutor.state.canExplain).toBe(false);
  });

  it('skips the review when the tools already fail', async () => {
    const review = vi.fn();
    const tutor = await startedTutor(fakeMentor({ review }));
    await tutor.check(collect(FAILING));
    expect(review).not.toHaveBeenCalled();
  });

  it('shows that it is reviewing', async () => {
    let finish: (value: { passes: boolean; feedback: string }) => void = () => undefined;
    const review = vi.fn(() => new Promise<{ passes: boolean; feedback: string }>((resolve) => (finish = resolve)));
    const tutor = await startedTutor(fakeMentor({ review }));
    const running = tutor.check(collect(PASSING));
    await vi.waitFor(() => {
      expect(tutor.state.activity).toBe('reviewing');
    });
    finish({ passes: true, feedback: 'Good.' });
    await running;
  });

  it('reviews the independent check against its task', async () => {
    const review = vi.fn().mockResolvedValue({ passes: true, feedback: 'Done.' });
    const tutor = await startedTutor(fakeMentor({ review, challenge: vi.fn().mockResolvedValue('Add isOdd.') }));
    await tutor.check(collect(PASSING));
    await tutor.check(collect(PASSING));
    await tutor.check(collect(PASSING));
    expect(review).toHaveBeenLastCalledWith(expect.anything(), 'Add isOdd.', expect.anything(), expect.anything());
    expect(tutor.state.session?.phase).toBe('complete');
  });

  it('does not pass a step when the review cannot run', async () => {
    const tutor = await startedTutor(fakeMentor({ review: vi.fn().mockRejectedValue(new Error('offline')) }));
    await tutor.check(collect(PASSING));
    expect(current(tutor)?.title).toBe('Read the page param');
    expect(last(tutor)).toMatchObject({ text: 'offline', tone: 'error' });
  });
});

describe('describeFailure', () => {
  it('gives the headline and notes, leaving the errors to the problems list', () => {
    const problems = [{ file: 'src/a.ts', line: 1, code: 'TS2304', message: 'Missing.' }];
    const failed = report({ errors: 1, tests: 'failed', changedFiles: 1 }, { problems, scope: 'tsc and npm test', notes: ['Tests ran once.'] });
    const text = describeFailure(failed, { ...failed.evidence, review: 'not-run' });
    expect(text.split('\n')).toEqual(['Not passing yet: 1 error, tests failed, checked with tsc and npm test.', 'Tests ran once.']);
  });
});

describe('describeEvidence', () => {
  it('reads naturally', () => {
    expect(describeEvidence({ errors: 1, tests: 'not-run', changedFiles: 2 })).toBe('1 error');
    expect(describeEvidence({ errors: 0, tests: 'failed', changedFiles: 1 })).toBe('0 errors, tests failed');
    expect(describeEvidence({ errors: 0, tests: 'passed', changedFiles: 0 })).toBe('no files saved in this session yet');
    expect(describeEvidence({ errors: 0, tests: 'passed', changedFiles: 1, review: 'failed' })).toBe(
      'the code does not do what this step asks yet',
    );
  });
});
