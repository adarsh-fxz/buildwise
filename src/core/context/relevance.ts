/**
 * Finds the source files that matter for a step, by matching words from the
 * goal and the step against file paths, declared names and identifiers. No
 * embeddings: it has to work offline, for free, and explain its choices.
 */

export interface SourceFile {
  readonly path: string;
  readonly content: string;
}

export interface RelatedFile extends SourceFile {
  /** Search terms this file matched, best first. */
  readonly matched: readonly string[];
  /** True when only the lines around matches are included. */
  readonly partial: boolean;
}

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i;
const MAX_FILES = 6;
const CONTEXT_LINES = 6;
// Below this, a file's share of the budget isn't worth sending.
const MIN_USEFUL_CHARS = 400;

// Words that say what to do rather than what the code is about.
const STOPWORDS = new Set(
  (
    'a an and are as at be by can do does for from has have how if in into is it its make makes me my new of on or ' +
    'so that the their them then there these this to too up use uses using via was we what when where which while ' +
    'who will with without you your add adds adding create creates change changes update updates implement write ' +
    'build show shows return returns returned function functions file files code value values true false should ' +
    'each every all one two any some instead print prints'
  ).split(' '),
);

export function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.test(path);
}

/** Lowercase words from `text`, split at camelCase and punctuation, without stopwords. */
export function searchTerms(text: string): string[] {
  return [...new Set(words(text).filter((word) => word.length >= 3 && !STOPWORDS.has(word)))];
}

/**
 * The files most related to `focus`, within `maxChars` of content. If the
 * whole project fits, it is all sent, so small projects never lose context
 * to a missed keyword.
 */
export function selectRelated(
  focus: string,
  files: readonly SourceFile[],
  { maxChars, exclude }: { readonly maxChars: number; readonly exclude?: string | undefined },
): RelatedFile[] {
  const terms = searchTerms(focus);
  const candidates = files.filter((file) => file.path !== exclude && isSourceFile(file.path));
  const ranked = candidates
    .map((file) => ({ file, ...score(file, terms) }))
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));

  const total = candidates.reduce((sum, file) => sum + file.content.length, 0);
  if (total <= maxChars) {
    return ranked.map(({ file, matched }) => ({ ...file, matched, partial: false }));
  }

  const related: RelatedFile[] = [];
  let remaining = maxChars;
  for (const { file, matched, score: value } of ranked) {
    if (value === 0 || related.length === MAX_FILES || remaining < MIN_USEFUL_CHARS) break;
    // Leave room for the next file unless this one is the last that fits.
    const budget = Math.min(remaining, Math.max(MIN_USEFUL_CHARS, Math.floor(maxChars / 2)));
    const cut = excerpt(file.content, matched, budget);
    if (cut.content === '') continue;
    related.push({ path: file.path, content: cut.content, matched, partial: cut.partial });
    remaining -= cut.content.length;
  }
  return related;
}

/** The whole file if it fits, otherwise the lines around matches with the most matches first. */
export function excerpt(content: string, terms: readonly string[], maxChars: number): { content: string; partial: boolean } {
  if (content.length <= maxChars) return { content, partial: false };

  const lines = content.split('\n');
  const hits = lines.map((line) => words(line).filter((word) => terms.some((term) => matches(word, term))).length);
  const windows = mergeWindows(
    hits.flatMap((count, i) =>
      count > 0 ? [{ start: Math.max(0, i - CONTEXT_LINES), end: Math.min(lines.length - 1, i + CONTEXT_LINES) }] : [],
    ),
  ).map((window) => ({ ...window, hits: sumRange(hits, window.start, window.end) }));

  const chosen: typeof windows = [];
  let used = 0;
  for (const window of [...windows].sort((a, b) => b.hits - a.hits)) {
    const size = renderWindow(lines, window).length + 1;
    if (used + size > maxChars) continue;
    chosen.push(window);
    used += size;
  }
  chosen.sort((a, b) => a.start - b.start);
  return { content: chosen.map((window) => renderWindow(lines, window)).join('\n'), partial: true };
}

function score(file: SourceFile, terms: readonly string[]): { score: number; matched: string[] } {
  const slash = file.path.lastIndexOf('/');
  const nameWords = words(file.path.slice(slash + 1).replace(SOURCE_EXTENSIONS, ''));
  const dirWords = words(file.path.slice(0, Math.max(0, slash)));
  const declared = declaredNames(file.content).flatMap(words);
  const counts = new Map<string, number>();
  for (const word of words(file.content)) counts.set(word, (counts.get(word) ?? 0) + 1);

  const scored = terms.flatMap((term) => {
    const has = (list: readonly string[]) => list.some((word) => matches(word, term));
    let occurrences = 0;
    for (const [word, count] of counts) if (matches(word, term)) occurrences += count;
    const value =
      (has(nameWords) ? 5 : 0) + (has(dirWords) ? 2 : 0) + (has(declared) ? 3 : 0) + Math.log2(1 + Math.min(occurrences, 50));
    return value > 0 ? [{ term, value }] : [];
  });
  scored.sort((a, b) => b.value - a.value);
  return { score: scored.reduce((sum, { value }) => sum + value, 0), matched: scored.map(({ term }) => term) };
}

/** Names introduced by declarations, such as `isEven` in `export function isEven(`. */
function declaredNames(content: string): string[] {
  const pattern = /\b(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  return [...content.matchAll(pattern)].flatMap((match) => (match[1] ? [match[1]] : []));
}

/** Exact, or a shared stem of six letters, so "pagination" finds "paginate". */
function matches(word: string, term: string): boolean {
  return word === term || (word.length >= 6 && term.length >= 6 && word.slice(0, 6) === term.slice(0, 6));
}

function words(text: string): string[] {
  return text
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(Boolean)
    .map(singular);
}

function singular(word: string): string {
  return word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

function mergeWindows(windows: readonly { start: number; end: number }[]): { start: number; end: number }[] {
  const merged: { start: number; end: number }[] = [];
  for (const window of windows) {
    const last = merged.at(-1);
    if (last && window.start <= last.end + 1) last.end = Math.max(last.end, window.end);
    else merged.push({ ...window });
  }
  return merged;
}

function sumRange(values: readonly number[], start: number, end: number): number {
  let sum = 0;
  for (let i = start; i <= end; i++) sum += values[i] ?? 0;
  return sum;
}

function renderWindow(lines: readonly string[], { start, end }: { start: number; end: number }): string {
  return [`// lines ${String(start + 1)}-${String(end + 1)}`, ...lines.slice(start, end + 1)].join('\n');
}
