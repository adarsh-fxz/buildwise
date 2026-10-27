import * as vscode from 'vscode';
import type { Problem } from '../core/checks/output';
import type { CheckReport, SharedFile } from '../core/checks/report';
import type { RepositoryContext } from '../core/mentor/prompts';
import type { SourceIndex } from './sourceIndex';
import type { FolderScan } from './workspaceFiles';

/**
 * What the mentor sees: the shareable file list from the scan, the
 * learner's current editor if that file is shareable too, and the indexed
 * source files to pick ones related to `focus` from. The editor is read
 * fresh on each request so hints follow what they are working on.
 */
export function repositoryContext(
  scan: FolderScan,
  editors: EditorTracker,
  sources: SourceIndex,
): (focus: string) => Promise<RepositoryContext> {
  const files = scan.files.flatMap(({ path, result }) => (result.shareable ? [path] : []));
  return (focus) => {
    const base = { files, sources: sources.files, focus };
    const document = editors.current?.document;
    if (!document || vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() !== scan.folder.uri.toString()) {
      return Promise.resolve(base);
    }
    const path = vscode.workspace.asRelativePath(document.uri, false);
    const content = document.getText();
    const decision = scan.policy(path, Buffer.byteLength(content));
    return Promise.resolve(decision.shareable ? { ...base, openFile: { path, content } } : base);
  };
}

/** Remembers the last text editor, which stays relevant while focus is in the BuildWise view. */
export class EditorTracker implements vscode.Disposable {
  current: vscode.TextEditor | undefined = vscode.window.activeTextEditor;
  private readonly subscription = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) this.current = editor;
  });

  dispose(): void {
    this.subscription.dispose();
  }
}

/**
 * Files saved in a folder during the session. Kept for the whole session, so
 * work done early for a later step still counts when that step is checked.
 */
export class ChangeTracker implements vscode.Disposable {
  private readonly saved = new Set<string>();
  private readonly subscription: vscode.Disposable;

  constructor(folder: vscode.WorkspaceFolder) {
    this.subscription = vscode.workspace.onDidSaveTextDocument((document) => {
      if (vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() === folder.uri.toString()) {
        this.saved.add(document.uri.toString());
      }
    });
  }

  get count(): number {
    return this.saved.size;
  }

  uris(): vscode.Uri[] {
    return [...this.saved].map((uri) => vscode.Uri.parse(uri));
  }

  dispose(): void {
    this.subscription.dispose();
  }
}

/**
 * Errors VS Code currently reports in the folder. Language servers usually
 * report on open files only, so the scope says how many files that covers.
 */
export function editorReport(
  folder: vscode.WorkspaceFolder,
  changes: ChangeTracker,
  files: readonly SharedFile[],
): CheckReport {
  const inFolder = vscode.languages
    .getDiagnostics()
    .filter(([uri]) => vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === folder.uri.toString());
  const problems = inFolder.flatMap(([uri, diagnostics]) =>
    diagnostics
      .filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error)
      .map(
        (diagnostic): Problem => ({
          file: vscode.workspace.asRelativePath(uri, false),
          line: diagnostic.range.start.line + 1,
          column: diagnostic.range.start.character + 1,
          code: diagnosticCode(diagnostic),
          message: diagnostic.message,
        }),
      ),
  );
  const count = inFolder.length;
  return {
    evidence: { errors: problems.length, tests: 'not-run', changedFiles: changes.count },
    scope: `the editor's error list (${String(count)} ${count === 1 ? 'file' : 'files'})`,
    problems,
    files,
    notes: [],
  };
}

const MAX_REVIEW_FILES = 10;

/** The saved files the review may see: shareable ones only, newest last. */
export async function readSavedFiles(changes: ChangeTracker, scan: FolderScan): Promise<SharedFile[]> {
  const files: SharedFile[] = [];
  for (const uri of changes.uris().slice(-MAX_REVIEW_FILES)) {
    try {
      const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      const path = vscode.workspace.asRelativePath(uri, false);
      if (scan.policy(path, Buffer.byteLength(content)).shareable) files.push({ path, content });
    } catch {
      // Deleted since it was saved.
    }
  }
  return files;
}

/** "TS2345" for TypeScript diagnostics, the raw code or source otherwise. */
function diagnosticCode({ code, source }: vscode.Diagnostic): string {
  const value = typeof code === 'object' ? code.value : code;
  if (value === undefined) return source ?? 'error';
  return source === 'ts' ? `TS${String(value)}` : String(value);
}
