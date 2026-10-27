import type OpenAI from 'openai';
import type { CheckpointPlan } from '../session/session';
import { MentorError } from './errors';
import { type Mentor, PlanSchema, type Review, ReviewSchema } from './mentor';
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
  reviewPrompt,
  solutionPrompt,
  SYSTEM_PROMPT,
} from './prompts';

export interface CompatibleOptions {
  readonly model: string;
  readonly limits?: ContextLimits;
  /** Omit to use the provider's default. Free tiers count it against per-minute token limits. */
  readonly maxOutputTokens?: number;
  /** How long a thinking model may think. Not every provider accepts it, so omit unless known. */
  readonly reasoningEffort?: OpenAI.ReasoningEffort;
}

// Plain JSON in the prompt works across providers; schema-constrained output does not.
const PLAN_FORMAT = `Reply with only a JSON object, no other text, in this shape:
{"checkpoints": [{"title": "...", "description": "..."}]}`;

const REVIEW_FORMAT = `Reply with only a JSON object, no other text, in this shape:
{"passes": true, "feedback": "..."}`;

// Smaller models sometimes wrap or break the JSON; one retry fixes most of it.
const JSON_ATTEMPTS = 2;

/**
 * A mentor for any provider that speaks the OpenAI Chat Completions API:
 * Gemini, Groq, OpenRouter, Ollama and others.
 */
export function createCompatibleMentor(
  client: OpenAI,
  { model, limits = DEFAULT_LIMITS, maxOutputTokens, reasoningEffort }: CompatibleOptions,
): Mentor {
  // Dropped for the rest of the session once the model rejects it, rather than failing every request.
  let effort = reasoningEffort;
  const create = async (messages: OpenAI.ChatCompletionMessageParam[]) => {
    const params = {
      model,
      ...(maxOutputTokens !== undefined && { max_completion_tokens: maxOutputTokens }),
      messages,
    };
    if (!effort) return client.chat.completions.create(params);
    try {
      return await client.chat.completions.create({ ...params, reasoning_effort: effort });
    } catch (error) {
      if (!isEffortRejected(error)) throw error;
      effort = undefined;
      return client.chat.completions.create(params);
    }
  };

  const complete = async (task: string, context: RepositoryContext) => {
    const response = await create([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `${renderRepository(context, limits)}\n\n${task}` },
    ]);
    const choice = response.choices[0];
    if (choice?.finish_reason === 'content_filter') throw new MentorError('refused');
    if (choice?.finish_reason === 'length') throw new MentorError('truncated');
    const text = stripReasoning(choice?.message.content ?? '');
    if (text === '') throw new MentorError('empty');
    return text;
  };

  return {
    async plan(goal, context) {
      for (let attempt = 0; attempt < JSON_ATTEMPTS; attempt++) {
        const plan = parsePlan(await complete(`${planPrompt(goal)}\n\n${PLAN_FORMAT}`, context));
        if (plan) return plan;
      }
      throw new MentorError('malformed');
    },
    async review(session, task, files, context) {
      const prompt = `${reviewPrompt(session, task, files, limits)}\n\n${REVIEW_FORMAT}`;
      for (let attempt = 0; attempt < JSON_ATTEMPTS; attempt++) {
        const review = parseReview(await complete(prompt, context));
        if (review) return review;
      }
      throw new MentorError('malformed');
    },
    hint: (session, level, previousHints, context, failure) =>
      complete(hintPrompt(session, level, previousHints, failure), context),
    solution: (session, context) => complete(solutionPrompt(session), context),
    answer: (session, question, context) => complete(answerPrompt(session, question), context),
    challenge: (session, context) => complete(challengePrompt(session), context),
    explain: (session, report, context) => complete(explainPrompt(session, report), context),
  };
}

/** A 400 that names reasoning, as models without thinking return for reasoning_effort. */
function isEffortRejected(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { status?: unknown }).status === 400 &&
    /reasoning/i.test(error.message)
  );
}

/** The checkpoints in a reply, tolerating code fences or text around the JSON. */
export function parsePlan(text: string): CheckpointPlan[] | undefined {
  const result = PlanSchema.safeParse(parseJsonObject(text));
  return result.success ? result.data.checkpoints : undefined;
}

export function parseReview(text: string): Review | undefined {
  const result = ReviewSchema.safeParse(parseJsonObject(text));
  return result.success ? result.data : undefined;
}

function parseJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Some open models put their reasoning in <think> tags before the answer. */
export function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}
