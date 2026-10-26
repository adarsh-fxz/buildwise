import { describe, expect, it } from 'vitest';
import { formatProblem, parseTscOutput, stripAnsi, tail } from './output';

describe('parseTscOutput', () => {
  it('reads located errors', () => {
    const output = [
      "src/app/page.tsx(22,15): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
      "src\\lib\\posts.ts(3,1): error TS2304: Cannot find name 'prisma'.",
    ].join('\n');
    expect(parseTscOutput(output)).toEqual([
      {
        file: 'src/app/page.tsx',
        line: 22,
        column: 15,
        code: 'TS2345',
        message: "Argument of type 'string' is not assignable to parameter of type 'number'.",
      },
      { file: 'src/lib/posts.ts', line: 3, column: 1, code: 'TS2304', message: "Cannot find name 'prisma'." },
    ]);
  });

  it('reads errors without a location', () => {
    expect(parseTscOutput("error TS5058: The specified path does not exist: 'tsconfig.json'.")).toEqual([
      { code: 'TS5058', message: "The specified path does not exist: 'tsconfig.json'." },
    ]);
  });

  it('joins indented continuation lines onto the message', () => {
    const output = [
      "src/a.ts(1,7): error TS2322: Type '{ id: string; }' is not assignable to type 'Post'.",
      "  Property 'title' is missing in type '{ id: string; }' but required in type 'Post'.",
    ].join('\r\n');
    expect(parseTscOutput(output)[0]?.message).toBe(
      "Type '{ id: string; }' is not assignable to type 'Post'. Property 'title' is missing in type '{ id: string; }' but required in type 'Post'.",
    );
  });

  it('reads the default pretty format and skips code frames and related locations', () => {
    const pretty = [
      "\u001b[96msrc/a.ts\u001b[0m:\u001b[93m2\u001b[0m:\u001b[93m7\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2451: \u001b[0mCannot redeclare block-scoped variable 'p'.",
      '',
      "\u001b[7m2\u001b[0m const p: Post = { id: 'a' };",
      '        ~',
      '',
      '  src/b.ts:2:7',
      "    2 const p: Post = { id: 'a', title: 't' };",
      '            ~',
      "    'p' was also declared here.",
      '',
      "src/b.ts:2:50 - error TS2322: Type 'number' is not assignable to type 'string'.",
      '',
      'Found 2 errors in 2 files.',
    ].join('\n');
    expect(parseTscOutput(pretty)).toEqual([
      { file: 'src/a.ts', line: 2, column: 7, code: 'TS2451', message: "Cannot redeclare block-scoped variable 'p'." },
      { file: 'src/b.ts', line: 2, column: 50, code: 'TS2322', message: "Type 'number' is not assignable to type 'string'." },
    ]);
  });

  it('ignores everything else, including colour codes', () => {
    const output = '\u001b[96msrc/a.ts\u001b[0m(1,1): error TS1005: \';\' expected.\nFound 1 error in src/a.ts:1\n';
    expect(parseTscOutput(output)).toHaveLength(1);
    expect(parseTscOutput('npm error could not determine executable to run')).toEqual([]);
  });
});

describe('formatProblem', () => {
  it('shows the location when there is one', () => {
    expect(formatProblem({ file: 'src/a.ts', line: 4, code: 'TS2304', message: 'Cannot find name.' })).toBe(
      'src/a.ts:4 TS2304: Cannot find name.',
    );
    expect(formatProblem({ code: 'TS5058', message: 'No tsconfig.' })).toBe('TS5058: No tsconfig.');
  });
});

describe('tail', () => {
  it('keeps the end of long text', () => {
    expect(tail('abcdef', 10)).toBe('abcdef');
    expect(tail('abcdef', 3)).toBe('…def');
  });
});

describe('stripAnsi', () => {
  it('removes colour and cursor codes', () => {
    expect(stripAnsi('\u001b[31m✗ failed\u001b[39m\u001b[2K')).toBe('✗ failed');
  });
});
