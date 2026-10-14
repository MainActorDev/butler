/** ModelRouter tests (plan 20261014T084923Z): registry parsing, fallback
 *  chains, no-fallback-after-delta, unknown ids, reload seam, health,
 *  anthropic adapter fixtures, secret hygiene. */

import { describe, expect, it } from 'vitest';
import { ModelRouter, parseRegistry, legacyRegistry, AnthropicProvider, type Registry } from '../src/provider/router.ts';
import { ProviderError, type Provider, type ProviderMessage, type ProviderResponse, type ProviderTool } from '../src/provider/types.ts';

const REG: Registry = {
  version: 1,
  defaultCombo: 'auto',
  models: [
    { id: 'a', kind: 'mock', model: 'model-a', apiKeyEnv: 'K_A', priority: 1, enabled: true },
    { id: 'b', kind: 'mock', model: 'model-b', apiKeyEnv: 'K_B', priority: 2, enabled: true },
    { id: 'off', kind: 'mock', model: 'model-off', apiKeyEnv: 'K_C', priority: 1, enabled: false },
  ],
  combos: [
    { id: 'auto', members: ['a', 'b'], strategy: 'fallback' },
    { id: 'solo', members: ['b'], strategy: 'fallback' },
  ],
};

/** flaky provider: fails N calls then succeeds */
function flaky(fails: number, tag: string): Provider {
  let n = 0;
  return {
    model: tag,
    async complete(_m: ProviderMessage[], _t: ProviderTool[], opts: { remainingMs: number; onDelta?: (d: string) => void }): Promise<ProviderResponse> {
      n += 1;
      if (n <= fails) throw new ProviderError(`${tag} fail ${n}`, 'PROVIDER_UNAVAILABLE', 503, true);
      opts.onDelta?.(`${tag}-ok `);
      return { message: { role: 'assistant', content: `${tag}-answer` }, finishReason: 'stop', usage: null };
    },
  };
}

/** a provider that emits a delta THEN fails (must NOT fall over) */
function deltaThenFail(): Provider {
  return {
    model: 'dying',
    async complete(_m: ProviderMessage[], _t: ProviderTool[], opts: { remainingMs: number; onDelta?: (d: string) => void }): Promise<ProviderResponse> {
      opts.onDelta?.('partial ');
      throw new ProviderError('died mid-stream', 'PROVIDER_UNAVAILABLE', 500, true);
    },
  };
}

function routerWith(overrides: { a?: Provider; b?: Provider }, reg: Registry = REG): ModelRouter {
  const r = new ModelRouter({ env: {} }, reg);
  // inject providers directly via the cache
  const providers = (r as unknown as { providers: Map<string, Provider> }).providers;
  if (overrides.a) providers.set('a', overrides.a);
  if (overrides.b) providers.set('b', overrides.b);
  return r;
}

describe('registry parsing', () => {
  it('parses a valid registry; rejects unknown combo members', () => {
    expect(parseRegistry(JSON.stringify(REG)).models.length).toBe(3);
    const bad = { ...REG, combos: [{ id: 'x', members: ['nope'], strategy: 'fallback' as const }] };
    expect(() => parseRegistry(JSON.stringify(bad))).toThrow(/unknown model nope/);
  });

  it('SECRET HYGIENE: serialized registry contains env NAMES, never values', () => {
    const json = JSON.stringify(REG);
    expect(json).toContain('K_A');
    expect(json).not.toMatch(/sk-[a-z0-9]/i);
  });

  it('legacy single-model env maps to a default registry', () => {
    const r = legacyRegistry({ BUTLER_PROVIDER: 'claude-cli', BUTLER_MODEL: 'glm-5.3-flash' });
    expect(r?.models[0]?.kind).toBe('claude-cli');
    expect(r?.defaultCombo).toBe('default');
    expect(legacyRegistry({})).toBeNull();
  });
});

