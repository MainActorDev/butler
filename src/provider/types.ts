/** Provider errors — typed, distinguishable by the loop and callers. */
export class ProviderError extends Error {
  constructor(message: string, readonly code: 'PROVIDER_UNAVAILABLE' | 'PROVIDER_TIMEOUT' | 'PROVIDER_BAD_REQUEST', readonly status?: number, readonly retryable = false) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** One chat message in the provider-neutral shape (OpenAI-compatible roles). */
export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** assistant tool_calls (as returned by the model) */
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  /** tool role: which call this answers */
  tool_call_id?: string;
  /** tool role: optional name for logging */
  name?: string;
}

/** A tool definition as handed to the provider. */
export interface ProviderTool {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

/** A completed model turn. */
export interface ProviderResponse {
  message: ProviderMessage;
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number } | null;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** per-call timeout ms (default 120_000 — plan rev 3, review F5) */
  timeoutMs?: number;
  temperature?: number;
}

/** Retry policy knobs (bounded; the loop's wall budget caps the rest). */
export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxRetries: 3, initialDelayMs: 500, maxDelayMs: 8_000 };

/** Events emitted during a provider call — observability without a logger dep. */
export type ProviderEvent =
  | { type: 'provider.request'; attempt: number; model: string }
  | { type: 'provider.retry'; attempt: number; delayMs: number; reason: string }
  | { type: 'provider.response'; attempt: number; promptTokens: number; completionTokens: number };

/** The provider seam. MockProvider implements this for hermetic tests; the
 *  OpenAI-compatible adapter is the production implementation. */
export interface Provider {
  /** One chat-completions style call with tools. `remainingMs` bounds retries
   *  (retry budget = min(backoff, remaining wall budget) — plan Stage 1). */
  complete(
    messages: ProviderMessage[],
    tools: ProviderTool[],
    opts: { remainingMs: number; signal?: AbortSignal | undefined },
  ): Promise<ProviderResponse>;
  readonly model: string;
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function backoffDelay(attempt: number, policy: RetryPolicy): number {
  const exp = policy.initialDelayMs * 2 ** (attempt - 1);
  const jitter = Math.random() * 0.3 * exp;
  return Math.min(exp + jitter, policy.maxDelayMs);
}
