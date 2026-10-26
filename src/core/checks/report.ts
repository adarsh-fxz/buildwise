import type { CheckEvidence } from '../session/session';
import type { Problem } from './output';

/** Everything one run of "Check my work" found. */
export interface CheckReport {
  readonly evidence: CheckEvidence;
  /** What was checked, such as "tsc and npm test". */
  readonly scope: string;
  readonly problems: readonly Problem[];
  /** The end of the test runner's output, when tests failed. */
  readonly testOutput?: string;
  /** Anything that could not run, in plain words. */
  readonly notes: readonly string[];
}
