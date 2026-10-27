import { describeError } from './errors';
import type { Mentor } from './mentor';

/**
 * Logs each mentor request and how long it took, so a slow model can be told
 * apart from a stuck one. Never logs prompts, code or keys.
 */
export function instrument(mentor: Mentor, log: (line: string) => void, now: () => number = Date.now): Mentor {
  const timed = async <T>(name: string, request: () => Promise<T>): Promise<T> => {
    const started = now();
    log(`${name}: waiting for the model`);
    try {
      const result = await request();
      log(`${name}: answered in ${seconds(now() - started)}`);
      return result;
    } catch (error) {
      log(`${name}: failed after ${seconds(now() - started)}: ${describeError(error)}`);
      throw error;
    }
  };

  return {
    plan: (goal, context) => timed('plan', () => mentor.plan(goal, context)),
    hint: (session, level, previousHints, context, failure) =>
      timed(`hint ${String(level)}`, () => mentor.hint(session, level, previousHints, context, failure)),
    solution: (session, context) => timed('solution', () => mentor.solution(session, context)),
    answer: (session, question, context) => timed('answer', () => mentor.answer(session, question, context)),
    challenge: (session, context) => timed('independent check', () => mentor.challenge(session, context)),
    explain: (session, report, context) => timed('explain', () => mentor.explain(session, report, context)),
    review: (session, task, files, context) => timed('review', () => mentor.review(session, task, files, context)),
  };
}

/** A mentor that forwards to whichever one `current` returns, so the model can change mid-session. */
export function switchable(current: () => Mentor): Mentor {
  return {
    plan: (...args) => current().plan(...args),
    hint: (...args) => current().hint(...args),
    solution: (...args) => current().solution(...args),
    answer: (...args) => current().answer(...args),
    challenge: (...args) => current().challenge(...args),
    explain: (...args) => current().explain(...args),
    review: (...args) => current().review(...args),
  };
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
