export interface FileRef {
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
}

const FILE_REF =
  /^((?:[\w@.-]+\/)*[\w@.-]+\.(?:tsx?|jsx?|mjs|cjs|json|css|scss|html|md|vue|svelte|ya?ml))(?::(\d+))?(?::(\d+))?$/;

/**
 * Reads "src/lib/posts.ts" or "src/lib/posts.ts:12:5" as a file in the
 * workspace. Absolute paths and ".." are never file references, since the
 * text comes from the model.
 */
export function parseFileRef(text: string): FileRef | undefined {
  const match = FILE_REF.exec(text.trim());
  if (!match) return undefined;
  const [, file = '', line, column] = match;
  if (!isWorkspaceRelative(file)) return undefined;
  return {
    file,
    ...(line !== undefined && { line: Number(line) }),
    ...(column !== undefined && { column: Number(column) }),
  };
}

export function isWorkspaceRelative(path: string): boolean {
  const segments = path.split('/');
  return path !== '' && !path.startsWith('/') && !segments.some((segment) => segment === '..' || segment === '.' || segment === '');
}
