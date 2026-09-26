import Anthropic from '@anthropic-ai/sdk';

// The one place the assistant talks to Claude. Server-side only; the API key
// never reaches the browser.
//
// Requests opt into server-side refusal fallbacks ("default" routing) so a
// safety-classifier decline is retried on Anthropic's recommended fallback
// model instead of failing the owner's question.

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export function createClaude({ apiKey, model }) {
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 90_000 });
  return {
    model,
    async create(params) {
      return client.beta.messages.create(Object.assign({ model, betas: [FALLBACK_BETA], fallbacks: 'default' }, params));
    },
  };
}

// Translate SDK errors into something the UI can show, using the SDK's typed
// exception classes rather than message matching.
export function describeClaudeError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'The Anthropic API key was rejected — check ANTHROPIC_API_KEY.';
  if (e instanceof Anthropic.RateLimitError) return 'The AI is rate-limited right now — try again in a minute.';
  if (e instanceof Anthropic.BadRequestError) return 'The AI rejected the request (' + (e.message || 'bad request').slice(0, 160) + ').';
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach the AI service.';
  if (e instanceof Anthropic.APIError) return 'The AI service returned an error (' + (e.status || '?') + ').';
  return null;
}

export function textOf(message) {
  return (message.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}
