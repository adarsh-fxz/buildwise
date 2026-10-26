import * as vscode from 'vscode';
import { clearApiKey, setApiKey } from './apiKey';
import { resetCheckPermissions } from './checks';
import { MentorViewProvider } from './mentorView';
import { showSharedContext } from './sharedContext';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('BuildWise');
  const mentorView = new MentorViewProvider(context.extensionUri, context.secrets, context.workspaceState);
  context.subscriptions.push(
    output,
    mentorView,
    vscode.window.registerWebviewViewProvider(MentorViewProvider.viewId, mentorView),
    vscode.commands.registerCommand('buildwise.showSharedContext', () => showSharedContext(output)),
    vscode.commands.registerCommand('buildwise.setApiKey', () => setApiKey(context.secrets)),
    vscode.commands.registerCommand('buildwise.clearApiKey', () => clearApiKey(context.secrets)),
    vscode.commands.registerCommand('buildwise.resetCheckPermissions', () => resetCheckPermissions(context.workspaceState)),
  );
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
