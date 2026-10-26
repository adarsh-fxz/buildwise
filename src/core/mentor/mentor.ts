import type Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { CheckReport } from '../checks/report';
import type { CheckpointPlan, Session } from '../session/session';
import {
  answerPrompt,
  challengePrompt,
  explainPrompt,
  hintPrompt,
  planPrompt,
  renderRepository,
  type RepositoryContext,
  solutionPrompt,
  SYSTEM_PROMPT,
} from './prompts';
import { MentorError } from './errors';

/** Generates the words. Whether a hint or reveal is allowed is the session's decision, not the mentor's. */
export interface Mentor {
  plan(goal: string, context: RepositoryContext): Promise<CheckpointPlan[]>;
  hint(session: Session, level: number, previousHints: readonly string[], context: RepositoryContext): Promise<string>;
  solution(session: Session, context: RepositoryContext): Promise<string>;
  answer(session: Session, question: string, context: RepositoryContext): Promise<string>;
  /** A related task for the independent check. */
  challenge(session: Session, context: RepositoryContext): Promise<string>;
  /** What a failed check means, without the fix. */
  explain(session: Session, report: CheckReport, context: RepositoryContext): Promise<string>;
}

export const DEFAULT_MODEL = 'claude-opus-5-5';

export const PlanSchema = z.object({
  checkpoints: z.array(z.object({ title: z.string(), description: z.string() })),
});

type Effort = 'low' | 'medium';

export function createClaudeMentor(client: Anthropic, model: string = DEFAULT_MODEL): Mentor {
  const request = (task: string, context: RepositoryContext, effort: Effort) =>
    ({
      model,
      max_tokens: 16000,
      // On a safety decline, the API retries on the model Anthropic recommends for that category.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM_PROMPT,
      output_config: { effort },
      messages: [
        {
          role: 'user',
          content: [
            // The repository rarely changes between requests in a session, so cache it.
            { type: 'text', text: renderRepository(context), cache_control: { type: 'ephemeral' } },
            { type: 'text', text: task },
          ],
        },
      ],
    }) satisfies Anthropic.Beta.MessageCreateParamsNonStreaming;

  const text = async (task: string, context: RepositoryContext, effort: Effort) => {
    const response = await client.beta.messages.create(request(task, context, effort));
    checkStop(response.stop_reason);
    const output = response.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('')
      .trim();
    if (output === '') {
      throw new MentorError('empty');
    }
    return output;
  };

  return {
    async plan(goal, context) {
      const params = request(planPrompt(goal), context, 'medium');
      const response = await client.beta.messages.parse({
        ...params,
        output_config: { ...params.output_config, format: betaZodOutputFormat(PlanSchema) },
      });
      checkStop(response.stop_reason);
      if (!response.parsed_output) {
        throw new MentorError('empty');
      }
      return response.parsed_output.checkpoints;
    },
    hint: (session, level, previousHints, context) =>
      text(hintPrompt(session, level, previousHints), context, 'low'),
    solution: (session, context) => text(solutionPrompt(session), context, 'medium'),
    answer: (session, question, context) => text(answerPrompt(session, question), context, 'low'),
    challenge: (session, context) => text(challengePrompt(session), context, 'low'),
    explain: (session, report, context) => text(explainPrompt(session, report), context, 'low'),
  };
}

function checkStop(reason: Anthropic.Beta.BetaStopReason | null): void {
  if (reason === 'refusal') throw new MentorError('refused');
  if (reason === 'max_tokens') throw new MentorError('truncated');
}
