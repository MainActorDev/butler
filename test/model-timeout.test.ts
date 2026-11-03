/** Per-model call timeout: ModelDef.timeoutMs reaches the http providers the
 *  router builds (before, routed calls always used the 120 s default). */

import { describe, expect, it } from 'vitest';
import { ModelRouter, parseRegistry, type Registry } from '../src/provider/router.ts';

function registry(kind: 'openai' | 'anthropic', timeoutMs?: number): Registry {
  return {
    version: 2,
    defaultCombo: 'default',
    providers: [{ id: 'p', kind, baseUrl: 'https://x.test/v1', apiKeyEnv: 'K' }],
    models: [{ id: 'main', provider: 'p', model: 'm', priority: 1, enabled: true, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }],
    combos: [{ id: 'default', members: ['main'], strategy: 'fallback' }],
  };
}

/** fetch that answers after `answerMs` unless its signal aborts first; records when the first call was aborted */
function slowFetch(answerMs: number): { fetchImpl: typeof fetch; firstAbortMs: () => number | undefined } {
  let first: number | undefined;
  const fetchImpl = ((_u: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const t0 = Date.now();
    const timer = setTimeout(() => resolve(new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } })), answerMs);
    init?.signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      first ??= Date.now() - t0;
      reject(init.signal?.reason instanceof Error ? init.signal.reason : new DOMException('aborted', 'AbortError'));
    });
  })) as unknown as typeof fetch;
  return { fetchImpl, firstAbortMs: () => first };
}

const ask = (r: ModelRouter, remainingMs: number) => r.complete([{ role: 'user', content: 'x' }], [], { remainingMs });

describe('ModelDef.timeoutMs', () => {
  it('cuts a routed openai-compat call at the model timeout, not the 120 s default', async () => {
    const f = slowFetch(60_000);
    const r = new ModelRouter({ env: { K: 'k' }, fetchImpl: f.fetchImpl, retry: { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1 } }, registry('openai', 150));
    await expect(ask(r, 3_000)).rejects.toThrow();
    expect(f.firstAbortMs()).toBeGreaterThanOrEqual(140);
    expect(f.firstAbortMs()).toBeLessThan(1_000);
  });

  it('lets a slow answer through when the model timeout is longer than the wait', async () => {
    const f = slowFetch(150);
    const r = new ModelRouter({ env: { K: 'k' }, fetchImpl: f.fetchImpl }, registry('openai', 2_000));
    const res = await ask(r, 5_000);
    expect(res.message.content).toBe('ok');
    expect(f.firstAbortMs()).toBeUndefined();
  });

  it('cuts a routed anthropic call at the model timeout', async () => {
    const f = slowFetch(60_000);
    const r = new ModelRouter({ env: { K: 'k' }, fetchImpl: f.fetchImpl, retry: { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1 } }, registry('anthropic', 150));
    await expect(ask(r, 3_000)).rejects.toThrow();
    expect(f.firstAbortMs()).toBeLessThan(1_000);
  });

  it('without timeoutMs the call is bounded only by the wall budget (default unchanged)', async () => {
    const f = slowFetch(60_000);
    const r = new ModelRouter({ env: { K: 'k' }, fetchImpl: f.fetchImpl, retry: { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1 } }, registry('openai'));
    await expect(ask(r, 800)).rejects.toThrow();
    expect(f.firstAbortMs()).toBeGreaterThanOrEqual(700);
  });

  it('parseRegistry accepts a positive integer and rejects anything else', () => {
    expect(parseRegistry(JSON.stringify(registry('openai', 300_000))).models[0]?.timeoutMs).toBe(300_000);
    for (const bad of [0, -1, 1.5, '300']) {
      const reg = registry('openai'); (reg.models[0] as unknown as Record<string, unknown>)['timeoutMs'] = bad;
      expect(() => parseRegistry(JSON.stringify(reg))).toThrow(/timeoutMs must be a positive integer/);
    }
  });
});
