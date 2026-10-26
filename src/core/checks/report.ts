import type { ToolEvidence } from '../session/session';
import type { Problem } from './output';

/** A file the learner saved, for the review. Already through the shareability policy. */
export interface SharedFile {
  readonly path: string;
  readonly content: string;
}

/** Everything one run of "Check my work" found. */
export interface CheckReport {
  readonly evidence: ToolEvidence;
  /** The files saved this session, for the review. */
  readonly files: readonly SharedFile[];
  /** What was checked, such as "tsc and npm test". */
  readonly scope: string;
  readonly problems: readonly Problem[];
  /** The end of the test runner's output, when tests failed. */
  readonly testOutput?: string;
  /** Anything that could not run, in plain words. */
  readonly notes: readonly string[];
}
