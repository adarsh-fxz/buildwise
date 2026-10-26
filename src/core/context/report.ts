import type { ExclusionReason, Shareability } from './shareability';

export interface ScannedFile {
  readonly path: string;
  readonly result: Shareability;
}

export interface ReportOptions {
  /** Set when the scan stopped early, so the counts are incomplete. */
  readonly truncatedAt?: number;
  /** Excluded files listed per reason, except secrets, which are always listed in full. */
  readonly listLimit?: number;
}

// Also fixes the order groups appear in.
const REASON_LABELS: Record<ExclusionReason, string> = {
  secret: 'Secrets and credentials',
  'user-excluded': 'Excluded in settings (buildwise.context.exclude)',
  gitignored: 'Ignored by .gitignore',
  'too-large': 'Too large',
  binary: 'Binary files',
  generated: 'Build output and lockfiles',
  dependency: 'Dependencies',
  'version-control': 'Version control',
};

export function formatContextReport(
  folderName: string,
  files: readonly ScannedFile[],
  { truncatedAt, listLimit = 10 }: ReportOptions = {},
): string[] {
  const shareable: string[] = [];
  const excluded = new Map<ExclusionReason, string[]>();
  for (const { path, result } of files) {
    if (result.shareable) {
      shareable.push(path);
    } else {
      const group = excluded.get(result.reason) ?? [];
      group.push(path);
      excluded.set(result.reason, group);
    }
  }

  const lines = [`${folderName}: ${String(shareable.length)} of ${String(files.length)} files can be shared`];
  if (truncatedAt !== undefined) {
    lines.push(`  Stopped after ${String(truncatedAt)} files; the rest were not checked.`);
  }

  if (excluded.size > 0) {
    lines.push('', '  Never shared:');
    for (const [reason, label] of Object.entries(REASON_LABELS) as [ExclusionReason, string][]) {
      const paths = excluded.get(reason);
      if (!paths) continue;
      lines.push(`    ${label} (${String(paths.length)})`);
      const limit = reason === 'secret' ? paths.length : listLimit;
      for (const path of paths.sort().slice(0, limit)) {
        lines.push(`      ${path}`);
      }
      if (paths.length > limit) {
        lines.push(`      ...and ${String(paths.length - limit)} more`);
      }
    }
  }

  if (shareable.length > 0) {
    lines.push('', '  Can be shared:');
    for (const path of shareable.sort()) {
      lines.push(`    ${path}`);
    }
  }
  return lines;
}
