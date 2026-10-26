/** A compiler error with a location, as reported by `tsc --pretty false`. */
export interface Problem {
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly code: string;
  readonly message: string;
}

const LOCATED = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const GLOBAL = /^error (TS\d+): (.*)$/;

export function parseTscOutput(output: string): Problem[] {
  const problems: Problem[] = [];
  for (const line of stripAnsi(output).split(/\r?\n/)) {
    const located = LOCATED.exec(line);
    if (located) {
      const [, file = '', row = '0', column = '0', code = '', message = ''] = located;
      problems.push({ file: file.replaceAll('\\', '/'), line: Number(row), column: Number(column), code, message });
      continue;
    }
    const global = GLOBAL.exec(line);
    if (global) {
      const [, code = '', message = ''] = global;
      problems.push({ code, message });
      continue;
    }
    // tsc indents the continuation lines of a long message.
    const previous = problems.at(-1);
    if (previous && /^\s+\S/.test(line)) {
      problems[problems.length - 1] = { ...previous, message: `${previous.message} ${line.trim()}` };
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
