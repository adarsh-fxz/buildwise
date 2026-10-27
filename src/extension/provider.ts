import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import * as vscode from 'vscode';
import { createCompatibleMentor } from '../core/mentor/compatible';
import { describeError } from '../core/mentor/errors';
import { seconds } from '../core/mentor/instrument';
import { createClaudeMentor, type Mentor } from '../core/mentor/mentor';
import {
  chatModels,
  EFFORT_CHOICES,
  findProvider,
  type Provider,
  PROVIDERS,
  resolveClaudeEffort,
  resolveReasoningEffort,
} from '../core/mentor/providers';
import type { ModelChoice } from '../webview/protocol';

// Keys live in VS Code's SecretStorage (the OS keychain), one per provider.
const secretKey = (provider: Provider) => `buildwise.apiKey.${provider.id}`;
// The model and endpoint last used with each provider, so switching back is one click.
const REMEMBERED_KEY = 'buildwise.providerChoices';

interface Configured {
  readonly provider: Provider;
  readonly model: string;
  readonly baseURL: string | undefined;
  readonly apiKey: string | undefined;
}

type Remembered = Partial<Record<string, { readonly model: string; readonly baseUrl?: string }>>;

/** The model provider settings: what is configured, setting it up, and switching. */
export class Providers {
  private readonly modelLists = new Map<string, Promise<string[]>>();

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly memory: vscode.Memento,
  ) {}

  /** A mentor for the configured provider, running setup first if anything is missing. */
  async load(): Promise<Mentor | undefined> {
    let configured = await this.configured();
    if (!configured) {
      const choice = await vscode.window.showInformationMessage(
        'Choose the AI model BuildWise should use. Free options are available.',
        'Set Up Model Provider',
      );
      if (choice !== 'Set Up Model Provider' || !(await this.setup())) return undefined;
      configured = await this.configured();
      if (!configured) return undefined;
    }
    return createMentor(configured);
  }

  /** A mentor for the configured provider, or undefined without asking anything. */
  async current(): Promise<Mentor | undefined> {
    const configured = await this.configured();
    return configured && createMentor(configured);
  }

  /** "gemini-3.8-flash from Google Gemini", or undefined until setup is complete. */
  async describe(): Promise<string | undefined> {
    const configured = await this.configured();
    return configured && `${configured.model} from ${configured.provider.label}`;
  }

  /** What the menus under the input box show. */
  async choice(): Promise<ModelChoice | undefined> {
    const configured = await this.configured();
    if (!configured) return undefined;
    const remembered = this.remembered();
    const providers = await Promise.all(
      PROVIDERS.map(async (provider) => ({
        id: provider.id,
        label: provider.shortLabel,
        free: provider.free,
        ready:
          provider.id === configured.provider.id ||
          ((!provider.needsKey || (await this.secrets.get(secretKey(provider))) !== undefined) &&
            (provider.id !== 'custom' || remembered.custom?.baseUrl !== undefined)),
      })),
    );
    return {
      providers,
      provider: configured.provider.id,
      model: configured.model,
      effort: vscode.workspace.getConfiguration('buildwise').get<string>('reasoningEffort', 'auto'),
      efforts: EFFORT_CHOICES,
    };
  }

  /** Runs the setup steps, starting from `preset` when given. Returns whether a provider was saved. */
  async setup(preset?: Provider): Promise<boolean> {
    const provider = preset ?? (await pickProvider());
    if (!provider) return false;

    const baseURL = await askBaseURL(provider, this.remembered()[provider.id]?.baseUrl);
    if (baseURL === null) return false;

    const saved = await this.secrets.get(secretKey(provider));
    const apiKey = provider.needsKey ? await askKey(provider, saved) : undefined;
    if (apiKey === null) return false;

    const model = await askModel(provider, apiKey, baseURL);
    if (model === undefined) return false;

    if (apiKey !== undefined && apiKey !== saved) await this.secrets.store(secretKey(provider), apiKey);
    this.modelLists.clear();
    await this.save(provider, model, baseURL);
    void vscode.window.showInformationMessage(`BuildWise will use ${model} from ${provider.label}.`);
    return true;
  }

  /**
   * Switches to `id` with the model last used there. Setup runs instead when
   * the provider still needs a key, an endpoint or a model.
   */
  async switchTo(id: string): Promise<void> {
    const provider = findProvider(id);
    const configured = await this.configured();
    if (!provider || provider.id === configured?.provider.id) return;
    const remembered = this.remembered()[provider.id];
    const apiKey = provider.needsKey ? await this.secrets.get(secretKey(provider)) : undefined;
    const baseURL = remembered?.baseUrl ?? provider.baseURL;
    if ((provider.needsKey && !apiKey) || (provider.id !== 'anthropic' && !baseURL)) {
      await this.setup(provider);
      return;
    }
    let model = remembered?.model ?? provider.suggestedModel;
    if (!model) {
      model = (await this.models(provider, apiKey, baseURL).catch(() => []))[0];
      if (!model) {
        await this.setup(provider);
        return;
      }
    }
    await this.save(provider, model, baseURL);
  }

  async setModel(model: string): Promise<void> {
    const configured = await this.configured();
    if (configured && model.trim()) await this.save(configured.provider, model.trim(), configured.baseURL);
  }

  async setEffort(effort: string): Promise<void> {
    if (!(EFFORT_CHOICES as readonly string[]).includes(effort)) return;
    await vscode.workspace.getConfiguration('buildwise').update('reasoningEffort', effort, vscode.ConfigurationTarget.Global);
  }

  /** The configured provider's chat models, fetched once per provider and endpoint. */
  async currentModels(): Promise<{ provider: string; models: string[] }> {
    const configured = await this.configured();
    if (!configured) return { provider: '', models: [] };
    const { provider, apiKey, baseURL } = configured;
    return { provider: provider.id, models: await this.models(provider, apiKey, baseURL) };
  }

  async removeKeys(): Promise<void> {
    await Promise.all(PROVIDERS.map((provider) => this.secrets.delete(secretKey(provider))));
    this.modelLists.clear();
    void vscode.window.showInformationMessage('BuildWise removed your saved API keys.');
  }

  /**
   * Times a model list and a one-word reply with the saved settings, so a slow
   * model can be told apart from a slow or blocked connection.
   */
  async test(log: (line: string) => void): Promise<void> {
    const configured = await this.configured();
    if (!configured) {
      void vscode.window.showWarningMessage('Set up a model provider first.');
      return;
    }
    await testConnection(configured, log);
  }

  private models(provider: Provider, apiKey: string | undefined, baseURL: string | undefined): Promise<string[]> {
    const key = `${provider.id} ${baseURL ?? ''}`;
    let list = this.modelLists.get(key);
    if (!list) {
      list = listModels(provider, apiKey, baseURL);
      // Forget failures, so the next look tries again.
      void list.catch(() => this.modelLists.delete(key));
      this.modelLists.set(key, list);
    }
    return list;
  }

  private async save(provider: Provider, model: string, baseURL: string | undefined): Promise<void> {
    const baseUrl = baseURL === provider.baseURL ? undefined : baseURL;
    await this.memory.update(REMEMBERED_KEY, {
      ...this.remembered(),
      [provider.id]: { model, ...(baseUrl && { baseUrl }) },
    });
    const config = vscode.workspace.getConfiguration('buildwise');
    await config.update('provider', provider.id, vscode.ConfigurationTarget.Global);
    await config.update('model', model, vscode.ConfigurationTarget.Global);
    await config.update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
  }

  private remembered(): Remembered {
    return this.memory.get<Remembered>(REMEMBERED_KEY, {});
  }

  private async configured(): Promise<Configured | undefined> {
    const config = vscode.workspace.getConfiguration('buildwise');
    // Only an explicit choice counts; the schema default is a placeholder.
    const provider = findProvider(config.inspect<string>('provider')?.globalValue ?? '');
    if (!provider) return undefined;
    const model = config.get<string>('model', '') || provider.suggestedModel;
    const baseURL = config.get<string>('baseUrl', '') || provider.baseURL;
    const apiKey = provider.needsKey ? await this.secrets.get(secretKey(provider)) : undefined;
    if (!model || (provider.id !== 'anthropic' && !baseURL) || (provider.needsKey && !apiKey)) return undefined;
    return { provider, model, baseURL, apiKey };
  }
}

