import type { LogEntry } from './log';

/**
 * What a pilot user sends back, made from the learning log. Counts only: no
 * goals, code, file names or model output, and session times are reduced to
 * days since the first session.
 */
export interface PilotReport {
  readonly format: 1;
  /** Random, made once on the learner's machine, so reports from one person can be linked without knowing who. */
  readonly pilotId: string;
  readonly extensionVersion: string;
  /** Calendar date only, as YYYY-MM-DD. */
  readonly exportedOn: string;
  readonly totals: PilotTotals;
  readonly sessions: readonly PilotSession[];
}

export interface PilotTotals {
  readonly sessions: number;
  readonly activeDays: number;
  /** Whether any session finished seven or more days after the first. */
  readonly returnedAfterAWeek: boolean;
  /** Steps passed out of all steps planned. Sessions that passed no step are never logged. */
  readonly stepCompletionPercent: number;
  readonly unassistedPercent: number;
  /** Hints used per step passed, to one decimal place. */
  readonly hintsPerStep: number;
  readonly independentChecksPassed: number;
}

export interface PilotSession {
  /** Days between this session and the first one, by UTC date. */
  readonly day: number;
  readonly durationMinutes: number;
  readonly steps: number;
  readonly passed: number;
  readonly unassisted: number;
  readonly hints: number;
  readonly questions: number;
  readonly reveals: number;
  readonly independentCheckPassed: boolean;
}

const DAY_MS = 86_400_000;

export function buildPilotReport(
  log: readonly LogEntry[],
  meta: { readonly pilotId: string; readonly extensionVersion: string; readonly now: Date },
): PilotReport {
  const days = log.map((entry) => utcDay(entry.finishedAt));
  const first = Math.min(...days);
  const sessions = log.map(
    (entry, i): PilotSession => ({
      day: (days[i] ?? first) - first,
      durationMinutes: entry.durationMinutes,
      steps: entry.checkpointsTotal,
      passed: entry.checkpointsPassed,
      unassisted: entry.checkpointsUnassisted,
      hints: entry.hintsUsed,
      questions: entry.questionsAsked,
      reveals: entry.solutionsRevealed,
      independentCheckPassed: entry.independentCheckPassed,
    }),
  );

  const steps = sum(sessions, (s) => s.steps);
  const passed = sum(sessions, (s) => s.passed);
  return {
    format: 1,
    pilotId: meta.pilotId,
    extensionVersion: meta.extensionVersion,
    exportedOn: meta.now.toISOString().slice(0, 10),
    totals: {
      sessions: sessions.length,
      activeDays: new Set(days).size,
      returnedAfterAWeek: sessions.some((s) => s.day >= 7),
      stepCompletionPercent: percent(passed, steps),
      unassistedPercent: percent(sum(sessions, (s) => s.unassisted), passed),
      hintsPerStep: passed === 0 ? 0 : Math.round((sum(sessions, (s) => s.hints) / passed) * 10) / 10,
      independentChecksPassed: sessions.filter((s) => s.independentCheckPassed).length,
    },
    sessions,
  };
}

function utcDay(iso: string): number {
  return Math.floor(Date.parse(iso) / DAY_MS);
}

function percent(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

function sum(sessions: readonly PilotSession[], value: (session: PilotSession) => number): number {
  return sessions.reduce((total, session) => total + value(session), 0);
}