describe('fallback chains', () => {
  it('member-1 exhausted → advances to member-2 (Portkey semantics)', async () => {
    const r = routerWith({ a: flaky(99, 'A'), b: flaky(0, 'B') });
    const res = await r.complete([{ role: 'user', content: 'x' }], [], { remainingMs: 30_000 });
    expect(res.message.content).toBe('B-answer'); // A failed all retries, B served
    const h = Object.fromEntries(r.health().map((x) => [x.id, x]));
    expect(h['a']!.failed).toBeGreaterThan(0);
    expect(h['b']!.ok).toBe(1);
  }, 20_000);

  it('retryable error retries the SAME member before advancing', async () => {
    const r = routerWith({ a: flaky(1, 'A'), b: flaky(0, 'B') }); // A fails once then works
    const res = await r.complete([{ role: 'user', content: 'x' }], [], { remainingMs: 30_000 });
    expect(res.message.content).toBe('A-answer'); // recovered in-member
  }, 20_000);

  it('NO fallback after the first emitted delta — the error surfaces instead', async () => {
    const r = routerWith({ a: deltaThenFail(), b: flaky(0, 'B') });
    const deltas: string[] = [];
    await expect(r.complete([{ role: 'user', content: 'x' }], [], { remainingMs: 30_000, onDelta: (d) => deltas.push(d) }))
      .rejects.toThrow(/died mid-stream/);
    expect(deltas).toEqual(['partial ']); // user saw A's tokens; B never ran
  });

  it('unknown model/combo → PROVIDER_BAD_REQUEST with the catalog in the message', () => {
    const r = routerWith({});
    // chain() resolves EAGERLY at route() — the error carries the catalog
    expect(() => r.route('nope')).toThrow(/unknown or disabled model\/combo.*a\(on\), b\(on\)/);
  });

  it('disabled members are skipped; disabled-only chain → error', () => {
    const r = routerWith({}, REG);
    expect(() => r.chain('auto')).not.toThrow(); // a,b enabled
    const offOnly = new ModelRouter({ env: {} }, { ...REG, combos: [{ id: 'alloff', members: ['off'], strategy: 'fallback' }] });
    expect(() => offOnly.chain('alloff')).toThrow(/off\(off\)/);
  });

  it('reload swaps the registry for the NEXT turn (PR3)', async () => {
    const r = routerWith({ a: flaky(0, 'A'), b: flaky(0, 'B') });
    const first = await r.complete([{ role: 'user', content: 'x' }], [], { remainingMs: 30_000 });
    expect(first.message.content).toBe('A-answer');
    // rewrite: default combo now serves B only
    r.reload({ ...REG, defaultCombo: 'solo' });
    const providers = (r as unknown as { providers: Map<string, Provider> }).providers;
    providers.set('b', flaky(0, 'B')); // reload clears the provider cache by design
    const second = await r.complete([{ role: 'user', content: 'x' }], [], { remainingMs: 30_000 });
    expect(second.message.content).toBe('B-answer');
  });

  it('route events expose which model served each attempt', async () => {
    const events: Array<{ type: string; model: string; outcome?: string }> = [];
    const r = routerWith({ a: flaky(99, 'A'), b: flaky(0, 'B') }, REG);
    (r as unknown as { opts: { onEvent?: (e: never) => void } }).opts.onEvent = (e) => { events.push(e as never); };
    await r.complete([{ role: 'user', content: 'x' }], [], { remainingMs: 60_000 });
    const starts = events.filter((e) => e.type === 'provider.route' && e.outcome === 'start');
    expect(starts.some((e) => e.model === 'a')).toBe(true);
    expect(starts.some((e) => e.model === 'b')).toBe(true);
  }, 20_000);
});