async function pickProvider(): Promise<Provider | undefined> {
  const picked = await vscode.window.showQuickPick(
    PROVIDERS.map((provider) => ({
      label: provider.label,
      description: provider.free ? 'Free option' : '',
      detail: provider.detail,
      provider,
    })),
    { title: 'BuildWise: Choose a model provider', ignoreFocusOut: true },
  );
  return picked?.provider;
}

// One retry covers a brief rate limit; more would leave the learner waiting minutes.
const MAX_RETRIES = 1;

function createMentor({ provider, model, baseURL, apiKey }: Configured): Mentor {
  const timeout = provider.timeoutMs;
  if (provider.id === 'anthropic') {
    const effort = resolveClaudeEffort(vscode.workspace.getConfiguration('buildwise').get<string>('reasoningEffort'));
    return createClaudeMentor(new Anthropic({ apiKey, timeout, maxRetries: MAX_RETRIES }), model, effort);
  }
  const client = new OpenAI({ apiKey: apiKey ?? 'not-needed', baseURL, timeout, maxRetries: MAX_RETRIES });
  const effort = reasoningEffort(provider);
  return createCompatibleMentor(client, {
    model,
    ...(provider.limits && { limits: provider.limits }),
    ...(provider.maxOutputTokens !== undefined && { maxOutputTokens: provider.maxOutputTokens }),
    ...(effort && { reasoningEffort: effort }),
  });
}

/**
 * Times a model list and a one-word reply with the saved settings, so a slow
 * model can be told apart from a slow or blocked connection.
 */
async function testConnection(configured: Configured, log: (line: string) => void): Promise<void> {
  const { provider, model, baseURL, apiKey } = configured;
  const effort = reasoningEffort(provider);
  log(
    `Testing ${model} from ${provider.label}${baseURL ? ` at ${baseURL}` : ''}, reasoning effort ${effort ?? 'not sent'}.`,
  );

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
      ...(effort && { reasoning_effort: effort }),
    });
  });
  const summary =
    listed && replied ? 'The model answered. Details are in Output → BuildWise.' : 'The test found a problem. Details are in Output → BuildWise.';
  void vscode.window.showInformationMessage(summary);
}

function reasoningEffort(provider: Provider) {
  return resolveReasoningEffort(provider, vscode.workspace.getConfiguration('buildwise').get<string>('reasoningEffort'));
}

/** The endpoint to use; null if the learner cancelled. */
async function askBaseURL(provider: Provider, remembered: string | undefined): Promise<string | undefined | null> {
  if (provider.id !== 'custom' && provider.id !== 'ollama') return provider.baseURL;
  const value = await vscode.window.showInputBox({
    title: `BuildWise: ${provider.label} endpoint`,
    prompt: 'The base URL of the OpenAI-compatible API, ending before /chat/completions.',
    value: remembered ?? provider.baseURL ?? '',
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
