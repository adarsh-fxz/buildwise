import { describe, expect, it } from 'vitest';
import type { LogEntry } from './log';
import { buildPilotReport } from './report';

const entry = (finishedAt: string, extra: Partial<LogEntry> = {}): LogEntry => ({
  finishedAt,
  goal: 'Add pagination to the billing page for Acme Corp',
  durationMinutes: 15,
  checkpointsTotal: 3,
  checkpointsPassed: 3,
  checkpointsUnassisted: 1,
  hintsUsed: 4,
  questionsAsked: 1,
  solutionsRevealed: 0,
  independentCheckPassed: true,
  ...extra,
});

const meta = { pilotId: 'pilot-1', extensionVersion: '0.0.1', now: new Date('2026-11-10T18:30:00.000Z') };

describe('buildPilotReport', () => {
  it('leaves out goals and exact times', () => {
    const report = buildPilotReport([entry('2026-10-26T10:12:00.000Z')], meta);
    const text = JSON.stringify(report);
    expect(text).not.toContain('Acme');
    expect(text).not.toContain('10:12');
    expect(report.exportedOn).toBe('2026-11-10');
  });

  it('counts days since the first session', () => {
    const report = buildPilotReport(
      [entry('2026-10-26T23:00:00.000Z'), entry('2026-10-27T01:00:00.000Z'), entry('2026-10-27T09:00:00.000Z'), entry('2026-11-02T09:00:00.000Z')],
      meta,
    );
    expect(report.sessions.map((s) => s.day)).toEqual([0, 1, 1, 7]);
    expect(report.totals.activeDays).toBe(3);
    expect(report.totals.returnedAfterAWeek).toBe(true);
  });

  it('does not count a return within the first week', () => {
    const report = buildPilotReport([entry('2026-10-26T10:00:00.000Z'), entry('2026-11-01T10:00:00.000Z')], meta);
    expect(report.totals.returnedAfterAWeek).toBe(false);
  });

  it('computes completion, help and independent checks', () => {
    const report = buildPilotReport(
      [
        entry('2026-10-26T10:00:00.000Z', { checkpointsTotal: 4, checkpointsPassed: 2, checkpointsUnassisted: 0, hintsUsed: 3, independentCheckPassed: false }),
        entry('2026-10-27T10:00:00.000Z', { checkpointsTotal: 2, checkpointsPassed: 2, checkpointsUnassisted: 2, hintsUsed: 0 }),
      ],
      meta,
    );
    expect(report.totals).toEqual({
      sessions: 2,
      activeDays: 2,
      returnedAfterAWeek: false,
      stepCompletionPercent: 67,
      unassistedPercent: 50,
      hintsPerStep: 0.8,
      independentChecksPassed: 1,
    });
    expect(report.sessions[0]).toEqual({
      day: 0,
      durationMinutes: 15,
      steps: 4,
      passed: 2,
      unassisted: 0,
      hints: 3,
      questions: 1,
      reveals: 0,
      independentCheckPassed: false,
    });
  });

  it('carries the pilot id and version', () => {
    const report = buildPilotReport([entry('2026-10-26T10:00:00.000Z')], meta);
    expect(report).toMatchObject({ format: 1, pilotId: 'pilot-1', extensionVersion: '0.0.1' });
  });
});
