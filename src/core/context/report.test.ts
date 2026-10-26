import { describe, expect, it } from 'vitest';
import { formatContextReport, type ScannedFile } from './report';

const shared = (path: string): ScannedFile => ({ path, result: { shareable: true } });
const secret = (path: string): ScannedFile => ({ path, result: { shareable: false, reason: 'secret' } });
const binary = (path: string): ScannedFile => ({ path, result: { shareable: false, reason: 'binary' } });

describe('formatContextReport', () => {
  it('summarizes, then lists exclusions by reason and shareable files, sorted', () => {
    const lines = formatContextReport('app', [
      shared('src/b.ts'),
      binary('logo.png'),
      secret('.env'),
      shared('src/a.ts'),
    ]);
    expect(lines).toEqual([
      'app: 2 of 4 files can be shared',
      '',
      '  Never shared:',
      '    Secrets and credentials (1)',
      '      .env',
      '    Binary files (1)',
      '      logo.png',
      '',
      '  Can be shared:',
      '    src/a.ts',
      '    src/b.ts',
    ]);
  });

  it('caps long exclusion lists but always lists every secret', () => {
    const files = [
      ...['a', 'b', 'c'].map((name) => binary(`${name}.png`)),
      ...['a', 'b', 'c'].map((name) => secret(`${name}.pem`)),
    ];
    const lines = formatContextReport('app', files, { listLimit: 1 });
    expect(lines).toContain('      ...and 2 more');
    expect(lines.filter((line) => line.endsWith('.pem'))).toHaveLength(3);
    expect(lines.filter((line) => line.endsWith('.png'))).toHaveLength(1);
  });

  it('warns when the scan was truncated', () => {
    const lines = formatContextReport('app', [shared('a.ts')], { truncatedAt: 1 });
    expect(lines[1]).toBe('  Stopped after 1 files; the rest were not checked.');
  });

  it('handles an empty folder', () => {
    expect(formatContextReport('empty', [])).toEqual(['empty: 0 of 0 files can be shared']);
  });
});
