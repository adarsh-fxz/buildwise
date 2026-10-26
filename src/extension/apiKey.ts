import Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';
import { createClaudeMentor, DEFAULT_MODEL, type Mentor } from '../core/mentor/mentor';

// Stored in VS Code's SecretStorage, which uses the OS keychain.
const SECRET_KEY = 'buildwise.anthropicApiKey';

export async function setApiKey(secrets: vscode.SecretStorage): Promise<void> {
  const key = await vscode.window.showInputBox({
    title: 'BuildWise: Anthropic API key',
    prompt: 'Stored in your OS keychain. Create one at console.anthropic.com.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().startsWith('sk-ant-') ? undefined : 'Anthropic API keys start with "sk-ant-".',
  });
  if (key === undefined) return;
  await secrets.store(SECRET_KEY, key.trim());
  void vscode.window.showInformationMessage('BuildWise saved your API key.');
}

export async function clearApiKey(secrets: vscode.SecretStorage): Promise<void> {
  await secrets.delete(SECRET_KEY);
  void vscode.window.showInformationMessage('BuildWise removed your API key.');
}

/** A mentor using the stored key, or undefined after offering to set one. */
export async function loadMentor(secrets: vscode.SecretStorage): Promise<Mentor | undefined> {
  let apiKey = await secrets.get(SECRET_KEY);
  if (!apiKey) {
    const choice = await vscode.window.showWarningMessage(
      'BuildWise needs an Anthropic API key to mentor you.',
      'Set API Key',
    );
    if (choice !== 'Set API Key') return undefined;
    await setApiKey(secrets);
    apiKey = await secrets.get(SECRET_KEY);
    if (!apiKey) return undefined;
  }
  const model = vscode.workspace.getConfiguration('buildwise').get<string>('model', DEFAULT_MODEL);
  return createClaudeMentor(new Anthropic({ apiKey }), model);
}
