import { describe, expect, it } from 'vitest';
import { buildReport, detectCommands, type RunResult } from './commands';
import type { CheckReport } from './report';

const withTests = JSON.stringify({ scripts: { test: 'vitest run' } });
const npmPlaceholder = JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } });

describe('detectCommands', () => {
  it('type-checks TypeScript projects and runs a real test script with npm', () => {
    expect(detectCommands({ hasTsconfig: true, packageJson: withTests, lockfiles: ['package-lock.json'] })).toEqual({
      typecheck: 'npx --no -- tsc --noEmit --pretty false',
      test: 'npm test',
    });
  });

  it('uses the package manager the lockfile points to', () => {
    expect(detectCommands({ hasTsconfig: true, packageJson: withTests, lockfiles: ['pnpm-lock.yaml'] })).toEqual({
      typecheck: 'pnpm exec tsc --noEmit --pretty false',
      test: 'pnpm test',
    });
    expect(detectCommands({ hasTsconfig: false, packageJson: withTests, lockfiles: ['yarn.lock'] })).toEqual({
      test: 'yarn test',
    });
  });

  it.each([
    ['no package.json', undefined],
    ["npm's placeholder test script", npmPlaceholder],
    ['invalid JSON', '{ nope'],
    ['no test script', JSON.stringify({ scripts: { build: 'tsc' } })],
  ])('skips tests with %s', (_, packageJson) => {
    expect(detectCommands({ hasTsconfig: false, packageJson, lockfiles: [] })).toEqual({});
  });

  it('lets settings replace or turn off each command', () => {
    const facts = { hasTsconfig: true, packageJson: withTests, lockfiles: [] };
    expect(detectCommands(facts, { typecheck: '', test: 'npm run test:unit' })).toEqual({ test: 'npm run test:unit' });
    expect(detectCommands(facts, { typecheck: 'npm run typecheck', test: '  ' })).toEqual({ typecheck: 'npm run typecheck' });
  });
});

describe('buildReport', () => {
  const editor: CheckReport = {
    evidence: { errors: 1, tests: 'not-run', changedFiles: 2 },
    scope: "the editor's error list (1 file)",
    problems: [{ file: 'src/open.ts', line: 1, code: 'TS2304', message: 'From the editor.' }],
    notes: [],
  };
  const run = (command: string, exitCode: number | null, output = '', timedOut = false): RunResult => ({
    command,
    exitCode,
    output,
    timedOut,
    timeoutMs: 120_000,
  });
  const tscError = "src/a.ts(3,1): error TS2304: Cannot find name 'x'.";

  it('uses the type checker over the editor and passes clean runs', () => {
    const report = buildReport({ typecheck: run('npx --no -- tsc --noEmit', 0), test: run('npm test', 0) }, editor);
    expect(report).toEqual({
      evidence: { errors: 0, tests: 'passed', changedFiles: 2 },
      scope: 'tsc and npm test',
      problems: [],
      notes: [],
    });
  });

  it('counts compiler errors and keeps the end of failing test output', () => {
    const report = buildReport(
      { typecheck: run('npx --no -- tsc --noEmit', 2, tscError), test: run('npm test', 1, '\u001b[31mFAIL\u001b[0m a.test.ts') },
      editor,
    );
    expect(report.evidence).toEqual({ errors: 1, tests: 'failed', changedFiles: 2 });
    expect(report.problems[0]?.file).toBe('src/a.ts');
    expect(report.testOutput).toBe('FAIL a.test.ts');
  });

  it('falls back to editor errors when the type checker could not run', () => {
    const report = buildReport(
      { typecheck: run('npx --no -- tsc --noEmit', 1, 'npm error could not determine executable to run\nmore') },
      editor,
    );
    expect(report.evidence.errors).toBe(1);
    expect(report.problems).toEqual(editor.problems);
    expect(report.scope).toBe("the editor's error list (1 file)");
    expect(report.notes).toEqual([
      'The type check (npx --no -- tsc --noEmit) could not run: npm error could not determine executable to run. Editor errors were used instead.',
    ]);
  });

  it('does not count timed-out tests as passing', () => {
    const report = buildReport({ test: { ...run('npm test', null, '', true), timeoutMs: 300_000 } }, editor);
    expect(report.evidence.tests).toBe('not-run');
    expect(report.notes[0]).toContain('did not finish within 5 min');
    expect(report.notes[0]).toContain('buildwise.checks.testCommand');
  });

  it('uses only the editor when nothing ran', () => {
    expect(buildReport({}, editor)).toEqual({ ...editor, notes: [] });
  });
});
