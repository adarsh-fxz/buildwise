import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { createSession } from '../session/session';
import { createCompatibleMentor, parsePlan, parseReview, stripReasoning } from './compatible';
import { MentorError } from './errors';

const context = { files: ['src/index.ts'], openFile: { path: 'src/index.ts', content: 'x'.repeat(100) } };
const session = createSession('Add pagination');
const PLAN = { checkpoints: [{ title: 'Read the page param', description: 'From the URL.' }] };

const reply = (content: string | null, finish_reason = 'stop') => ({ choices: [{ finish_reason, message: { content } }] });

function fakeClient(...replies: ReturnType<typeof reply>[]) {
  const create = vi.fn();
  for (const r of replies) create.mockResolvedValueOnce(r);
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  return { client, create };
}

describe('createCompatibleMentor', () => {
  it('sends the system prompt and the repository with the task', async () => {
    const { client, create } = fakeClient(reply('Where does the page come from?'));
    const mentor = createCompatibleMentor(client, { model: 'gemini-3.8-flash' });
    await expect(mentor.hint(session, 1, [], context)).resolves.toBe('Where does the page come from?');
    const params = create.mock.calls[0]?.[0] as OpenAI.ChatCompletionCreateParamsNonStreaming;
    expect(params.model).toBe('gemini-3.8-flash');
    expect(params).not.toHaveProperty('max_completion_tokens');
    expect(params).not.toHaveProperty('reasoning_effort');
    expect(params.messages[0]).toMatchObject({ role: 'system' });
    expect(params.messages[1]?.content).toContain('<repository>');
    expect(params.messages[1]?.content).toContain('level 1 hint');
  });

  it('applies the provider limits to the context and output', async () => {
    const { client, create } = fakeClient(reply('ok'));
    const mentor = createCompatibleMentor(client, {
      model: 'm',
      limits: { maxFiles: 10, maxOpenFileChars: 10 },
      maxOutputTokens: 3000,
      reasoningEffort: 'low',
    });
    await mentor.answer(session, 'Why?', context);
    const params = create.mock.calls[0]?.[0] as OpenAI.ChatCompletionCreateParamsNonStreaming;
    expect(params.max_completion_tokens).toBe(3000);
    expect(params.reasoning_effort).toBe('low');
    expect(params.messages[1]?.content).toContain('Only the first 10 of 100 characters');
  });

  it('reads a plan wrapped in a code fence', async () => {
    const { client } = fakeClient(reply(`Here you go:\n\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``));
    await expect(createCompatibleMentor(client, { model: 'm' }).plan('goal', context)).resolves.toEqual(PLAN.checkpoints);
  });

  it('retries once when the plan is not valid JSON', async () => {
    const { client, create } = fakeClient(reply('Step 1: read the param'), reply(JSON.stringify(PLAN)));
    await expect(createCompatibleMentor(client, { model: 'm' }).plan('goal', context)).resolves.toEqual(PLAN.checkpoints);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry', async () => {
    const { client } = fakeClient(reply('nope'), reply('{"steps": []}'));
    await expect(createCompatibleMentor(client, { model: 'm' }).plan('goal', context)).rejects.toThrow(
      new MentorError('malformed'),
    );
  });

  it.each([
    ['content_filter', 'refused'],
    ['length', 'truncated'],
  ] as const)('turns finish reason %s into a %s error', async (finish, kind) => {
    const { client } = fakeClient(reply('partial', finish));
    await expect(createCompatibleMentor(client, { model: 'm' }).solution(session, context)).rejects.toThrow(
      new MentorError(kind),
    );
  });

  it('treats a reply that is only reasoning as empty', async () => {
    const { client } = fakeClient(reply('<think>hmm</think>'));
    await expect(createCompatibleMentor(client, { model: 'm' }).challenge(session, context)).rejects.toThrow(
      new MentorError('empty'),
    );
  });
});

describe('review', () => {
  const files = [{ path: 'src/lib/utils.ts', content: 'export function isEven() {}' }];

  it('reads the verdict, retrying once on bad JSON', async () => {
    const { client, create } = fakeClient(reply('looks fine'), reply('{"passes": false, "feedback": "It never returns."}'));
    await expect(createCompatibleMentor(client, { model: 'm' }).review(session, 'Define isEven', files, context)).resolves.toEqual({
      passes: false,
      feedback: 'It never returns.',
    });
    expect(create).toHaveBeenCalledTimes(2);
    const params = create.mock.calls[0]?.[0] as OpenAI.ChatCompletionCreateParamsNonStreaming;
    expect(params.messages[1]?.content).toContain('export function isEven() {}');
  });
});

describe('parseReview', () => {
  it('needs both fields', () => {
    expect(parseReview('{"passes": true}')).toBeUndefined();
    expect(parseReview('```json\n{"passes": true, "feedback": "Works."}\n```')).toEqual({ passes: true, feedback: 'Works.' });
  });
});

describe('parsePlan', () => {
  it('rejects JSON in the wrong shape', () => {
    expect(parsePlan('{"checkpoints": [{"title": "x"}]}')).toBeUndefined();
    expect(parsePlan('no json')).toBeUndefined();
  });
});

describe('stripReasoning', () => {
  it('removes think blocks and keeps the answer', () => {
    expect(stripReasoning('<think>\nThe user wants…\n</think>\n\nAsk where the page comes from.')).toBe(
      'Ask where the page comes from.',
    );
  });
});
