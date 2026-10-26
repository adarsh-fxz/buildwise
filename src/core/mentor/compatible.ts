import type OpenAI from 'openai';
import type { CheckpointPlan } from '../session/session';
import { MentorError } from './errors';
import { type Mentor, PlanSchema } from './mentor';
import {
  answerPrompt,
  challengePrompt,
  type ContextLimits,
  DEFAULT_LIMITS,
  explainPrompt,
  hintPrompt,
  planPrompt,
  renderRepository,
  type RepositoryContext,
  solutionPrompt,
  SYSTEM_PROMPT,
} from './prompts';

export interface CompatibleOptions {
  readonly model: string;
  readonly limits?: ContextLimits;
  /** Omit to use the provider's default. Free tiers count it against per-minute token limits. */
  readonly maxOutputTokens?: number;
}

// Plain JSON in the prompt works across providers; schema-constrained output does not.
const PLAN_FORMAT = `Reply with only a JSON object, no other text, in this shape:
{"checkpoints": [{"title": "...", "description": "..."}]}`;

const PLAN_ATTEMPTS = 2;

/**
 * A mentor for any provider that speaks the OpenAI Chat Completions API:
 * Gemini, Groq, OpenRouter, Ollama and others.
 */
export function createCompatibleMentor(
  client: OpenAI,
  { model, limits = DEFAULT_LIMITS, maxOutputTokens }: CompatibleOptions,
): Mentor {
  const complete = async (task: string, context: RepositoryContext) => {
    const response = await client.chat.completions.create({
      model,
      ...(maxOutputTokens !== undefined && { max_completion_tokens: maxOutputTokens }),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `${renderRepository(context, limits)}\n\n${task}` },
      ],
    });
    const choice = response.choices[0];
    if (choice?.finish_reason === 'content_filter') throw new MentorError('refused');
    if (choice?.finish_reason === 'length') throw new MentorError('truncated');
    const text = stripReasoning(choice?.message.content ?? '');
    if (text === '') throw new MentorError('empty');
    return text;
  };

  return {
    async plan(goal, context) {
      // Smaller models sometimes wrap or break the JSON; one retry fixes most of it.
      for (let attempt = 0; attempt < PLAN_ATTEMPTS; attempt++) {
        const plan = parsePlan(await complete(`${planPrompt(goal)}\n\n${PLAN_FORMAT}`, context));
        if (plan) return plan;
      }
      throw new MentorError('malformed');
    },
    hint: (session, level, previousHints, context) => complete(hintPrompt(session, level, previousHints), context),
    solution: (session, context) => complete(solutionPrompt(session), context),
    answer: (session, question, context) => complete(answerPrompt(session, question), context),
    challenge: (session, context) => complete(challengePrompt(session), context),
    explain: (session, report, context) => complete(explainPrompt(session, report), context),
  };
}

/** The checkpoints in a reply, tolerating code fences or text around the JSON. */
export function parsePlan(text: string): CheckpointPlan[] | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) return undefined;
  try {
    const result = PlanSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
    return result.success ? result.data.checkpoints : undefined;
  } catch {
    return undefined;
  }
}

/** Some open models put their reasoning in <think> tags before the answer. */
export function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}
