import { describe, expect, it } from 'vitest';
import { createShareabilityPolicy, DEFAULT_MAX_FILE_BYTES } from './shareability';

const policy = createShareabilityPolicy();
const reasonFor = (path: string, size = 100) => {
  const result = policy(path, size);
  return result.shareable ? 'shareable' : result.reason;
};

describe('createShareabilityPolicy', () => {
  it('shares ordinary source files', () => {
    expect(reasonFor('src/app/page.tsx')).toBe('shareable');
    expect(reasonFor('package.json')).toBe('shareable');
    expect(reasonFor('public/logo.svg')).toBe('shareable');
  });

  it.each([
    '.env',
    '.env.local',
    'apps/web/.env.production',
    '.ENV',
    'certs/server.pem',
    'deploy/prod.key',
    '.ssh/id_ed25519',
    'id_rsa.pub',
    '.npmrc',
    '.aws/credentials',
    'infra/prod.tfvars',
    'terraform.tfstate.backup',
  ])('treats %s as a secret', (path) => {
    expect(reasonFor(path)).toBe('secret');
  });

  it('allows env templates, which document variables without values', () => {
    expect(reasonFor('.env.example')).toBe('shareable');
    expect(reasonFor('apps/api/.env.sample')).toBe('shareable');
  });

  it('reports a secret as a secret even inside an excluded folder', () => {
    expect(reasonFor('node_modules/pkg/.env')).toBe('secret');
    expect(reasonFor('dist/server.key')).toBe('secret');
  });

  it.each([
    ['node_modules/react/index.js', 'dependency'],
    ['packages/ui/node_modules/x/y.js', 'dependency'],
    ['.next/server/app.js', 'generated'],
    ['dist/extension.js', 'generated'],
    ['package-lock.json', 'generated'],
    ['assets/vendor.min.js', 'generated'],
    ['.git/HEAD', 'version-control'],
    ['public/hero.PNG', 'binary'],
    ['fonts/inter.woff2', 'binary'],
    ['data/dev.sqlite', 'binary'],
  ] as const)('excludes %s as %s', (path, reason) => {
    expect(reasonFor(path)).toBe(reason);
  });

  it('applies the workspace .gitignore', () => {
    const withGitignore = createShareabilityPolicy({ gitignore: '# local\n*.log\ntmp/\n' });
    expect(withGitignore('server.log', 10)).toEqual({ shareable: false, reason: 'gitignored' });
    expect(withGitignore('tmp/scratch.ts', 10)).toEqual({ shareable: false, reason: 'gitignored' });
    expect(withGitignore('src/log.ts', 10)).toEqual({ shareable: true });
  });

  it('applies user excludes before the .gitignore', () => {
    const withBoth = createShareabilityPolicy({
      gitignore: 'private/',
      userExcludes: ['private/', 'legacy/**/*.js'],
    });
    expect(withBoth('private/notes.md', 10)).toEqual({ shareable: false, reason: 'user-excluded' });
    expect(withBoth('legacy/a/b.js', 10)).toEqual({ shareable: false, reason: 'user-excluded' });
  });

  it('excludes files above the size limit', () => {
    expect(reasonFor('src/big.ts', DEFAULT_MAX_FILE_BYTES)).toBe('shareable');
    expect(reasonFor('src/big.ts', DEFAULT_MAX_FILE_BYTES + 1)).toBe('too-large');
    const strict = createShareabilityPolicy({ maxFileBytes: 10 });
    expect(strict('src/a.ts', 11)).toEqual({ shareable: false, reason: 'too-large' });
  });

  it('normalizes Windows separators and leading ./', () => {
    expect(reasonFor('apps\\web\\.env')).toBe('secret');
    expect(reasonFor('./src/index.ts')).toBe('shareable');
  });

  it.each(['', '/etc/passwd', 'C:/Users/me/.env', '../outside.ts', 'src/../../x.ts'])(
    'rejects %j, which is not a path inside the workspace',
    (path) => {
      expect(() => policy(path, 1)).toThrow(RangeError);
    },
  );
});
