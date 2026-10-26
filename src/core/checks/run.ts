import { type ChildProcess, spawn } from 'node:child_process';
import type { RunResult } from './commands';

/** Enough for any summary a test runner prints; earlier output is dropped. */
const MAX_OUTPUT_CHARS = 200_000;

/**
 * Runs a shell command the learner approved and collects its output. Never
 * rejects: a command that cannot start resolves with its error as output.
 */
export function runCommand(command: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      // Its own process group, so a timeout can stop everything it started.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      // CI makes test runners run once instead of watching.
      env: { ...process.env, CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0' },
    });

    let output = '';
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-MAX_OUTPUT_CHARS);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ command, exitCode: null, output: error.message, timedOut, timeoutMs });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ command, exitCode, output, timedOut, timeoutMs });
    });
  });
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f']);
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already exited.
  }
}
