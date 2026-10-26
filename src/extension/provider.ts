import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import * as vscode from 'vscode';
import { createCompatibleMentor } from '../core/mentor/compatible';
import { describeError } from '../core/mentor/errors';
import { seconds } from '../core/mentor/instrument';
import { createClaudeMentor, type Mentor } from '../core/mentor/mentor';
import { chatModels, findProvider, type Provider, PROVIDERS } from '../core/mentor/providers';

// Keys live in VS Code's SecretStorage (the OS keychain), one per provider.
const secretKey = (provider: Provider) => `buildwise.apiKey.${provider.id}`;

interface Configured {
  readonly provider: Provider;
  readonly model: string;
  readonly baseURL: string | undefined;
  readonly apiKey: string | undefined;
}

/** A mentor for the configured provider, running setup first if anything is missing. */
export async function loadMentor(secrets: vscode.SecretStorage): Promise<Mentor | undefined> {
  let configured = await readConfigured(secrets);
  if (!configured) {
    const choice = await vscode.window.showInformationMessage(
      'Choose the AI model BuildWise should use. Free options are available.',
      'Set Up Model Provider',
    );
    if (choice !== 'Set Up Model Provider' || !(await setupProvider(secrets))) return undefined;
    configured = await readConfigured(secrets);
    if (!configured) return undefined;
  }
  return createMentor(configured);
}

/** "gemini-3.8-flash from Google Gemini", or undefined until setup is complete. */
export async function describeConfigured(secrets: vscode.SecretStorage): Promise<string | undefined> {
  const configured = await readConfigured(secrets);
  return configured && `${configured.model} from ${configured.provider.label}`;
}

export async function setupProvider(secrets: vscode.SecretStorage): Promise<boolean> {
  const picked = await vscode.window.showQuickPick(
    PROVIDERS.map((provider) => ({
      label: provider.label,
      description: provider.free ? 'Free option' : '',
      detail: provider.detail,
      provider,
    })),
    { title: 'BuildWise: Choose a model provider', ignoreFocusOut: true },
  );
  if (!picked) return false;
  const { provider } = picked;

  const baseURL = await askBaseURL(provider);
  if (baseURL === null) return false;

  const saved = await secrets.get(secretKey(provider));
  const apiKey = provider.needsKey ? await askKey(provider, saved) : undefined;
  if (apiKey === null) return false;

  const model = await askModel(provider, apiKey, baseURL);
  if (model === undefined) return false;

  if (apiKey !== undefined && apiKey !== saved) await secrets.store(secretKey(provider), apiKey);
  const config = vscode.workspace.getConfiguration('buildwise');
  await config.update('provider', provider.id, vscode.ConfigurationTarget.Global);
  await config.update('model', model, vscode.ConfigurationTarget.Global);
  await config.update('baseUrl', baseURL === provider.baseURL ? undefined : baseURL, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(`BuildWise will use ${model} from ${provider.label}.`);
  return true;
}

export async function removeApiKeys(secrets: vscode.SecretStorage): Promise<void> {
  await Promise.all(PROVIDERS.map((provider) => secrets.delete(secretKey(provider))));
  void vscode.window.showInformationMessage('BuildWise removed your saved API keys.');
}

// One retry covers a brief rate limit; more would leave the learner waiting minutes.
const MAX_RETRIES = 1;

function createMentor({ provider, model, baseURL, apiKey }: Configured): Mentor {
  const timeout = provider.timeoutMs;
  if (provider.id === 'anthropic') {
    return createClaudeMentor(new Anthropic({ apiKey, timeout, maxRetries: MAX_RETRIES }), model);
  }
  const client = new OpenAI({ apiKey: apiKey ?? 'not-needed', baseURL, timeout, maxRetries: MAX_RETRIES });
  return createCompatibleMentor(client, {
    model,
    ...(provider.limits && { limits: provider.limits }),
    ...(provider.maxOutputTokens !== undefined && { maxOutputTokens: provider.maxOutputTokens }),
    ...(provider.reasoningEffort && { reasoningEffort: provider.reasoningEffort }),
  });
}

/**
 * Times a model list and a one-word reply with the saved settings, so a slow
 * model can be told apart from a slow or blocked connection.
 */
export async function testConnection(secrets: vscode.SecretStorage, log: (line: string) => void): Promise<void> {
  const configured = await readConfigured(secrets);
  if (!configured) {
    void vscode.window.showWarningMessage('Set up a model provider first.');
    return;
  }
  const { provider, model, baseURL, apiKey } = configured;
  log(`Testing ${model} from ${provider.label}${baseURL ? ` at ${baseURL}` : ''}.`);

  const step = async (name: string, request: () => Promise<unknown>) => {
    const started = Date.now();
    try {
      await request();
      log(`${name}: OK in ${seconds(Date.now() - started)}`);
      return true;
    } catch (error) {
      log(`${name}: failed after ${seconds(Date.now() - started)}: ${describeError(error)}`);
      return false;
    }
  };

  const listed = await step('model list', () => listModels(provider, apiKey, baseURL));
  const replied = await step('one-word reply', async () => {
    const options = { timeout: provider.timeoutMs, maxRetries: 0 };
    if (provider.id === 'anthropic') {
      await new Anthropic({ apiKey, ...options }).messages.create({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Reply with the word OK.' }],
      });
      return;
    }
    await new OpenAI({ apiKey: apiKey ?? 'not-needed', baseURL, ...options }).chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Reply with the word OK.' }],
      ...(provider.reasoningEffort && { reasoning_effort: provider.reasoningEffort }),
    });
  });
  const summary =
    listed && replied ? 'The model answered. Details are in Output → BuildWise.' : 'The test found a problem. Details are in Output → BuildWise.';
  void vscode.window.showInformationMessage(summary);
}

