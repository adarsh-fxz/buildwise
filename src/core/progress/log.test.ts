import { describe, expect, it } from 'vitest';
import { isWorthRecording, type LogEntry, MAX_ENTRIES, parseLog, recordSession, summarizeProgress } from './log';

const entry = (passed: number, unassisted: number, extra: Partial<LogEntry> = {}): LogEntry => ({
  finishedAt: '2026-10-26T10:00:00.000Z',
  goal: 'Add isEven',
  durationMinutes: 12,
  checkpointsTotal: passed,
  checkpointsPassed: passed,
  checkpointsUnassisted: unassisted,
  hintsUsed: passed - unassisted,
  questionsAsked: 0,
  solutionsRevealed: 0,
  independentCheckPassed: false,
  ...extra,
});

describe('isWorthRecording', () => {
  it('skips sessions that ended before any step passed', () => {
    expect(isWorthRecording(entry(0, 0))).toBe(false);
    expect(isWorthRecording(entry(1, 0))).toBe(true);
  });
});

describe('recordSession', () => {
  it('appends and keeps only the newest entries', () => {
    const full = Array.from({ length: MAX_ENTRIES }, (_, i) => entry(1, 0, { goal: `goal ${String(i)}` }));
    const log = recordSession(full, entry(1, 1, { goal: 'newest' }));
    expect(log).toHaveLength(MAX_ENTRIES);
    expect(log.at(-1)?.goal).toBe('newest');
    expect(log[0]?.goal).toBe('goal 1');
  });
});

describe('parseLog', () => {
  it('keeps valid entries and drops anything else', () => {
    expect(parseLog([entry(2, 1), { goal: 'old shape' }, 'junk'])).toEqual([entry(2, 1)]);
    expect(parseLog(undefined)).toEqual([]);
    expect(parseLog({ not: 'an array' })).toEqual([]);
  });
});

describe('summarizeProgress', () => {
  it('handles an empty log', () => {
    expect(summarizeProgress([])).toEqual({
      sessions: 0,
      stepsPassed: 0,
      stepsUnassisted: 0,
      unassistedPercent: 0,
      independentChecksPassed: 0,
      recent: [],
    });
  });

  it('totals steps and independent checks', () => {
    const progress = summarizeProgress([entry(3, 1, { independentCheckPassed: true }), entry(2, 2)]);
    expect(progress).toMatchObject({ sessions: 2, stepsPassed: 5, stepsUnassisted: 3, unassistedPercent: 60, independentChecksPassed: 1 });
    expect(progress.trend).toBeUndefined();
  });

  it('compares earlier and recent sessions once there are enough', () => {
    const log = [entry(4, 1), entry(4, 1), entry(4, 3), entry(4, 4)];
    expect(summarizeProgress(log).trend).toEqual({ earlierPercent: 25, recentPercent: 88 });
  });

  it('bases the trend on the last ten sessions only', () => {
    const old = Array.from({ length: 10 }, () => entry(2, 0));
    const latest = Array.from({ length: 10 }, (_, i) => entry(2, i < 5 ? 1 : 2));
    expect(summarizeProgress([...old, ...latest]).trend).toEqual({ earlierPercent: 50, recentPercent: 100 });
  });

  it('lists the five newest sessions, newest first', () => {
    const log = Array.from({ length: 7 }, (_, i) => entry(1, 0, { goal: `goal ${String(i)}` }));
    expect(summarizeProgress(log).recent.map((e) => e.goal)).toEqual(['goal 6', 'goal 5', 'goal 4', 'goal 3', 'goal 2']);
  });
});
