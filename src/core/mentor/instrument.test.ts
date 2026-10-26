import { describe, expect, it, vi } from 'vitest';
import { createSession } from '../session/session';
import { MentorError } from './errors';
import { instrument, seconds } from './instrument';
import type { Mentor } from './mentor';

const context = { files: [], openFile: { path: 'src/secret-sauce.ts', content: 'const apiKey = "sk-live";' } };

function clock(...times: number[]) {
  return vi.fn(() => times.shift() ?? 0);
}

describe('instrument', () => {
  it('logs how long a request took and passes the result through', async () => {
    const mentor = { plan: vi.fn().mockResolvedValue([{ title: 't', description: 'd' }]) } as unknown as Mentor;
    const log = vi.fn();
    const plan = await instrument(mentor, log, clock(1000, 7400)).plan('Add pagination', context);
    expect(plan).toHaveLength(1);
    expect(log.mock.calls.map(([line]) => line as string)).toEqual(['plan: waiting for the model', 'plan: answered in 6.4s']);
  });

  it('logs failures with a readable reason and rethrows', async () => {
    const mentor = { hint: vi.fn().mockRejectedValue(new MentorError('empty')) } as unknown as Mentor;
    const log = vi.fn();
    await expect(instrument(mentor, log, clock(0, 60_000)).hint(createSession('g'), 2, [], context)).rejects.toThrow(
      MentorError,
    );
    expect(log).toHaveBeenLastCalledWith('hint 2: failed after 60.0s: The model returned nothing usable. Try again.');
  });

  it('never logs the goal or code', async () => {
    const mentor = { plan: vi.fn().mockResolvedValue([]) } as unknown as Mentor;
    const log = vi.fn();
    await instrument(mentor, log).plan('Add pagination', context);
    const logged = log.mock.calls.flat().join('\n');
    expect(logged).not.toContain('pagination');
    expect(logged).not.toContain('sk-live');
  });
});

describe('seconds', () => {
  it('shows one decimal place', () => {
    expect(seconds(12_345)).toBe('12.3s');
  });
});
