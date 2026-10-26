import * as vscode from 'vscode';
import { formatContextReport } from '../core/context/report';
import { scanFolder } from './workspaceFiles';

export async function showSharedContext(output: vscode.OutputChannel): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    void vscode.window.showInformationMessage('Open a folder to see which files BuildWise can share.');
    return;
  }

  output.clear();
  output.show(true);
  for (const folder of folders) {
    const { files, truncatedAt } = await scanFolder(folder);
    const lines = formatContextReport(folder.name, files, truncatedAt === undefined ? {} : { truncatedAt });
    output.appendLine(lines.join('\n'));
    output.appendLine('');
  }
}
