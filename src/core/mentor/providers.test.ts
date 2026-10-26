import { describe, expect, it } from 'vitest';
import { chatModels, findProvider, PROVIDERS } from './providers';

const provider = (id: string) => {
  const found = findProvider(id);
  if (!found) throw new Error(`No provider ${id}`);
  return found;
};

describe('PROVIDERS', () => {
  it('has a key page for every provider that needs a key, except custom ones', () => {
    for (const p of PROVIDERS.filter((p) => p.needsKey && p.id !== 'custom')) {
      expect(p.keyUrl, p.id).toMatch(/^https:\/\//);
    }
  });

  it('lists the free providers first', () => {
    const firstPaid = PROVIDERS.findIndex((p) => !p.free);
    expect(PROVIDERS.slice(firstPaid).every((p) => !p.free)).toBe(true);
  });
});

describe('chatModels', () => {
  it('strips Gemini model prefixes, drops non-chat models and puts the suggestion first', () => {
    const ids = [
      'models/gemini-embedding-001',
      'models/gemini-3.5-flash-lite',
      'models/gemini-2.5-flash-image',
      'models/gemini-3.8-flash',
      'models/gemma-4-31b-it',
    ];
    expect(chatModels(provider('gemini'), ids)).toEqual(['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemma-4-31b-it']);
  });

  it('keeps only free OpenRouter models', () => {
    const ids = ['cohere/north-mini-code:free', 'anthropic/claude-opus-5-5', 'nvidia/nemotron-3.5-content-safety:free'];
    expect(chatModels(provider('openrouter'), ids)).toEqual(['cohere/north-mini-code:free']);
  });

  it('drops speech and guard models on Groq', () => {
    const ids = ['openai/gpt-oss-120b', 'whisper-large-v3', 'openai/gpt-oss-safeguard-20b', 'groq/compound', 'qwen/qwen3.8-27b'];
    expect(chatModels(provider('groq'), ids)).toEqual(['openai/gpt-oss-120b', 'qwen/qwen3.8-27b']);
  });

  it('works without a suggestion or the suggested model', () => {
    expect(chatModels(provider('ollama'), ['qwen3:8b', 'nomic-embed-text', 'llama3.3'])).toEqual(['llama3.3', 'qwen3:8b']);
    expect(chatModels(provider('custom'), ['b', 'a', 'a'])).toEqual(['a', 'b']);
  });
});
