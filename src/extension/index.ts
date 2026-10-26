import * as vscode from 'vscode';
import { resetCheckPermissions } from './checks';
import { MentorViewProvider } from './mentorView';
import { removeApiKeys, setupProvider, testConnection } from './provider';
import { showSharedContext } from './sharedContext';

const WELCOMED_KEY = 'buildwise.welcomed';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('BuildWise');
  const openMentor = () => vscode.commands.executeCommand(`${MentorViewProvider.viewId}.focus`);

  // Always-visible way in, for when the right side bar is closed.
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusItem.text = '$(mortar-board) BuildWise';
  statusItem.tooltip = 'Open the BuildWise mentor';
  statusItem.command = 'buildwise.openMentor';
  statusItem.show();

  const mentorView = new MentorViewProvider(context.extensionUri, context.secrets, context.workspaceState, output);
  context.subscriptions.push(
    output,
    statusItem,
    mentorView,
    vscode.commands.registerCommand('buildwise.openMentor', openMentor),
    vscode.window.registerWebviewViewProvider(MentorViewProvider.viewId, mentorView),
    vscode.commands.registerCommand('buildwise.showSharedContext', () => showSharedContext(output)),
    vscode.commands.registerCommand('buildwise.setupProvider', () => setupProvider(context.secrets)),
    vscode.commands.registerCommand('buildwise.removeApiKeys', () => removeApiKeys(context.secrets)),
    vscode.commands.registerCommand('buildwise.testConnection', async () => {
      output.show(true);
      await testConnection(context.secrets, (line) => {
        output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
      });
    }),
    vscode.commands.registerCommand('buildwise.resetCheckPermissions', () => resetCheckPermissions(context.workspaceState)),
  );

  if (!context.globalState.get<boolean>(WELCOMED_KEY)) {
    void context.globalState.update(WELCOMED_KEY, true);
    void vscode.window
      .showInformationMessage('BuildWise is installed. Open it to plan your first feature.', 'Open BuildWise')
      .then((choice) => (choice ? openMentor() : undefined));
  }
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
