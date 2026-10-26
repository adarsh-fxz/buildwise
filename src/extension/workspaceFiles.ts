import * as vscode from 'vscode';
import type { ScannedFile } from '../core/context/report';
import { createShareabilityPolicy, type ShareabilityPolicy } from '../core/context/shareability';

const MAX_FILES = 10_000;
const STAT_BATCH_SIZE = 64;
// Pruned from the search for speed; the policy would exclude them anyway.
const SEARCH_EXCLUDE = '{**/node_modules/**,**/.git/**}';

export interface FolderScan {
  readonly folder: vscode.WorkspaceFolder;
  readonly policy: ShareabilityPolicy;
  readonly files: readonly ScannedFile[];
  /** Set when the scan hit the file limit, so `files` is incomplete. */
  readonly truncatedAt?: number;
}

export async function scanFolder(folder: vscode.WorkspaceFolder): Promise<FolderScan> {
  const policy = createShareabilityPolicy({
    gitignore: await readGitignore(folder),
    userExcludes: vscode.workspace
      .getConfiguration('buildwise', folder)
      .get<string[]>('context.exclude', []),
  });

  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, '**/*'),
    SEARCH_EXCLUDE,
    MAX_FILES,
  );

  const files: ScannedFile[] = [];
  for (let i = 0; i < uris.length; i += STAT_BATCH_SIZE) {
    const batch = uris.slice(i, i + STAT_BATCH_SIZE);
    const stats = await Promise.allSettled(batch.map((uri) => vscode.workspace.fs.stat(uri)));
    batch.forEach((uri, j) => {
      const stat = stats[j];
      // Skip files deleted between the search and the stat.
      if (stat?.status !== 'fulfilled') return;
      const path = vscode.workspace.asRelativePath(uri, false);
      files.push({ path, result: policy(path, stat.value.size) });
    });
  }

  return {
    folder,
    policy,
    files,
    ...(uris.length === MAX_FILES && { truncatedAt: MAX_FILES }),
  };
}

async function readGitignore(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, '.gitignore'));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}
