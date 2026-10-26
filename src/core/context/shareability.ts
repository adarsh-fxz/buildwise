import ignore, { type Ignore } from 'ignore';

export type ExclusionReason =
  | 'secret'
  | 'dependency'
  | 'generated'
  | 'version-control'
  | 'binary'
  | 'user-excluded'
  | 'gitignored'
  | 'too-large';

export type Shareability =
  | { readonly shareable: true }
  | { readonly shareable: false; readonly reason: ExclusionReason };

export interface ShareabilityOptions {
  /** Contents of the workspace root `.gitignore`, if there is one. */
  readonly gitignore?: string | undefined;
  /** Extra gitignore-style patterns from the user's settings. */
  readonly userExcludes?: readonly string[];
  readonly maxFileBytes?: number;
}

export type ShareabilityPolicy = (relativePath: string, sizeBytes: number) => Shareability;

export const DEFAULT_MAX_FILE_BYTES = 256 * 1024;

// Patterns use gitignore syntax. Secrets are checked first so that a key
// inside, say, a gitignored folder is still reported as a secret.
const BUILT_IN_RULES: readonly (readonly [ExclusionReason, readonly string[]])[] = [
  [
    'secret',
    [
      '.env',
      '.env.*',
      '!.env.example',
      '!.env.sample',
      '!.env.template',
      '*.pem',
      '*.key',
      '*.p12',
      '*.pfx',
      '*.jks',
      '*.keystore',
      'id_rsa*',
      'id_dsa*',
      'id_ecdsa*',
      'id_ed25519*',
      '.npmrc',
      '.yarnrc.yml',
      '.pypirc',
      '.netrc',
      '.git-credentials',
      '.aws/',
      '.ssh/',
      '.docker/config.json',
      'credentials.json',
      '*.tfvars',
      '*.tfstate',
      '*.tfstate.*',
    ],
  ],
  ['dependency', ['node_modules/', 'bower_components/', '.pnpm-store/', '.yarn/']],
  [
    'generated',
    [
      'dist/',
      'build/',
      'out/',
      'coverage/',
      '.next/',
      '.nuxt/',
      '.svelte-kit/',
      '.turbo/',
      '.vercel/',
      '.cache/',
      '*.min.js',
      '*.min.css',
      '*.map',
      'package-lock.json',
      'npm-shrinkwrap.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'bun.lock',
      'bun.lockb',
    ],
  ],
  ['version-control', ['.git/', '.hg/', '.svn/']],
  [
    'binary',
    // gitignore syntax has no brace expansion, so list each extension.
    [
      ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tif', 'tiff'],
      ...['woff', 'woff2', 'ttf', 'otf', 'eot'],
      ...['mp3', 'mp4', 'wav', 'ogg', 'mov', 'webm'],
      ...['zip', 'tar', 'gz', 'tgz', '7z', 'rar'],
      ...['pdf', 'exe', 'dll', 'so', 'dylib', 'bin', 'wasm', 'class', 'jar', 'pyc'],
      ...['sqlite', 'sqlite3', 'db'],
    ].map((extension) => `*.${extension}`),
  ],
];

export function createShareabilityPolicy(options: ShareabilityOptions = {}): ShareabilityPolicy {
  const rules: (readonly [ExclusionReason, Ignore])[] = BUILT_IN_RULES.map(
    ([reason, patterns]) => [reason, ignore().add(patterns)] as const,
  );
  if (options.userExcludes?.length) {
    rules.push(['user-excluded', ignore().add(options.userExcludes)]);
  }
  if (options.gitignore) {
    rules.push(['gitignored', ignore().add(options.gitignore)]);
  }
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  return (relativePath, sizeBytes) => {
    const path = normalizeRelativePath(relativePath);
    for (const [reason, matcher] of rules) {
      if (matcher.ignores(path)) {
        return { shareable: false, reason };
      }
    }
    if (sizeBytes > maxFileBytes) {
      return { shareable: false, reason: 'too-large' };
    }
    return { shareable: true };
  };
}

function normalizeRelativePath(input: string): string {
  const path = input.replaceAll('\\', '/').replace(/^(\.\/)+/, '');
  const isAbsolute = path.startsWith('/') || /^[a-zA-Z]:\//.test(path);
  if (path === '' || isAbsolute || path.split('/').includes('..')) {
    throw new RangeError(`Expected a path inside the workspace, got "${input}"`);
  }
  return path;
}
