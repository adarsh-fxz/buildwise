import * as vscode from 'vscode';
import type { RepositoryContext } from '../core/mentor/prompts';
import type { CheckEvidence } from '../core/session/session';
import type { FolderScan } from './workspaceFiles';

/**
 * What the mentor sees: the shareable file list from the scan, plus the
 * learner's current editor if that file is shareable too. The editor is
 * read fresh on each request so hints follow what they are working on.
 */
export function repositoryContext(scan: FolderScan, editors: EditorTracker): () => Promise<RepositoryContext> {
  const files = scan.files.flatMap(({ path, result }) => (result.shareable ? [path] : []));
  return () => {
    const document = editors.current?.document;
    if (!document || vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() !== scan.folder.uri.toString()) {
      return Promise.resolve({ files });
    }
    const path = vscode.workspace.asRelativePath(document.uri, false);
    const content = document.getText();
    const decision = scan.policy(path, Buffer.byteLength(content));
    return Promise.resolve(decision.shareable ? { files, openFile: { path, content } } : { files });
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

/** Files saved in a folder since the last reset. */
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

  reset(): void {
    this.saved.clear();
  }

  dispose(): void {
    this.subscription.dispose();
  }
}

/**
 * Error diagnostics VS Code currently reports in the folder. Language servers
 * usually report on open files only, so the scope says how many were checked.
 */
export function collectEvidence(
  folder: vscode.WorkspaceFolder,
  changes: ChangeTracker,
): { evidence: CheckEvidence; scope: string } {
  const inFolder = vscode.languages
    .getDiagnostics()
    .filter(([uri]) => vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === folder.uri.toString());
  const errors = inFolder
    .flatMap(([, diagnostics]) => diagnostics)
    .filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error).length;
  const count = inFolder.length;
  return {
    evidence: { errors, tests: 'not-run', changedFiles: changes.count },
    scope: `${String(count)} ${count === 1 ? 'file' : 'files'} with diagnostics`,
  };
}
