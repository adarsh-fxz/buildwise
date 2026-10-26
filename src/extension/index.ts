import * as vscode from 'vscode';
import { showSharedContext } from './sharedContext';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('BuildWise');
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('buildwise.showSharedContext', () => showSharedContext(output)),
  );
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