async function readConfigured(secrets: vscode.SecretStorage): Promise<Configured | undefined> {
  const config = vscode.workspace.getConfiguration('buildwise');
  // Only an explicit choice counts; the schema default is a placeholder.
  const provider = findProvider(config.inspect<string>('provider')?.globalValue ?? '');
  if (!provider) return undefined;
  const model = config.get<string>('model', '') || provider.suggestedModel;
  const baseURL = config.get<string>('baseUrl', '') || provider.baseURL;
  const apiKey = provider.needsKey ? await secrets.get(secretKey(provider)) : undefined;
  if (!model || (provider.id !== 'anthropic' && !baseURL) || (provider.needsKey && !apiKey)) return undefined;
  return { provider, model, baseURL, apiKey };
}

/** The endpoint to use; null if the learner cancelled. */
async function askBaseURL(provider: Provider): Promise<string | undefined | null> {
  if (provider.id !== 'custom' && provider.id !== 'ollama') return provider.baseURL;
  const value = await vscode.window.showInputBox({
    title: `BuildWise: ${provider.label} endpoint`,
    prompt: 'The base URL of the OpenAI-compatible API, ending before /chat/completions.',
    value: provider.baseURL ?? '',
    placeHolder: 'https://api.example.com/v1',
    ignoreFocusOut: true,
    validateInput: (input) => (/^https?:\/\/\S+$/.test(input.trim()) ? undefined : 'Enter an http or https URL.'),
  });
  return value === undefined ? null : value.trim();
}

/** The key to use; null if the learner cancelled. */
async function askKey(provider: Provider, saved: string | undefined): Promise<string | null> {
  const where = provider.keyUrl ? ` Get one at ${provider.keyUrl}` : '';
  const value = await vscode.window.showInputBox({
    title: `BuildWise: ${provider.label} API key`,
    prompt: `Stored in your OS keychain.${where}`,
    placeHolder: saved ? 'Leave empty to keep your saved key' : '',
    password: true,
    ignoreFocusOut: true,
    validateInput: (input) => (input.trim() === '' && !saved ? 'Paste your API key.' : undefined),
  });
  if (value === undefined) return null;
  return value.trim() || saved || null;
}

async function askModel(provider: Provider, apiKey: string | undefined, baseURL: string | undefined): Promise<string | undefined> {
  let models: string[] = [];
  try {
    models = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Getting the model list from ${provider.label}…` },
      () => listModels(provider, apiKey, baseURL),
    );
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError || error instanceof OpenAI.AuthenticationError) {
      void vscode.window.showErrorMessage(`${provider.label} rejected that API key. Nothing was saved.`);
      return undefined;
    }
    void vscode.window.showWarningMessage(`Could not get the model list: ${describeError(error)} Enter a model name instead.`);
  }

  const typeName = '$(edit) Enter a model name…';
  const choice = models.length
    ? await vscode.window.showQuickPick([...models, typeName], {
        title: `BuildWise: Choose a ${provider.label} model`,
        placeHolder: provider.suggestedModel && models[0] === provider.suggestedModel ? 'The first one is a good default' : '',
        ignoreFocusOut: true,
      })
    : typeName;
  if (choice !== typeName) return choice;

  const typed = await vscode.window.showInputBox({
    title: `BuildWise: ${provider.label} model`,
    prompt: 'The model name exactly as the provider lists it.',
    value: provider.suggestedModel ?? '',
    ignoreFocusOut: true,
    validateInput: (input) => (input.trim() === '' ? 'Enter a model name.' : undefined),
  });
  return typed?.trim();
}

async function listModels(provider: Provider, apiKey: string | undefined, baseURL: string | undefined): Promise<string[]> {
  const ids: string[] = [];
  if (provider.id === 'anthropic') {
    for await (const model of new Anthropic({ apiKey }).models.list()) ids.push(model.id);
  } else {
    for await (const model of new OpenAI({ apiKey: apiKey ?? 'not-needed', baseURL }).models.list()) ids.push(model.id);
  }
  return chatModels(provider, ids);
}
