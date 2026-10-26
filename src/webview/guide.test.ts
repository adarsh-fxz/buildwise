import { describe, expect, it } from 'vitest';
import { parseFileRef } from './fileRef';
import { nextStep } from './guide';
import type { ViewState } from './protocol';

const base: ViewState = {
  phase: 'building',
  checkpoints: [],
  hintsUsed: 0,
  hintLevels: 3,
  revealUnlocked: false,
  canExplain: false,
  activity: undefined,
  transcript: [],
  model: 'm',
  needsFolder: false,
  progress: undefined,
};

describe('nextStep', () => {
  it('tells a beginner how to start a step', () => {
    expect(nextStep(base, 'Ctrl+S')).toBe(
      'Write the code for this step in your editor. Save with Ctrl+S, then check your work. Stuck? Ask for a hint.',
    );
  });

  it('points at the first error after a failed check', () => {
    const failed: ViewState = {
      ...base,
      canExplain: true,
      transcript: [
        {
          from: 'buildwise',
          kind: 'check',
          text: 'Not passing yet',
          tone: 'error',
          problems: [{ file: 'a.ts', line: 1, code: 'TS1', message: 'x' }],
        },
      ],
    };
    expect(nextStep(failed, 'Ctrl+S')).toContain('Fix the first error');
    expect(nextStep(failed, 'Ctrl+S')).toContain('Explain the errors');
  });

  it('points at the review feedback when the code compiles but falls short', () => {
    const reviewed: ViewState = {
      ...base,
      hintsUsed: 3,
      revealUnlocked: true,
      transcript: [{ from: 'buildwise', kind: 'check', text: 'Not passing yet', tone: 'error', problems: [] }],
    };
    expect(nextStep(reviewed, 'Ctrl+S')).toBe(
      'Read what is still missing above, change your code, save, and check again. You have used every hint, so you can also reveal the solution.',
    );
  });

  it('mentions the reveal once every hint is used', () => {
    expect(nextStep({ ...base, hintsUsed: 3, revealUnlocked: true }, 'Ctrl+S')).toContain('reveal the solution');
  });

  it('follows up on a hint', () => {
    expect(nextStep({ ...base, hintsUsed: 1 }, '⌘S')).toBe('Try the hint in your code. Save with ⌘S, then check your work.');
  });

  it('says help is off for the independent check', () => {
    expect(nextStep({ ...base, phase: 'independent-check' }, 'Ctrl+S')).toContain('hints and questions are off');
  });

  it('stays quiet while busy or before a session', () => {
    expect(nextStep({ ...base, activity: 'thinking' }, 'Ctrl+S')).toBeUndefined();
    expect(nextStep({ ...base, phase: 'idle' }, 'Ctrl+S')).toBeUndefined();
  });
});

describe('parseFileRef', () => {
  it('reads paths with optional line and column', () => {
    expect(parseFileRef('src/lib/posts.ts')).toEqual({ file: 'src/lib/posts.ts' });
    expect(parseFileRef('src/app/page.tsx:22')).toEqual({ file: 'src/app/page.tsx', line: 22 });
    expect(parseFileRef(' package.json:3:5 ')).toEqual({ file: 'package.json', line: 3, column: 5 });
  });

  it.each(['/etc/passwd.json', '../secrets.ts', 'src/../../x.ts', 'getPosts()', 'posts', 'src//a.ts', 'C:/x.ts'])(
    'rejects %j',
    (text) => {
      expect(parseFileRef(text)).toBeUndefined();
    },
  );
});
