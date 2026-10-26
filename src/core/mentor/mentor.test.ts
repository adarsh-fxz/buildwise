import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { createSession } from '../session/session';
import { createClaudeMentor, DEFAULT_MODEL, describeError, MentorError } from './mentor';

const context = { files: ['src/index.ts'] };
const session = createSession('Add pagination');

function fakeClient(response: { stop_reason: string; content?: unknown[]; parsed_output?: unknown }) {
  const create = vi.fn().mockResolvedValue({ content: [], ...response });
  const parse = vi.fn().mockResolvedValue({ content: [], ...response });
  const client = { beta: { messages: { create, parse } } } as unknown as Anthropic;
  return { client, create, parse };
}

const textResponse = (...texts: string[]) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'thinking', thinking: '' }, ...texts.map((text) => ({ type: 'text', text }))],
});

describe('createClaudeMentor', () => {
  it('returns the text of a hint and ignores thinking blocks', async () => {
    const { client } = fakeClient(textResponse('Where does ', 'the page come from?'));
    await expect(createClaudeMentor(client).hint(session, 1, [], context)).resolves.toBe(
      'Where does the page come from?',
    );
  });

  it('sends the model, low effort for hints, the fallback opt-in and a cached repository block', async () => {
    const { client, create } = fakeClient(textResponse('ok'));
    await createClaudeMentor(client).hint(session, 1, [], context);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: DEFAULT_MODEL,
        output_config: { effort: 'low' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      }),
    );
    const [repository, task] = (create.mock.calls[0]?.[0] as Anthropic.Beta.MessageCreateParams).messages[0]
      ?.content as Anthropic.Beta.BetaTextBlockParam[];
    expect(repository).toMatchObject({ cache_control: { type: 'ephemeral' } });
    expect(repository?.text).toContain('<repository>');
    expect(task?.text).toContain('level 1 hint');
  });

  it('uses the configured model', async () => {
    const { client, create } = fakeClient(textResponse('ok'));
    await createClaudeMentor(client, 'claude-sonnet-5-5').answer(session, 'Why?', context);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-sonnet-5-5' }));
  });

  it('returns the checkpoints of a parsed plan', async () => {
    const checkpoints = [{ title: 'Read the page param', description: 'From the URL.' }];
    const { client, parse } = fakeClient({ stop_reason: 'end_turn', parsed_output: { checkpoints } });
    await expect(createClaudeMentor(client).plan('Add pagination', context)).resolves.toEqual(checkpoints);
    const params = parse.mock.calls[0]?.[0] as { output_config: { effort: string; format: unknown } };
    expect(params.output_config.effort).toBe('medium');
    expect(params.output_config.format).toBeDefined();
  });

  it.each([
    ['refusal', 'refused'],
    ['max_tokens', 'truncated'],
  ] as const)('turns a %s stop into a %s error', async (stop_reason, kind) => {
    const { client } = fakeClient({ stop_reason, content: [{ type: 'text', text: 'partial' }] });
    await expect(createClaudeMentor(client).solution(session, context)).rejects.toThrow(new MentorError(kind));
  });

  it('treats an empty answer or plan as an error', async () => {
    const empty = fakeClient({ stop_reason: 'end_turn', content: [], parsed_output: null });
    await expect(createClaudeMentor(empty.client).answer(session, 'Why?', context)).rejects.toThrow(
      new MentorError('empty'),
    );
    await expect(createClaudeMentor(empty.client).plan('goal', context)).rejects.toThrow(new MentorError('empty'));
  });
});

describe('challenge', () => {
  it('asks for a follow-up task at low effort', async () => {
    const { client, create } = fakeClient(textResponse('Add a page size selector.'));
    await expect(createClaudeMentor(client).challenge(session, context)).resolves.toBe('Add a page size selector.');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ output_config: { effort: 'low' } }));
  });
});

describe('describeError', () => {
  it('explains mentor errors and passes other messages through', () => {
    expect(describeError(new MentorError('refused'))).toBe('The model declined to answer that. Try rephrasing.');
    expect(describeError(new Error('socket hang up'))).toBe('socket hang up');
    expect(describeError('odd')).toBe('odd');
  });
});
