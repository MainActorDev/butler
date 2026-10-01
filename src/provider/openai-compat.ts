/** OpenAI-compatible chat-completions adapter — plain fetch, typed (plan
 *  Stage 1: no SDK dependency for the provider path). Retries 429/5xx with
 *  exponential backoff; the retry budget is capped by the caller's remaining
 *  wall budget so a hung provider can never eat the session (review F5). */
import {
  DEFAULT_RETRY,
  ProviderError,
  backoffDelay,
  isRetryableStatus,
  type Provider,
  type ProviderConfig,
  type ProviderEvent,
  type ProviderMessage,
  type ProviderResponse,
  type ProviderTool,
  type RetryPolicy,
} from './types.ts';

interface ChatCompletionResponse {
  choices?: Array<{ message?: { role: string; content?: string | null; tool_calls?: ProviderMessage['tool_calls'] }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string } | string;
}

export class OpenAICompatProvider implements Provider {
  readonly model: string;
  private readonly cfg: Required<Pick<ProviderConfig, 'baseUrl' | 'apiKey' | 'model'>> & Pick<ProviderConfig, 'temperature'> & { timeoutMs: number };
  private readonly retry: RetryPolicy;
  private readonly onEvent: ((e: ProviderEvent) => void) | undefined;
  /** test seam: injectable fetch (default global) */
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: ProviderConfig, opts?: { retry?: RetryPolicy; onEvent?: (e: ProviderEvent) => void; fetchImpl?: typeof fetch }) {
    this.cfg = { timeoutMs: 120_000, ...cfg };
    this.model = cfg.model;
    this.retry = opts?.retry ?? DEFAULT_RETRY;
    this.onEvent = opts?.onEvent;
    this.fetchImpl = opts?.fetchImpl ?? fetch;
  }

  async complete(
    messages: ProviderMessage[],
    tools: ProviderTool[],
    opts: { remainingMs: number; signal?: AbortSignal },
  ): Promise<ProviderResponse> {
    const deadline = Date.now() + Math.max(0, opts.remainingMs);
    let attempt = 0;
    let lastErr: ProviderError = new ProviderError('provider failed before first attempt', 'PROVIDER_UNAVAILABLE');

    while (attempt <= this.retry.maxRetries) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ProviderError('wall budget exhausted while calling provider', 'PROVIDER_TIMEOUT');
      // per-call timeout: never exceed both the configured timeout AND remaining wall budget
      const callTimeout = Math.min(this.cfg.timeoutMs, remaining);
      const callSignal = AbortSignal.any([AbortSignal.timeout(callTimeout), ...(opts.signal ? [opts.signal] : [])]);
      attempt += 1;
      this.onEvent?.({ type: 'provider.request', attempt, model: this.model });
      try {
        const res = await this.fetchImpl(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
          body: JSON.stringify({
            model: this.model,
            messages: messages.map((m) => ({
              role: m.role,
              ...(m.content !== undefined ? { content: m.content } : {}),
              ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
              ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
              ...(m.name ? { name: m.name } : {}),
            })),
            ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
            ...(this.cfg.temperature !== undefined ? { temperature: this.cfg.temperature } : {}),
          }),
          signal: callSignal,
        });

        if (res.ok) {
          const body = (await res.json()) as ChatCompletionResponse;
          const choice = body.choices?.[0];
          if (!choice?.message) throw new ProviderError('provider returned no choices', 'PROVIDER_UNAVAILABLE', res.status, false);
          this.onEvent?.({ type: 'provider.response', attempt, promptTokens: body.usage?.prompt_tokens ?? 0, completionTokens: body.usage?.completion_tokens ?? 0 });
          return {
            message: {
              role: 'assistant',
              content: choice.message.content ?? null,
              ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}),
            },
            finishReason: choice.finish_reason ?? null,
            usage: body.usage ? { promptTokens: body.usage.prompt_tokens ?? 0, completionTokens: body.usage.completion_tokens ?? 0 } : null,
          };
        }

        if (!isRetryableStatus(res.status)) {
          const detail = await res.text().catch(() => '');
          throw new ProviderError(`provider rejected request (${res.status}): ${detail.slice(0, 300)}`, 'PROVIDER_BAD_REQUEST', res.status, false);
        }
        lastErr = new ProviderError(`provider ${res.status}`, 'PROVIDER_UNAVAILABLE', res.status, true);
      } catch (err) {
        if (err instanceof ProviderError && !err.retryable) throw err;
        if (err instanceof ProviderError) lastErr = err;
        else if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
          lastErr = new ProviderError(`provider timed out after ${callTimeout}ms`, 'PROVIDER_TIMEOUT', undefined, true);
        } else if (err instanceof Error) {
          lastErr = new ProviderError(`provider unreachable: ${err.message}`, 'PROVIDER_UNAVAILABLE', undefined, true);
        } else {
          lastErr = new ProviderError(`provider failed: ${String(err)}`, 'PROVIDER_UNAVAILABLE', undefined, true);
        }
      }

      // backoff — capped by remaining wall budget (never sleep past the deadline)
      if (attempt > this.retry.maxRetries) break;
      const delay = Math.min(backoffDelay(attempt, this.retry), Math.max(0, deadline - Date.now()));
      if (delay <= 0) break;
      this.onEvent?.({ type: 'provider.retry', attempt, delayMs: delay, reason: lastErr.message });
      await new Promise((r) => setTimeout(r, delay));
    }
    throw lastErr;
  }
}
