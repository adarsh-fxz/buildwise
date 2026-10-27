import { describe, expect, it } from 'vitest';
import { excerpt, isSourceFile, searchTerms, selectRelated, type SourceFile } from './relevance';

const file = (path: string, content: string): SourceFile => ({ path, content });
const filler = (lines: number) => Array.from({ length: lines }, (_, i) => `const unrelated${String(i)} = ${String(i)};`).join('\n');

describe('searchTerms', () => {
  it('splits camelCase and drops instruction words', () => {
    expect(searchTerms('Add pagination to the PostsPage so it shows 10 posts')).toEqual(['pagination', 'post', 'page']);
  });

  it('keeps each term once', () => {
    expect(searchTerms('isEven isEven even')).toEqual(['even']);
  });
});

describe('isSourceFile', () => {
  it('accepts JavaScript and TypeScript sources only', () => {
    expect(['a.ts', 'b.tsx', 'c.mjs', 'd.vue', 'e.cts'].every(isSourceFile)).toBe(true);
    expect(['README.md', 'package.json', 'style.css', 'logo.png'].some(isSourceFile)).toBe(false);
  });
});

describe('selectRelated', () => {
  const big = filler(400);

  it('sends a small project whole, most related first', () => {
    const files = [file('src/util.ts', 'export const x = 1;'), file('src/posts.ts', 'export function listPosts() {}')];
    const related = selectRelated('Paginate the posts list', files, { maxChars: 10_000 });
    expect(related.map((r) => r.path)).toEqual(['src/posts.ts', 'src/util.ts']);
    expect(related.every((r) => !r.partial)).toBe(true);
  });

  it('picks files by name, declarations and identifiers in a large project', () => {
    const files = [
      file('src/billing/invoice.ts', `${big}\nexport function total() {}`),
      file('src/posts/PostList.tsx', `${big}\nexport function PostList({ posts }) { return posts.map(render); }`),
      file('src/api/client.ts', `${big}\nexport async function fetchPosts(page: number) {}`),
    ];
    const related = selectRelated('Add pagination to the post list', files, { maxChars: 4000 });
    expect(related.map((r) => r.path)).toEqual(['src/posts/PostList.tsx', 'src/api/client.ts']);
    expect(related[0]?.matched).toContain('post');
    expect(related[0]?.partial).toBe(true);
    expect(related.reduce((sum, r) => sum + r.content.length, 0)).toBeLessThanOrEqual(4000);
  });

  it('matches word forms that share a stem', () => {
    const files = [file('src/a.ts', `${big}\nfunction paginate() {}`), file('src/b.ts', big)];
    expect(selectRelated('Add pagination', files, { maxChars: 2000 }).map((r) => r.path)).toEqual(['src/a.ts']);
  });

  it('leaves out the open file, non-source files and files with no match', () => {
    const files = [
      file('src/even.ts', `${big}\nexport function isEven() {}`),
      file('src/even.md', 'even '.repeat(2000)),
      file('src/other.ts', big),
    ];
    expect(selectRelated('isEven', files, { maxChars: 2000, exclude: 'src/even.ts' })).toEqual([]);
  });
});

describe('excerpt', () => {
  it('returns short files whole', () => {
    expect(excerpt('const a = 1;', ['a'], 100)).toEqual({ content: 'const a = 1;', partial: false });
  });

  it('keeps the lines around matches, labelled with line numbers', () => {
    const content = [filler(50), 'function paginate(page) {', '  return page;', '}', filler(50)].join('\n');
    const { content: cut, partial } = excerpt(content, ['paginate', 'page'], 800);
    expect(partial).toBe(true);
    expect(cut).toMatch(/^\/\/ lines 45-/);
    expect(cut).toContain('function paginate(page) {');
    expect(cut.length).toBeLessThanOrEqual(800);
  });

  it('prefers the window with the most matches when space is short', () => {
    const content = [filler(30), 'const post = 1;', filler(30), 'posts.map((post) => post.id);', filler(30)].join('\n');
    const { content: cut } = excerpt(content, ['post'], 500);
    expect(cut).toContain('posts.map');
    expect(cut).not.toContain('const post = 1;');
  });
});
