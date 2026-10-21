import { describe, expect, it } from 'vitest';
import { MockProvider, type ScriptedTurn } from '../src/provider/mock.ts';
import { ProviderError, type Provider, type ProviderMessage, type ProviderResponse, type ProviderTool } from '../src/provider/types.ts';
import { runLoop, LoopError } from '../src/loop.ts';

/** chat-reliability F3: the loop classifies failures by actual cause/signal —
 *  a permanent provider rejection (400/auth) must NEVER surface as
 *  BUDGET_EXCEEDED (which the transport treats as a resumable pause).
 *  Matrix mirrored from the isolated classifier probe, here on the REAL loop. */

type Opts = Parameters<Provider['complete']>[2];

const toolCall = (i: number): ScriptedTurn => ({
  kind: 'assistant',
  content: null,
  toolCalls: [{ id: `c${i}`, type: 'function', function: { name: 'noop', arguments: '{}' } }],
});

const noopTool = {
  name: 'noop',
  description: 'n',
  parameters: { type: 'object', properties: {} },
  execute: async () => 'observation',
};

class ThrowingProvider implements Provider {
  readonly model = 'throwing';
  calls = 0;
  constructor(private readonly make: () => unknown) {}
  async complete(_m: ProviderMessage[], _t: ProviderTool[], _o: Opts): Promise<ProviderResponse> {
    this.calls += 1;
    throw this.make();
  }
}

/** sleeps, then answers; optionally ignores abort to model a provider that
 *  resolves normally AFTER the caller aborted (post-return guard twin). */
class SleepyProvider implements Provider {
  readonly model = 'sleepy';
  calls = 0;
  constructor(private readonly ms: number, private readonly ignoreAbort = false) {}
  async complete(_m: ProviderMessage[], _t: ProviderTool[], o: Opts): Promise<ProviderResponse> {
    this.calls += 1;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, this.ms);
      if (!this.ignoreAbort) o.signal?.addEventListener('abort', () => { clearTimeout(t); reject(o.signal!.reason); }, { once: true });
    });
    return { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 } };
  }
}

const expectLoopError = async (fn: () => Promise<unknown>) => {
  try { await fn(); expect.unreachable('runLoop should have thrown'); }
  catch (err) { expect(err).toBeInstanceOf(LoopError); return err as LoopError; }
};

describe('F3 — provider failures keep their own classification', () => {
  it('permanent 400 surfaces PROVIDER_BAD_REQUEST, not BUDGET_EXCEEDED', async () => {
    const p = new ThrowingProvider(() => new ProviderError('bad request', 'PROVIDER_BAD_REQUEST', 400));
    const err = await expectLoopError(() => runLoop('s', 'u', { provider: p, tools: [] }));
    expect(err.code).toBe('PROVIDER_BAD_REQUEST');
    expect(err.cause).toBe('provider');
    expect(err.status).toBe(400);
    expect(err.message).toContain('PROVIDER_BAD_REQUEST');
  });

  it('PROVIDER_UNAVAILABLE passes through unchanged', async () => {
    const p = new ThrowingProvider(() => new ProviderError('upstream down', 'PROVIDER_UNAVAILABLE', 503, true));
    const err = await expectLoopError(() => runLoop('s', 'u', { provider: p, tools: [] }));
    expect(err.code).toBe('PROVIDER_UNAVAILABLE');
    expect(err.cause).toBe('provider');
  });

  it('unattributed TimeoutError (wall NOT expired, caller NOT aborted) → PROVIDER_TIMEOUT', async () => {
    const raw = new Error('socket stale');
    raw.name = 'TimeoutError';
    const p = new ThrowingProvider(() => raw);
    const err = await expectLoopError(() => runLoop('s', 'u', { provider: p, tools: [], budget: { wallMs: 60_000 } }));
    expect(err.code).toBe('PROVIDER_TIMEOUT');
    expect(err.cause).toBe('provider');
  });

  it('unknown provider exception → PROVIDER_FAILED', async () => {
    const p = new ThrowingProvider(() => new Error('socket exploded'));
    const err = await expectLoopError(() => runLoop('s', 'u', { provider: p, tools: [] }));
    expect(err.code).toBe('PROVIDER_FAILED');
    expect(err.cause).toBe('provider');
  });
});

describe('F3 — genuine loop limits stay BUDGET_EXCEEDED with an explicit cause', () => {
  it('hop exhaustion → budget-hop', async () => {
    const p = new MockProvider([toolCall(0)]);
    const err = await expectLoopError(() => runLoop('s', 'u', { provider: p, tools: [noopTool], budget: { maxHops: 2 } }));
    expect(err.code).toBe('BUDGET_EXCEEDED');
    expect(err.cause).toBe('budget-hop');
  });

  it('wall expiry during a hung provider call → budget-wall (loop-owned deadline)', async () => {
    const p = new MockProvider([{ kind: 'hang', ms: 30_000 }]);
    const err = await expectLoopError(() => runLoop('s', 'u', { provider: p, tools: [], budget: { wallMs: 50 } }));
    expect(err.code).toBe('BUDGET_EXCEEDED');
    expect(err.cause).toBe('budget-wall');
  });

  it('hard token cap → budget-token', async () => {
    const p = new MockProvider([{ kind: 'assistant', content: null, toolCalls: [{ id: 'a', type: 'function', function: { name: 'noop', arguments: '{}' } }], usage: { promptTokens: 500, completionTokens: 500 } }]);
    const err = await expectLoopError(() => runLoop('s', 'u', { provider: p, tools: [noopTool], budget: { maxTokens: 100 }, hardTokenCap: true }));
    expect(err.code).toBe('BUDGET_EXCEEDED');
    expect(err.cause).toBe('budget-token');
  });
});

describe('F3 — explicit Stop beats everything', () => {
  it('caller abort before the loop starts → ABORTED/caller-abort', async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new SleepyProvider(1);
    const err = await expectLoopError(() => runLoop('s', 'u', { provider: p, tools: [], signal: ac.signal }));
    expect(err.code).toBe('ABORTED');
    expect(err.cause).toBe('caller-abort');
    expect(p.calls).toBe(0);
  });

  it('caller abort mid-provider-call → ABORTED (not a provider timeout)', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const p = new SleepyProvider(10_000);
    const err = await expectLoopError(() => runLoop('s', 'u', { provider: p, tools: [], signal: ac.signal, budget: { wallMs: 60_000 } }));
    expect(err.code).toBe('ABORTED');
    expect(err.cause).toBe('caller-abort');
  });

  it('provider resolving NORMALLY after caller abort is still ABORTED (post-return guard)', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const p = new SleepyProvider(60, true); // ignores the signal, resolves anyway
    const err = await expectLoopError(() => runLoop('s', 'u', { provider: p, tools: [], signal: ac.signal, budget: { wallMs: 60_000 } }));
    expect(err.code).toBe('ABORTED');
    expect(err.cause).toBe('caller-abort');
  });
});

describe('F3 — ordinary success is untouched', () => {
  it('a normal provider call bypasses classification entirely', async () => {
    const p = new SleepyProvider(5);
    const result = await runLoop('s', 'u', { provider: p, tools: [], budget: { wallMs: 60_000 } });
    expect(result.answer).toBe('ok');
    expect(p.calls).toBe(1);
  });
});
