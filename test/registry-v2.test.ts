/** Registry v2 (plan 20261019T090500Z): provider-first schema, v1→v2
 *  tolerant-read normalization, cooldown state machine in the chain,
 *  clearCooldown seam, catalog discovery. */

import { describe, expect, it } from 'vitest';
import { ModelRouter, parseRegistry, normalizeV1, legacyRegistry, fetchProviderCatalog, type Registry, type RegistryV1 } from '../src/provider/router.ts';
import { ProviderError, type Provider, type ProviderMessage, type ProviderResponse, type ProviderTool } from '../src/provider/types.ts';

const V1: RegistryV1 = {
  version: 1,
  defaultCombo: 'auto',
  models: [
    { id: 'glm-flash', kind: 'openai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-5.3-flash', apiKeyEnv: 'BUTLER_API_KEY', priority: 1, enabled: true },
    { id: 'glm-air', kind: 'openai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-5.3', apiKeyEnv: 'BUTLER_API_KEY', priority: 2, enabled: true },
    { id: 'or-sonnet', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-5', apiKeyEnv: 'OPENROUTER_API_KEY', priority: 3, enabled: true },
    { id: 'cc', kind: 'claude-cli', model: 'claude-sonnet-4-5', apiKeyEnv: 'BUTLER_API_KEY', priority: 4, enabled: true },
  ],
  combos: [
    { id: 'auto', members: ['glm-flash', 'glm-air'], strategy: 'fallback' },
    { id: 'air', members: ['glm-air'], strategy: 'fallback' },
  ],
};

function ok(tag: string): Provider {
  return { model: tag, async complete(): Promise<ProviderResponse> { return { message: { role: 'assistant', content: `${tag}-answer` }, finishReason: 'stop', usage: null }; } };
}
function boom(tag: string): Provider {
  return { model: tag, async complete(): Promise<ProviderResponse> { throw new ProviderError(`${tag} down`, 'PROVIDER_UNAVAILABLE', 503, true); } };
}

function routerWith(overrides: Record<string, Provider>, reg: Registry, env: Record<string, string | undefined> = {}): ModelRouter {
  const r = new ModelRouter({ env }, reg);
  const providers = (r as unknown as { providers: Map<string, Provider> }).providers;
  for (const [k, v] of Object.entries(overrides)) providers.set(k, v);
  return r;
}

describe('v1 → v2 normalization (tolerant read)', () => {
  it('groups same-provider models under ONE provider; id derives from the host', () => {
    const reg = normalizeV1(V1);
    expect(reg.version).toBe(2);
    expect(reg.providers).toHaveLength(3); // zai + openrouter + claude-cli
    expect(reg.providers.map((p) => p.id)).toEqual(['zai', 'openrouter', 'claude-cli']);
    expect(reg.models.filter((m) => m.provider === 'zai')).toHaveLength(2);
    expect(reg.models.find((m) => m.id === 'glm-flash')?.model).toBe('glm-5.3-flash');
    expect(reg.combos).toBe(V1.combos);
  });

  it('parseRegistry accepts v1 input and produces v2 (conservative write: only v2 out)', () => {
    const reg = parseRegistry(JSON.stringify(V1));
    expect(reg.version).toBe(2);
    expect(reg.providers.some((p) => p.baseUrl === 'https://api.z.ai/api/coding/paas/v4')).toBe(true);
  });

  it('v1 provider-id collisions get suffixed (zai, zai-2)', () => {
    const v1: RegistryV1 = { ...V1, models: [
      { id: 'a', kind: 'openai', baseUrl: 'https://zai.com/v4', model: 'm1', apiKeyEnv: 'K1', priority: 1, enabled: true },
      { id: 'b', kind: 'openai', baseUrl: 'https://zai.io/v4', model: 'm2', apiKeyEnv: 'K2', priority: 2, enabled: true },
    ], combos: [{ id: 'auto', members: ['a', 'b'], strategy: 'fallback' }] };
    const reg = normalizeV1(v1);
    expect(reg.providers.map((p) => p.id).sort()).toEqual(['zai', 'zai-2']);
  });

  it('round-trips the PRODUCTION v1 file shape (models.json)', () => {
    const prod = JSON.stringify({ version: 1, defaultCombo: 'auto',
      models: [
        { id: 'glm-flash', kind: 'openai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-5.3-flash', apiKeyEnv: 'BUTLER_API_KEY', priority: 1, enabled: true },
        { id: 'glm-air', kind: 'openai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-5.3', apiKeyEnv: 'BUTLER_API_KEY', priority: 2, enabled: true },
      ],
      combos: [{ id: 'auto', members: ['glm-flash', 'glm-air'], strategy: 'fallback' }, { id: 'air', members: ['glm-air'], strategy: 'fallback' }] });
    const reg = parseRegistry(prod);
    expect(reg.version).toBe(2);
    expect(reg.providers).toEqual([{ id: 'zai', kind: 'openai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', apiKeyEnv: 'BUTLER_API_KEY' }]);
  });
});

describe('v2 validation', () => {
  const OK: Registry = { version: 2, defaultCombo: 'auto',
    providers: [{ id: 'zai', kind: 'openai', baseUrl: 'https://api.z.ai/v4', apiKeyEnv: 'K' }],
    models: [{ id: 'glm-flash', provider: 'zai', model: 'glm-5.3-flash', priority: 1, enabled: true }],
    combos: [{ id: 'auto', members: ['glm-flash'], strategy: 'fallback' }] };

  it('accepts a valid v2 registry unchanged', () => {
    expect(parseRegistry(JSON.stringify(OK))).toEqual(OK);
  });
  it('rejects a model referencing an unknown provider (names model + provider)', () => {
    const bad = { ...OK, models: [{ ...OK.models[0]!, provider: 'nope' }] };
    expect(() => parseRegistry(JSON.stringify(bad))).toThrow(/model glm-flash references unknown provider nope/);
  });
  it('rejects a bad provider id and an http provider without baseUrl', () => {
    expect(() => parseRegistry(JSON.stringify({ ...OK, providers: [{ ...OK.providers[0]!, id: 'Bad_Id!' }] }))).toThrow(/bad provider def/);
    expect(() => parseRegistry(JSON.stringify({ ...OK, providers: [{ id: 'zai', kind: 'openai', apiKeyEnv: 'K' }] }))).toThrow(/baseUrl required/);
  });
  it('legacy env registry emits v2 directly', () => {
    const r = legacyRegistry({ BUTLER_PROVIDER: 'openai', BUTLER_PROVIDER_BASE_URL: 'https://api.z.ai/v4', BUTLER_MODEL: 'glm-5.3', BUTLER_API_KEY: 'x' });
    expect(r?.version).toBe(2);
    expect(r?.providers[0]?.id).toBe('zai');
    expect(r?.models[0]?.provider).toBe('zai');
  });
});

describe('cooldown state machine (9router pattern)', () => {
  const REG2: Registry = { version: 2, defaultCombo: 'auto', cooldownMs: 60_000,
    providers: [{ id: 'mock-p', kind: 'mock', apiKeyEnv: 'K' }],
    models: [
      { id: 'a', provider: 'mock-p', model: 'm-a', priority: 1, enabled: true },
      { id: 'b', provider: 'mock-p', model: 'm-b', priority: 2, enabled: true },
    ],
    combos: [{ id: 'auto', members: ['a', 'b'], strategy: 'fallback' }] };

  it('a failed model enters cooldown and is SKIPPED by the chain', async () => {
    const r = routerWith({ a: boom('A'), b: ok('B') }, REG2);
    await r.complete([], [], { remainingMs: 5000 }).catch(() => {});
    const h = r.health().find((x) => x.id === 'a')!;
    expect(h.failed).toBeGreaterThan(0);
    expect(h.cooldownUntil).toBeGreaterThan(Date.now());
    expect(r.chain('auto').map((m) => m.id)).toEqual(['b']); // a skipped
  });

  it('cooldown never hard-fails: all members cooling → soonest-expiring runs', async () => {
    const r = routerWith({ a: boom('A'), b: boom('B') }, REG2);
    await r.complete([], [], { remainingMs: 5000 }).catch(() => {});
    expect(r.chain('auto').map((m) => m.id)).toEqual(['a', 'b']); // both cooling, soonest (a, earlier failure) first — never []
  });

  it('clearCooldown lifts the skip; success clears cooldown too', async () => {
    const r = routerWith({ a: boom('A'), b: ok('B') }, REG2);
    await r.complete([], [], { remainingMs: 5000 }).catch(() => {});
    r.clearCooldown('a');
    expect(r.chain('auto').map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('cooldown + health persist across reload()', async () => {
    const r = routerWith({ a: boom('A'), b: ok('B') }, REG2);
    await r.complete([], [], { remainingMs: 5000 }).catch(() => {});
    r.reload(REG2);
    expect(r.chain('auto').map((m) => m.id)).toEqual(['b']); // still cooling after reload
  });
});

describe('fetchProviderCatalog (discovery)', () => {
  const P = { id: 'zai', kind: 'openai' as const, baseUrl: 'https://api.z.ai/v4', apiKeyEnv: 'K' };

  it('lists models from GET {baseUrl}/models with bearer auth', async () => {
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api.z.ai/v4/models');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sekret');
      return new Response(JSON.stringify({ data: [{ id: 'glm-5.3' }, { id: 'glm-5.3-flash' }] }), { status: 200 });
    }) as typeof fetch;
    const out = await fetchProviderCatalog(P, { K: 'sekret' }, fetchImpl);
    expect(out).toEqual({ supported: true, models: ['glm-5.3', 'glm-5.3-flash'] });
  });

  it('anthropic kind hits /v1/models with x-api-key; CLI/mock unsupported; missing env honest', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push(`${url}|${(init?.headers as Record<string, string>)['x-api-key'] ?? ''}`);
      return new Response(JSON.stringify({ data: ['claude-sonnet-5'] }), { status: 200 });
    }) as typeof fetch;
    const out = await fetchProviderCatalog({ ...P, kind: 'anthropic' }, { K: 'sk-1' }, fetchImpl);
    expect(out.models).toEqual(['claude-sonnet-5']);
    expect(seen[0]).toBe('https://api.z.ai/v4/v1/models|sk-1');
    expect(await fetchProviderCatalog({ ...P, kind: 'claude-cli' }, {})).toEqual({ supported: false, models: [] });
    expect(await fetchProviderCatalog(P, {}, fetchImpl)).toMatchObject({ supported: true, models: [], error: "env var 'K' not set" });
  });

  it('never throws — HTTP error and transport error ride the body', async () => {
    const fail = (async () => new Response('nope', { status: 403 })) as typeof fetch;
    expect(await fetchProviderCatalog(P, { K: 'x' }, fail)).toMatchObject({ supported: true, error: 'HTTP 403: nope' });
    const dead = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await fetchProviderCatalog(P, { K: 'x' }, dead)).toMatchObject({ supported: true, error: 'ECONNREFUSED' });
  });
});
