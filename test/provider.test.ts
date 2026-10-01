import { describe, expect, it } from 'vitest';
import { OpenAICompatProvider } from '../src/provider/openai-compat.ts';
import { ProviderError } from '../src/provider/types.ts';

/** Injectable-fetch tests: request shape, retry/backoff, timeout, error
 *  classification — zero network (plan Stage 1). */

function res(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const okBody = {
  choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 4 },
};

describe('OpenAICompatProvider', () => {
  it('sends the chat-completions shape (model, messages, tools, auth) and parses the response', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return res(okBody);
    }) as typeof fetch;
    const p = new OpenAICompatProvider({ baseUrl: 'https://gw.example/v1', apiKey: 'k', model: 'm-1' }, { fetchImpl });
    const out = await p.complete([{ role: 'user', content: 'hi' }], [{ type: 'function', function: { name: 't', parameters: {} } }], { remainingMs: 5_000 });
    expect(captured!.url).toBe('https://gw.example/v1/chat/completions');
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer k');
    const body = JSON.parse(captured!.init.body as string) as { model: string; tool_choice: string };
    expect(body.model).toBe('m-1');
    expect(body.tool_choice).toBe('auto');
    expect(out.message.content).toBe('hello');
    expect(out.usage).toEqual({ promptTokens: 12, completionTokens: 4 });
  });

  it('retries 429/5xx with backoff, then succeeds', async () => {
    const statuses: number[] = [];
    const fetchImpl = (async () => {
      const s = statuses.length === 0 ? 429 : statuses.length === 1 ? 503 : 200;
      statuses.push(s);
      return s === 200 ? res(okBody) : res({ error: 'nope' }, s);
    }) as typeof fetch;
    const p = new OpenAICompatProvider(
      { baseUrl: 'https://gw/v1', apiKey: 'k', model: 'm' },
      { fetchImpl, retry: { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 2 } },
    );
    const out = await p.complete([{ role: 'user', content: 'hi' }], [], { remainingMs: 5_000 });
    expect(out.message.content).toBe('hello');
    expect(statuses).toEqual([429, 503, 200]);
  });

  it('4xx (non-429) fails fast — no retry, PROVIDER_BAD_REQUEST', async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls += 1; return res({ error: 'bad key' }, 401); }) as typeof fetch;
    const p = new OpenAICompatProvider({ baseUrl: 'https://gw/v1', apiKey: 'k', model: 'm' }, { fetchImpl, retry: { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 1 } });
    await expect(p.complete([{ role: 'user', content: 'x' }], [], { remainingMs: 5_000 })).rejects.toMatchObject({ code: 'PROVIDER_BAD_REQUEST' });
    expect(calls).toBe(1);
  });

  it('exhausted retries → PROVIDER_UNAVAILABLE', async () => {
    const fetchImpl = (async () => res({}, 500)) as typeof fetch;
    const p = new OpenAICompatProvider({ baseUrl: 'https://gw/v1', apiKey: 'k', model: 'm' }, { fetchImpl, retry: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 1 } });
    await expect(p.complete([{ role: 'user', content: 'x' }], [], { remainingMs: 5_000 })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('hung fetch → per-call timeout → PROVIDER_TIMEOUT; never exceeds remaining wall budget', async () => {
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        const t = setTimeout(() => reject(new Error('should have aborted')), 5_000);
        (init?.signal as AbortSignal).addEventListener('abort', () => { clearTimeout(t); reject(init!.signal!.reason); }, { once: true });
      });
      return res({});
    }) as typeof fetch;
    const t0 = Date.now();
    const p = new OpenAICompatProvider({ baseUrl: 'https://gw/v1', apiKey: 'k', model: 'm', timeoutMs: 120 }, { fetchImpl, retry: { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 2 } });
    const err = await p.complete([{ role: 'user', content: 'x' }], [], { remainingMs: 500 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('PROVIDER_TIMEOUT');
    expect(Date.now() - t0).toBeLessThan(1_000); // retried fast, budget held
  });

  it('network failure (fetch throws) → PROVIDER_UNAVAILABLE after retries', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    const p = new OpenAICompatProvider({ baseUrl: 'https://gw/v1', apiKey: 'k', model: 'm' }, { fetchImpl, retry: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 1 } });
    await expect(p.complete([{ role: 'user', content: 'x' }], [], { remainingMs: 5_000 })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('usage events emitted (observability seam)', async () => {
    const events: string[] = [];
    const fetchImpl = (async () => res(okBody)) as typeof fetch;
    const p = new OpenAICompatProvider({ baseUrl: 'https://gw/v1', apiKey: 'k', model: 'm' }, { fetchImpl, onEvent: (e) => events.push(e.type) });
    await p.complete([{ role: 'user', content: 'x' }], [], { remainingMs: 5_000 });
    expect(events).toEqual(['provider.request', 'provider.response']);
  });
});
