import { z } from 'zod';
import type { SessionSummary } from '../session/session';

/** One finished session, kept on the learner's machine. */
export interface LogEntry extends SessionSummary {
  /** When the session finished, as an ISO timestamp. */
  readonly finishedAt: string;
  readonly goal: string;
  readonly durationMinutes: number;
}

export interface Progress {
  readonly sessions: number;
  readonly stepsPassed: number;
  readonly stepsUnassisted: number;
  /** Share of passed steps done without hints, questions or a reveal. */
  readonly unassistedPercent: number;
  readonly independentChecksPassed: number;
  /** The unassisted share in earlier against recent sessions, once there are enough to compare. */
  readonly trend?: { readonly earlierPercent: number; readonly recentPercent: number };
  /** Newest first. */
  readonly recent: readonly LogEntry[];
}

export const MAX_ENTRIES = 200;
const RECENT_SHOWN = 5;
const TREND_WINDOW = 10;
const TREND_MIN_SESSIONS = 4;

const LogEntrySchema = z.object({
  finishedAt: z.string(),
  goal: z.string(),
  durationMinutes: z.number(),
  checkpointsTotal: z.number(),
  checkpointsPassed: z.number(),
  checkpointsUnassisted: z.number(),
  hintsUsed: z.number(),
  questionsAsked: z.number(),
  solutionsRevealed: z.number(),
  independentCheckPassed: z.boolean(),
});

/** Sessions that ended before any step passed say nothing about progress. */
export function isWorthRecording(summary: SessionSummary): boolean {
  return summary.checkpointsPassed > 0;
}

export function recordSession(log: readonly LogEntry[], entry: LogEntry): LogEntry[] {
  return [...log, entry].slice(-MAX_ENTRIES);
}

/** Reads a stored log, dropping entries that don't match the current shape. */
export function parseLog(stored: unknown): LogEntry[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((item) => {
    const result = LogEntrySchema.safeParse(item);
    return result.success ? [result.data] : [];
  });
}

export function summarizeProgress(log: readonly LogEntry[]): Progress {
  const stepsPassed = sum(log, (entry) => entry.checkpointsPassed);
  const stepsUnassisted = sum(log, (entry) => entry.checkpointsUnassisted);

  const window = log.slice(-TREND_WINDOW);
  const half = Math.floor(window.length / 2);
  const trend =
    window.length >= TREND_MIN_SESSIONS
      ? { earlierPercent: unassistedPercent(window.slice(0, half)), recentPercent: unassistedPercent(window.slice(half)) }
      : undefined;

  return {
    sessions: log.length,
    stepsPassed,
    stepsUnassisted,
    unassistedPercent: unassistedPercent(log),
    independentChecksPassed: log.filter((entry) => entry.independentCheckPassed).length,
    ...(trend && { trend }),
    recent: log.slice(-RECENT_SHOWN).reverse(),
  };
}

function unassistedPercent(entries: readonly LogEntry[]): number {
  const passed = sum(entries, (entry) => entry.checkpointsPassed);
  return passed === 0 ? 0 : Math.round((sum(entries, (entry) => entry.checkpointsUnassisted) / passed) * 100);
}

function sum(entries: readonly LogEntry[], value: (entry: LogEntry) => number): number {
  return entries.reduce((total, entry) => total + value(entry), 0);
}
