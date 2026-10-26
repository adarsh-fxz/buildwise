/** A compiler error, as reported by tsc. */
export interface Problem {
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly code: string;
  readonly message: string;
}

// `--pretty false` prints file(line,col); the default pretty output prints file:line:col.
const LOCATED = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const LOCATED_PRETTY = /^(.+?):(\d+):(\d+) - error (TS\d+): (.*)$/;
const GLOBAL = /^error (TS\d+): (.*)$/;

export function parseTscOutput(output: string): Problem[] {
  const problems: Problem[] = [];
  // Indented lines directly under an error continue its message. A blank line
  // ends it; pretty output follows with code frames and related locations.
  let continuing = false;
  for (const line of output.split(/\r?\n/)) {
    const plain = stripAnsi(line);
    const located = LOCATED.exec(plain) ?? LOCATED_PRETTY.exec(plain);
    const global = located ? null : GLOBAL.exec(plain);
    if (located) {
      const [, file = '', row = '0', column = '0', code = '', message = ''] = located;
      problems.push({ file: file.replaceAll('\\', '/'), line: Number(row), column: Number(column), code, message });
      continuing = true;
    } else if (global) {
      const [, code = '', message = ''] = global;
      problems.push({ code, message });
      continuing = true;
    } else if (continuing && /^\s+\S/.test(plain)) {
      const previous = problems[problems.length - 1];
      if (previous) problems[problems.length - 1] = { ...previous, message: `${previous.message} ${plain.trim()}` };
    } else {
      continuing = false;
    }
  }
  return problems;
}

export function formatProblem({ file, line, code, message }: Problem): string {
  const location = file ? `${file}${line ? `:${String(line)}` : ''} ` : '';
  return `${location}${code}: ${message}`;
}

/** Keeps the end of long output, where test runners print their summary. */
export function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `…${text.slice(text.length - maxChars)}`;
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- matching terminal escape codes is the point
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}
