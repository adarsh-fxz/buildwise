import * as vscode from 'vscode';
import { isSourceFile, type SourceFile } from '../core/context/relevance';
import type { FolderScan } from './workspaceFiles';

const MAX_FILES = 3000;
const MAX_TOTAL_CHARS = 16 * 1024 * 1024;
const READ_BATCH_SIZE = 64;

/**
 * The folder's shareable source files, read once when a session starts and
 * kept current as the learner saves, so related files can be found per step.
 */
export class SourceIndex implements vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly subscriptions: vscode.Disposable[];

  private constructor(private readonly scan: FolderScan) {
    this.subscriptions = [
      vscode.workspace.onDidSaveTextDocument((document) => {
        this.update(document.uri, document.getText());
      }),
      vscode.workspace.onDidDeleteFiles(({ files }) => {
        for (const uri of files) this.contents.delete(vscode.workspace.asRelativePath(uri, false));
      }),
    ];
  }

  static async build(scan: FolderScan): Promise<SourceIndex> {
    const index = new SourceIndex(scan);
    const paths = scan.files.flatMap(({ path, result }) => (result.shareable && isSourceFile(path) ? [path] : []));
    let total = 0;
    for (let i = 0; i < Math.min(paths.length, MAX_FILES) && total < MAX_TOTAL_CHARS; i += READ_BATCH_SIZE) {
      const batch = paths.slice(i, Math.min(i + READ_BATCH_SIZE, MAX_FILES));
      const reads = await Promise.allSettled(
        batch.map((path) => vscode.workspace.fs.readFile(vscode.Uri.joinPath(scan.folder.uri, path))),
      );
      batch.forEach((path, j) => {
        const read = reads[j];
        // Skip files deleted since the scan.
        if (read?.status !== 'fulfilled') return;
        const content = new TextDecoder().decode(read.value);
        index.contents.set(path, content);
        total += content.length;
      });
    }
    return index;
  }

  get size(): number {
    return this.contents.size;
  }

  get files(): SourceFile[] {
    return [...this.contents].map(([path, content]) => ({ path, content }));
  }

  private update(uri: vscode.Uri, content: string): void {
    if (vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() !== this.scan.folder.uri.toString()) return;
    const path = vscode.workspace.asRelativePath(uri, false);
    if (!isSourceFile(path)) return;
    if (this.scan.policy(path, Buffer.byteLength(content)).shareable) this.contents.set(path, content);
    else this.contents.delete(path);
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
