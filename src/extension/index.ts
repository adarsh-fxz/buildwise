import * as vscode from 'vscode';
import { clearApiKey, setApiKey } from './apiKey';
import { showSharedContext } from './sharedContext';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('BuildWise');
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('buildwise.showSharedContext', () => showSharedContext(output)),
    vscode.commands.registerCommand('buildwise.setApiKey', () => setApiKey(context.secrets)),
    vscode.commands.registerCommand('buildwise.clearApiKey', () => clearApiKey(context.secrets)),
  );
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
