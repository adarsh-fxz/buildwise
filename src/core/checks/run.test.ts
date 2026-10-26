import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runCommand } from './run';

const cwd = tmpdir();
const node = (script: string) => `"${process.execPath}" -e "${script}"`;

describe('runCommand', () => {
  it('collects stdout and stderr with the exit code', async () => {
    const result = await runCommand(node("console.log('out'); console.error('err'); process.exit(3)"), cwd, 10_000);
    expect(result).toMatchObject({ exitCode: 3, timedOut: false });
    expect(result.output).toContain('out');
    expect(result.output).toContain('err');
  });

  it('tells test runners they are in CI', async () => {
    const result = await runCommand(node('console.log(process.env.CI)'), cwd, 10_000);
    expect(result.output.trim()).toBe('true');
  });

  it('kills a command and its children when it runs too long', async () => {
    const started = Date.now();
    // A shell whose child sleeps: killing only the shell would leave it running.
    const result = await runCommand(`${node('setTimeout(() => {}, 60000)')} && echo never`, cwd, 300);
    expect(result.timedOut).toBe(true);
    expect(result.output).not.toContain('never');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('resolves for a command that does not exist', async () => {
    const result = await runCommand('definitely-not-a-real-command-buildwise', cwd, 10_000);
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
  });
});
