import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export class MentorError extends Error {
  constructor(readonly kind: 'refused' | 'truncated' | 'empty' | 'malformed') {
    super(`The model response was ${kind}`);
    this.name = 'MentorError';
  }
}

const SETUP_HINT = 'Run "BuildWise: Set Up Model Provider" to change it.';

/** A message the learner can act on, whichever provider failed. */
export function describeError(error: unknown): string {
  if (error instanceof MentorError) {
    return {
      refused: 'The model declined to answer that. Try rephrasing.',
      truncated: 'The answer was too long and got cut off. Try again.',
      empty: 'The model returned nothing usable. Try again.',
      malformed: 'The model did not return the plan in the expected format. Try again, or pick a stronger model.',
    }[error.kind];
  }
  if (error instanceof Anthropic.AuthenticationError || error instanceof OpenAI.AuthenticationError) {
    return `Your API key was rejected. ${SETUP_HINT}`;
  }
  if (error instanceof Anthropic.NotFoundError || error instanceof OpenAI.NotFoundError) {
    return `The provider does not recognise this model. ${SETUP_HINT}`;
  }
  if (error instanceof Anthropic.RateLimitError || error instanceof OpenAI.RateLimitError) {
    return 'The provider is limiting requests. Free tiers allow only a few per minute, so wait a minute and try again.';
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError || error instanceof OpenAI.APIConnectionTimeoutError) {
    return 'The model took too long to answer. Free tiers can be slow when busy: try again, or choose a faster model.';
  }
  if (error instanceof Anthropic.APIConnectionError || error instanceof OpenAI.APIConnectionError) {
    return 'Could not reach the model provider. Check your connection, or that Ollama is running if you use it.';
  }
  if (error instanceof Anthropic.APIError || error instanceof OpenAI.APIError) {
    return `The model provider returned an error: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
