import { parseTscOutput, stripAnsi, tail } from './output';
import type { CheckReport } from './report';

export interface ProjectFacts {
  readonly hasTsconfig: boolean;
  /** Contents of the root package.json, if there is one. */
  readonly packageJson?: string | undefined;
  /** Lockfile names present at the root. */
  readonly lockfiles: readonly string[];
}

/** From settings: undefined means detect, an empty string means skip. */
export interface CommandOverrides {
  readonly typecheck?: string | undefined;
  readonly test?: string | undefined;
}

export interface CheckCommands {
  readonly typecheck?: string;
  readonly test?: string;
}

export interface RunResult {
  readonly command: string;
  readonly exitCode: number | null;
  readonly output: string;
  readonly timedOut: boolean;
  readonly timeoutMs: number;
}

const NPM_PLACEHOLDER_TEST = 'no test specified';
const MAX_TEST_OUTPUT_CHARS = 4000;

export function detectCommands(facts: ProjectFacts, overrides: CommandOverrides = {}): CheckCommands {
  const runner = packageRunner(facts.lockfiles);
  const typecheck = overrides.typecheck ?? (facts.hasTsconfig ? `${runner.exec} tsc --noEmit --pretty false` : '');
  const test = overrides.test ?? (hasRealTestScript(facts.packageJson) ? `${runner.name} test` : '');
  return {
    ...(typecheck.trim() !== '' && { typecheck: typecheck.trim() }),
    ...(test.trim() !== '' && { test: test.trim() }),
  };
}

/**
 * Combines tool results into a report. `editor` is the fallback for when the
 * type checker was not run or could not run.
 */
export function buildReport(
  results: { readonly typecheck?: RunResult; readonly test?: RunResult },
  editor: CheckReport,
): CheckReport {
  const notes: string[] = [];
  const scope: string[] = [];
  let typecheck: Pick<CheckReport, 'problems'> | undefined;

  if (results.typecheck) {
    const { command, exitCode, output, timedOut, timeoutMs } = results.typecheck;
    const problems = parseTscOutput(output);
    if (timedOut) {
      notes.push(`The type check (${command}) did not finish within ${describeDuration(timeoutMs)}, so editor errors were used.`);
    } else if (exitCode === 0 || problems.length > 0) {
      typecheck = { problems };
      scope.push(command.includes('tsc') ? 'tsc' : command);
    } else {
      notes.push(`The type check (${command}) could not run: ${firstLine(output)}. Editor errors were used instead.`);
    }
  }

  let tests: CheckReport['evidence']['tests'] = 'not-run';
  let testOutput: string | undefined;
  if (results.test) {
    const { command, exitCode, output, timedOut, timeoutMs } = results.test;
    if (timedOut) {
      notes.push(
        `The tests (${command}) did not finish within ${describeDuration(timeoutMs)}. If your test script watches for changes, set buildwise.checks.testCommand to one that runs once.`,
      );
    } else {
      tests = exitCode === 0 ? 'passed' : 'failed';
      scope.push(command);
      if (tests === 'failed') testOutput = tail(stripAnsi(output).trim(), MAX_TEST_OUTPUT_CHARS);
    }
  }

  const problems = typecheck ? typecheck.problems : editor.problems;
  if (!typecheck) scope.push(editor.scope);
  return {
    evidence: { errors: problems.length, tests, changedFiles: editor.evidence.changedFiles },
    scope: scope.join(' and '),
    problems,
    ...(testOutput !== undefined && { testOutput }),
    notes,
  };
}

function packageRunner(lockfiles: readonly string[]): { name: string; exec: string } {
  if (lockfiles.includes('pnpm-lock.yaml')) return { name: 'pnpm', exec: 'pnpm exec' };
  if (lockfiles.includes('yarn.lock')) return { name: 'yarn', exec: 'yarn' };
  // --no stops npx from downloading a package that isn't installed.
  return { name: 'npm', exec: 'npx --no --' };
}

function hasRealTestScript(packageJson: string | undefined): boolean {
  if (!packageJson) return false;
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, unknown> };
    const test = parsed.scripts?.test;
    return typeof test === 'string' && test.trim() !== '' && !test.includes(NPM_PLACEHOLDER_TEST);
  } catch {
    return false;
  }
}

function firstLine(output: string): string {
  return stripAnsi(output).split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? 'no output';
}

function describeDuration(ms: number): string {
  return ms % 60_000 === 0 ? `${String(ms / 60_000)} min` : `${String(Math.round(ms / 1000))} s`;
}