describe('AnthropicProvider (recorded-fixture style)', () => {
  function sseResponse(lines: string[]): Response {
    const body = lines.map((l) => `data: ${l}`).join('\n\n') + '\n\ndata: [DONE]\n\n';
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }

  it('streams text deltas, accumulates tool_use, maps usage', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'cases_list' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"limit":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '5}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
    ];
    const fetchImpl = (async () => sseResponse(events.map((e) => JSON.stringify(e)))) as unknown as typeof fetch;
    const p = new AnthropicProvider({ baseUrl: 'https://x.test', apiKey: 'k', model: 'claude-x' }, { fetchImpl });
    const deltas: string[] = [];
    const res = await p.complete([{ role: 'user', content: 'hi' }], [], { remainingMs: 5000, onDelta: (d) => deltas.push(d) });
    expect(res.message.content).toBe('Hello world');
    expect(deltas).toEqual(['Hello', ' world']);
    expect(res.message.tool_calls?.[0]?.function.name).toBe('cases_list');
    expect(res.message.tool_calls?.[0]?.function.arguments).toBe('{"limit":5}');
    expect(res.usage).toEqual({ promptTokens: 10, completionTokens: 7 });
    expect(res.finishReason).toBe('tool_use');
  });

  it('maps OpenAI-shape messages → Anthropic body (system top-level, tool_result as user)', async () => {
    let captured: Record<string, unknown> | null = null;
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([JSON.stringify({ type: 'message_start' }), JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }), JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }), JSON.stringify({ type: 'content_block_stop', index: 0 })]);
    }) as unknown as typeof fetch;
    const p = new AnthropicProvider({ baseUrl: 'https://x.test', apiKey: 'k', model: 'm' }, { fetchImpl });
    await p.complete([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', content: 'result', tool_call_id: 't1' },
    ], [], { remainingMs: 5000 });
    expect(captured?.['system']).toBe('be brief');
    const msgs = (captured as Record<string, unknown> | null)?.['messages'] as Array<{ role: string; content: unknown }>;
    expect(msgs[1]?.content).toEqual([{ type: 'tool_use', id: 't1', name: 'f', input: {} }]);
    expect((msgs[2]?.content as Array<{ type: string }>)[0]?.type).toBe('tool_result');
  });

  it('non-retryable HTTP status → PROVIDER_UNAVAILABLE with retryable=false', async () => {
    const fetchImpl = (async () => new Response('bad request', { status: 400 })) as unknown as typeof fetch;
    const p = new AnthropicProvider({ baseUrl: 'https://x.test', apiKey: 'k', model: 'm' }, { fetchImpl });
    await expect(p.complete([{ role: 'user', content: 'x' }], [], { remainingMs: 5000 })).rejects.toThrow(/anthropic 400/);
  });
});

describe('transport threading (review PR2 — the picker must not be a silent no-op)', () => {
  it('resolveModel routes different body.model values to different providers', async () => {
    const { registerConversationApi } = await import('../src/transport/conversation.ts');
    const Fastify = (await import('fastify')).default;
    const Database = (await import('better-sqlite3')).default;
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'route-'));
    const db = new Database(join(tmp, 't.db'));
    db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, parent_session_id TEXT, depth INTEGER, user_id TEXT, title TEXT, status TEXT, created_at INTEGER, updated_at INTEGER, tokens_in INTEGER, tokens_out INTEGER);
      INSERT INTO sessions VALUES('s1',NULL,0,'u','t','active',0,0,0,0);
      CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls_json TEXT, tool_results_json TEXT, tokens_in INTEGER, tokens_out INTEGER, created_at INTEGER);
      CREATE TABLE butler_messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, tool_calls_json TEXT, tool_results_json TEXT, tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL, created_at INTEGER NOT NULL);`);
    const sink = new (await import('../src/orchestrate/event-sink.ts')).EventSink(db);
    const served: string[] = [];
    const mkProv = (tag: string): Provider => ({
      model: tag,
      async complete(_m, _t, o) { served.push(tag); o.onDelta?.(`${tag} `); return { message: { role: 'assistant', content: tag }, finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 } }; },
    });
    const providers = { 'glm': mkProv('glm'), 'mini': mkProv('mini') };
    const storage = {
      getSession: async (id: string) => db.prepare('SELECT * FROM sessions WHERE id=?').get(id),
      createSession: async () => ({}),
      sessionMessages: async (id: string) => db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY created_at').all(id) as never[],
      appendMessage: async () => {},
      updateSession: async () => {},
      activeNotes: async () => [],
      noteEmbeddings: async () => [],
    } as never;
    const app = Fastify();
    await registerConversationApi(app, {
      storage, provider: mkProv('default'), registry: { list: () => [] } as never, policy: { allows: 'read' }, systemPrompt: 's', sink, emit: () => {},
      resolveModel: (b) => b.model,
      routeComplete: (model) => {
        const p = providers[model as keyof typeof providers] ?? mkProv('default');
        return (m, t, o) => p.complete(m, t, o);
      },
    } as never);
    const r1 = await app.inject({ method: 'POST', url: '/api/agent/sessions/s1/messages', payload: { content: 'x', model: 'glm' } });
    const r2 = await app.inject({ method: 'POST', url: '/api/agent/sessions/s1/messages', payload: { content: 'y', model: 'mini' } });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(served).toEqual(['glm', 'mini']); // each body.model reached its provider
    db.close(); rmSync(tmp, { recursive: true, force: true });
  });
});
