import { DEFAULT_MODEL } from './mentor';
import type { ContextLimits } from './prompts';

export type ProviderId = 'gemini' | 'groq' | 'openrouter' | 'ollama' | 'anthropic' | 'custom';

export interface Provider {
  readonly id: ProviderId;
  readonly label: string;
  /** One line shown when choosing a provider. */
  readonly detail: string;
  readonly free: boolean;
  /** OpenAI-compatible endpoint. Unset for Anthropic, which uses its own SDK, and for custom. */
  readonly baseURL?: string;
  readonly keyUrl?: string;
  readonly needsKey: boolean;
  /** Preselected when the provider's live model list includes it. Lists change often. */
  readonly suggestedModel?: string;
  readonly limits?: ContextLimits;
  readonly maxOutputTokens?: number;
  /** How long one request may take before BuildWise gives up. */
  readonly timeoutMs: number;
  /** Sent as reasoning_effort, only where the provider is known to accept it. */
  readonly reasoningEffort?: 'low';
  /** Filters the provider's model list down to models that can chat. */
  readonly isChatModel?: (id: string) => boolean;
}

// Long enough for a thinking model on a busy free tier; short enough to notice a stuck request.
const CLOUD_TIMEOUT_MS = 60_000;

export const PROVIDERS: readonly Provider[] = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    detail: 'Free tier with a Google account and no card. Daily limits apply.',
    free: true,
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    keyUrl: 'https://aistudio.google.com/apikey',
    needsKey: true,
    suggestedModel: 'gemini-3.8-flash',
    timeoutMs: CLOUD_TIMEOUT_MS,
    // Gemini 3 thinks at its default level otherwise, which can take over a minute.
    reasoningEffort: 'low',
    isChatModel: (id) => /^(gemini|gemma)/.test(id) && !/(embedding|image|tts|audio|live)/.test(id),
  },
  {
    id: 'groq',
    label: 'Groq',
    detail: 'Free tier with fast open models. Small per-minute limits, so BuildWise sends less context.',
    free: true,
    baseURL: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    needsKey: true,
    // The free tier allows about 8,000 tokens a minute, input and output together.
    limits: { maxFiles: 80, maxOpenFileChars: 6000, maxRelatedChars: 5000 },
    maxOutputTokens: 3000,
    timeoutMs: CLOUD_TIMEOUT_MS,
    isChatModel: (id) => !/(whisper|tts|orpheus|guard|compound)/.test(id),
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    detail: 'Models marked ":free" cost nothing, with about 50 requests a day.',
    free: true,
    baseURL: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    needsKey: true,
    timeoutMs: CLOUD_TIMEOUT_MS,
    isChatModel: (id) => id.endsWith(':free') && !/(safety|guard)/.test(id),
  },
  {
    id: 'ollama',
    label: 'Ollama',
    detail: 'Runs models on your own computer: free and private, but needs a capable machine.',
    free: true,
    baseURL: 'http://localhost:11434/v1',
    needsKey: false,
    // Local models often run with a small context window.
    limits: { maxFiles: 100, maxOpenFileChars: 8000, maxRelatedChars: 8000 },
    // Models running on a laptop CPU can take minutes.
    timeoutMs: 5 * 60_000,
    isChatModel: (id) => !/embed/.test(id),
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    detail: 'Paid per use.',
    free: false,
    keyUrl: 'https://console.anthropic.com',
    needsKey: true,
    suggestedModel: DEFAULT_MODEL,
    timeoutMs: 2 * 60_000,
    isChatModel: (id) => id.startsWith('claude'),
  },
  {
    id: 'custom',
    label: 'Other OpenAI-compatible API',
    detail: 'Any provider with a Chat Completions endpoint, such as Mistral or Cerebras.',
    free: false,
    needsKey: true,
    timeoutMs: CLOUD_TIMEOUT_MS,
  },
];

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const;
export type ReasoningEffortSetting = 'auto' | (typeof REASONING_EFFORTS)[number];

/**
 * The reasoning_effort to send: the learner's choice, or the provider's
 * preset for "auto". Undefined means send nothing. Claude sets effort per
 * request instead, so the setting does not apply to it.
 */
export function resolveReasoningEffort(
  provider: Provider,
  setting: string | undefined,
): (typeof REASONING_EFFORTS)[number] | undefined {
  if (provider.id === 'anthropic') return undefined;
  const chosen = REASONING_EFFORTS.find((effort) => effort === setting);
  return chosen ?? provider.reasoningEffort;
}

export function findProvider(id: string): Provider | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

/** Chat models from a provider's list, sorted, with the suggested model first. */
export function chatModels(provider: Provider, ids: readonly string[]): string[] {
  // Gemini lists models as "models/<id>" but expects the bare id.
  const names = [...new Set(ids.map((id) => id.replace(/^models\//, '')))];
  const usable = names.filter((id) => provider.isChatModel?.(id) ?? true).sort();
  const suggested = provider.suggestedModel;
  return suggested && usable.includes(suggested) ? [suggested, ...usable.filter((id) => id !== suggested)] : usable;
}
