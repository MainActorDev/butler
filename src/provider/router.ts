/** Registry v2 (plan 20261019T090500Z): provider-first. Providers carry the
 *  endpoint + key once; models reference them by id — same-provider models
 *  stop repeating their transport config (liorouter routes[].provider /
 *  9router provider registry pattern). parseRegistry still accepts v1 and
 *  normalizes it (tolerant read); only v2 is ever produced (conservative
 *  write). Secrets remain env-var NAMES, resolved at call time.
 *
 *  Routing semantics adapted from Portkey (fallback mode, retry-then-advance,
 *  NO fallback after the first emitted delta) and liorouter (priority,
 *  enabled, per-account construction). Cooldown state machine from 9router
 *  (available / cooldown / unavailable, clearable): a failed model is skipped
 *  by the chain for cooldownMs; if every member is cooling, the soonest-
 *  expiring one runs — cooldown never hard-fails a route on its own. */

import { readFileSync } from 'node:fs';
import type { Provider, ProviderMessage, ProviderResponse, ProviderTool } from './types.ts';
import { ProviderError, DEFAULT_RETRY, backoffDelay, isRetryableStatus, type RetryPolicy } from './types.ts';
import { OpenAICompatProvider } from './openai-compat.ts';
import { claudeCliProvider } from './claude-cli.ts';
import { MockProvider } from './mock.ts';

export type ProviderKind = 'openai' | 'anthropic' | 'claude-cli' | 'mock';

export interface ProviderDef {
  id: string;                // referenced by models[].provider
  kind: ProviderKind;
  baseUrl?: string;          // required for http kinds
  apiKeyEnv: string;         // env-var NAME (never the secret)
}

export interface ModelDef {
  id: string;
  provider: string;          // → providers[].id
  model: string;
  priority: number;          // lower = preferred (liorouter)
  enabled: boolean;
  maxOutputTokens?: number;
  claude?: { binPath?: string; mcpConfigPath?: string };
}

export interface ModelCombo {
  id: string;                // alias: "auto", "cheap"...
  members: string[];         // model ids, ordered = fallback order
  strategy: 'fallback';
}

export interface Registry {
  version: 2;
  defaultCombo: string;      // served when a caller passes nothing
  providers: ProviderDef[];
  models: ModelDef[];
  combos: ModelCombo[];
  cooldownMs?: number;       // failure cooldown, default 5 min
}

/** v1 input shape (flat ModelDef) — accepted on read, normalized to v2. */
export interface ModelDefV1 {
  id: string;
  kind: ProviderKind;
  baseUrl?: string;
  model: string;
  apiKeyEnv: string;
  priority: number;
  enabled: boolean;
  maxOutputTokens?: number;
  claude?: { binPath?: string; mcpConfigPath?: string };
}

export interface RegistryV1 {
  version: 1;
  defaultCombo: string;
  models: ModelDefV1[];
  combos: ModelCombo[];
}

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEFAULT_COOLDOWN_MS = 5 * 60_000;

/** provider id from a baseUrl host: api.z.ai → "zai", openrouter.ai → "openrouter" */
function providerIdFromUrl(baseUrl?: string): string | null {
  if (!baseUrl) return null;
  try {
    const labels = new URL(baseUrl).hostname.split('.').filter(Boolean);
    while (labels.length > 2 && ['api', 'www', 'v1'].includes(labels[0]!)) labels.shift();
    // stem = labels except TLD; if it's too short to be readable (z.ai → "z"),
    // absorb the TLD: z.ai → "zai", x.dev → "xdev"; openrouter.ai → "openrouter"
    let stem = (labels.length >= 2 ? labels.slice(0, -1) : labels).join('').toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (labels.length >= 2 && stem.length < 3) stem = labels.join('').toLowerCase().replace(/[^a-z0-9-]/g, '');
    return stem && PROVIDER_ID_RE.test(stem) ? stem : null;
  } catch { return null; }
}

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base) && PROVIDER_ID_RE.test(base)) { taken.add(base); return base; }
  for (let i = 2; i < 100; i++) { const c = `${base}-${i}`; if (!taken.has(c)) { taken.add(c); return c; } }
  throw new ProviderError(`cannot synthesize provider id from ${base}`, 'PROVIDER_BAD_REQUEST');
}

/** v1 flat registry → v2 provider-first (pure; table-tested). */
export function normalizeV1(raw: RegistryV1): Registry {
  const providers: ProviderDef[] = [];
  const taken = new Set<string>();
  const byKey = new Map<string, string>(); // kind|baseUrl|apiKeyEnv → provider id
  const models: ModelDef[] = raw.models.map((m) => {
    const key = `${m.kind}|${m.baseUrl ?? ''}|${m.apiKeyEnv}`;
    let pid = byKey.get(key);
    if (!pid) {
      const base = m.kind === 'claude-cli' || m.kind === 'mock'
        ? uniqueId(m.kind, taken)
        : (providerIdFromUrl(m.baseUrl) ? uniqueId(providerIdFromUrl(m.baseUrl)!, taken) : uniqueId('provider', taken));
      pid = base;
      byKey.set(key, pid);
      providers.push({ id: pid, kind: m.kind, ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}), apiKeyEnv: m.apiKeyEnv });
    }
    const { kind: _k, baseUrl: _b, apiKeyEnv: _a, ...rest } = m;
    void _k; void _b; void _a;
    return { ...rest, provider: pid };
  });
  return { version: 2, defaultCombo: raw.defaultCombo, providers, models, combos: raw.combos };
}

export type RouteEvent =
  | { type: 'provider.route'; model: string; combo?: string; attempt: number; outcome: 'start' | 'advance' | 'exhausted' }
  | { type: 'provider.response'; attempt: number; promptTokens: number; completionTokens: number; model: string };

/** Rolling per-model health (process-lifetime by design — same truth class as
 *  the status page's other signals; review PR5). cooldownUntil set on
 *  failure: the chain skips the model until then (9router state machine). */
export interface ModelHealth { id: string; ok: number; failed: number; lastError?: string; lastOkAt?: number; cooldownUntil?: number }

const HEALTH_WINDOW = 20;

export interface RouterOpts {
  registryPath?: string;               // BUTLER_MODELS_FILE
  inlineRegistry?: string;             // BUTLER_MODELS (JSON)
  env?: Record<string, string | undefined>; // default process.env (resolved lazily per call)
  retry?: RetryPolicy;
  onEvent?: (e: RouteEvent) => void;
  fetchImpl?: typeof fetch;            // tests
  /** claude-cli env injection per member (mirrors today's host wiring) */
  claudeEnv?: (m: ModelDef) => Record<string, string> | undefined;
}

export function parseRegistry(json: string): Registry {
  const raw = JSON.parse(json) as unknown as RegistryV1 | Registry;
  if (!raw.defaultCombo || !Array.isArray(raw.models) || !Array.isArray(raw.combos)) {
    throw new ProviderError('registry must have defaultCombo, models[], combos[]', 'PROVIDER_BAD_REQUEST');
  }
  if ((raw as Registry).version === 2) {
    const v2 = raw as Registry;
    if (!Array.isArray(v2.providers)) throw new ProviderError('v2 registry must have providers[]', 'PROVIDER_BAD_REQUEST');
    return validateV2(v2);
  }
  // v1 (or unversioned) → tolerant read: validate flat shape, normalize to v2
  const v1 = raw as RegistryV1;
  for (const m of v1.models) {
    if (!m.id || !m.model || typeof m.priority !== 'number' || !m.kind) throw new ProviderError(`bad model def: ${JSON.stringify(m).slice(0, 80)}`, 'PROVIDER_BAD_REQUEST');
    if (m.kind !== 'claude-cli' && m.kind !== 'mock' && !m.baseUrl) throw new ProviderError(`model ${m.id}: baseUrl required for kind ${m.kind}`, 'PROVIDER_BAD_REQUEST');
  }
  const normalized = normalizeV1({ ...v1, version: 1 });
  return validateV2(normalized);
}

function validateV2(reg: Registry): Registry {
  const ids = new Set(reg.models.map((m) => m.id));
  const pids = new Set(reg.providers.map((p) => p.id));
  for (const p of reg.providers) {
    if (!p.id || !p.kind || !PROVIDER_ID_RE.test(p.id)) throw new ProviderError(`bad provider def: ${JSON.stringify(p).slice(0, 80)}`, 'PROVIDER_BAD_REQUEST');
    if (p.kind !== 'claude-cli' && p.kind !== 'mock' && !p.baseUrl) throw new ProviderError(`provider ${p.id}: baseUrl required for kind ${p.kind}`, 'PROVIDER_BAD_REQUEST');
  }
  for (const m of reg.models) {
    if (!m.id || !m.model || typeof m.priority !== 'number') throw new ProviderError(`bad model def: ${JSON.stringify(m).slice(0, 80)}`, 'PROVIDER_BAD_REQUEST');
    if (!pids.has(m.provider)) throw new ProviderError(`model ${m.id} references unknown provider ${m.provider}`, 'PROVIDER_BAD_REQUEST');
  }
  for (const c of reg.combos) {
    if (!c.id || !Array.isArray(c.members) || c.members.length === 0) throw new ProviderError(`bad combo: ${c.id}`, 'PROVIDER_BAD_REQUEST');
    for (const mem of c.members) {
      if (!ids.has(mem)) throw new ProviderError(`combo ${c.id} references unknown model ${mem}`, 'PROVIDER_BAD_REQUEST');
    }
  }
  if (!reg.combos.some((c) => c.id === reg.defaultCombo)) {
    throw new ProviderError(`defaultCombo ${reg.defaultCombo} not in combos`, 'PROVIDER_BAD_REQUEST');
  }
  return reg;
}

/** Legacy single-model env → registry (unchanged behavior for existing hosts,
 *  now emitted directly in the v2 shape). */
export function legacyRegistry(env: Record<string, string | undefined>): Registry | null {
  const provider = env['BUTLER_PROVIDER'];
  const model = env['BUTLER_MODEL'];
  const baseUrl = env['BUTLER_PROVIDER_BASE_URL'];
  const apiKeyEnv = 'BUTLER_API_KEY';
  if (provider === 'claude-cli' && model) {
    return { version: 2, defaultCombo: 'default',
      providers: [{ id: 'claude-cli', kind: 'claude-cli', apiKeyEnv }],
      models: [{ id: 'primary', provider: 'claude-cli', model, priority: 1, enabled: true, claude: { ...(env['BUTLER_CLAUDE_BIN'] ? { binPath: env['BUTLER_CLAUDE_BIN'] } : {}), ...(env['BUTLER_MCP_CONFIG'] ? { mcpConfigPath: env['BUTLER_MCP_CONFIG'] } : {}) } }],
      combos: [{ id: 'default', members: ['primary'], strategy: 'fallback' }] };
  }
  if (baseUrl && model && env['BUTLER_API_KEY']) {
    const pid = providerIdFromUrl(baseUrl) ?? 'primary';
    return { version: 2, defaultCombo: 'default',
      providers: [{ id: pid, kind: 'openai', baseUrl, apiKeyEnv }],
      models: [{ id: 'primary', provider: pid, model, priority: 1, enabled: true }],
      combos: [{ id: 'default', members: ['primary'], strategy: 'fallback' }] };
  }
  return null;
}

export function loadRegistry(opts: RouterOpts): Registry {
  if (opts.registryPath) return parseRegistry(readFileSync(opts.registryPath, 'utf8'));
  if (opts.inlineRegistry) return parseRegistry(opts.inlineRegistry);
  const env = opts.env ?? process.env;
  const legacy = legacyRegistry(env);
  if (legacy) return legacy;
  throw new ProviderError('no model registry: set BUTLER_MODELS_FILE or BUTLER_MODELS, or the legacy BUTLER_* single-model env', 'PROVIDER_BAD_REQUEST');
}

export class ModelRouter implements Provider {
  readonly model: string; // the default combo id — informational
  private registry: Registry;
  private providers = new Map<string, Provider>();
  private healthMap = new Map<string, ModelHealth>();
  private failedOnce = new Set<string>();

  constructor(private readonly opts: RouterOpts, registry?: Registry) {
    this.registry = registry ?? loadRegistry(opts);
    this.model = this.registry.defaultCombo;
  }

  /** PR3 reload seam: re-read the registry file; in-flight turns keep their
   *  resolved chain (they captured the provider list). Health + cooldown
   *  persist across reloads (same truth class as the counters). */
  reload(registry?: Registry): void {
    this.registry = registry ?? loadRegistry(this.opts);
    this.providers = new Map();          // rebuild lazily; health persists
  }

  registrySnapshot(): Registry { return this.registry; }

  health(): ModelHealth[] { return [...this.healthMap.values()]; }

  /** UI seam: lift a model's cooldown (9router "clear cooldown"). */
  clearCooldown(id: string): void {
    const h = this.healthMap.get(id);
    if (h) delete h.cooldownUntil;
  }

  private cooldownLeft(id: string): number {
    const h = this.healthMap.get(id);
    if (!h?.cooldownUntil) return 0;
    return Math.max(0, h.cooldownUntil - Date.now());
  }

  /** resolve a combo/model id → ordered enabled ModelDefs (fallback chain).
   *  Members in cooldown are skipped; if EVERY member is cooling, the
   *  soonest-expiring one runs — cooldown never hard-fails a route alone. */
  chain(forModel?: string): ModelDef[] {
    const want = forModel ?? this.registry.defaultCombo;
    const combo = this.registry.combos.find((c) => c.id === want);
    const ids = combo ? combo.members : [want];
    const defs = ids
      .map((id) => this.registry.models.find((m) => m.id === id))
      .filter((m): m is ModelDef => Boolean(m) && (m as ModelDef).enabled)
      .sort((a, b) => a.priority - b.priority);
    if (defs.length === 0) {
      const catalog = this.registry.models.map((m) => `${m.id}(${m.enabled ? 'on' : 'off'})`).join(', ');
      const combos = this.registry.combos.map((c) => c.id).join(', ');
      throw new ProviderError(`unknown or disabled model/combo "${want}" — models: ${catalog}; combos: ${combos}`, 'PROVIDER_BAD_REQUEST');
    }
    const active = defs.filter((d) => this.cooldownLeft(d.id) === 0);
    if (active.length > 0) return active;
    return [...defs].sort((a, b) => this.cooldownLeft(a.id) - this.cooldownLeft(b.id)); // all cooling → soonest first
  }

  /** PR1: router-LOCAL selection seam — Provider.complete stays untouched. */
  route(forModel?: string): (messages: ProviderMessage[], tools: ProviderTool[], opts: { remainingMs: number; signal?: AbortSignal | undefined; onDelta?: ((delta: string) => void) | undefined; onTool?: ((e: { phase: 'call' | 'result'; name: string; arg?: string; result?: string; isError?: boolean }) => void) | undefined; sessionKey?: string | undefined }) => Promise<ProviderResponse> {
    const chain = this.chain(forModel); // resolve ONCE — in-flight turns keep this chain
    const comboId = this.registry.combos.some((c) => c.id === (forModel ?? this.registry.defaultCombo)) ? (forModel ?? this.registry.defaultCombo) : undefined;
    return (messages, tools, opts) => this.runChain(chain, comboId, messages, tools, opts);
  }

  async complete(messages: ProviderMessage[], tools: ProviderTool[], opts: { remainingMs: number; signal?: AbortSignal | undefined; onDelta?: ((delta: string) => void) | undefined; onTool?: ((e: { phase: 'call' | 'result'; name: string; arg?: string; result?: string; isError?: boolean }) => void) | undefined; sessionKey?: string | undefined }): Promise<ProviderResponse> {
    return this.route()(messages, tools, opts);
  }

  private providerFor(def: ModelDef): Provider {
    const cached = this.providers.get(def.id);
    if (cached) return cached;
    const env = this.opts.env ?? process.env;
    const prov = this.registry.providers.find((p) => p.id === def.provider);
    if (!prov) throw new ProviderError(`model ${def.id}: unknown provider ${def.provider}`, 'PROVIDER_BAD_REQUEST');
    const apiKey = env[prov.apiKeyEnv];
    let p: Provider;
    switch (prov.kind) {
      case 'openai':
        if (!prov.baseUrl || !apiKey) throw new ProviderError(`model ${def.id} (provider ${prov.id}): missing baseUrl or ${prov.apiKeyEnv}`, 'PROVIDER_BAD_REQUEST');
        p = new OpenAICompatProvider({ baseUrl: prov.baseUrl, apiKey, model: def.model, ...(def.maxOutputTokens ? { maxTokens: def.maxOutputTokens } : {}) }, this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {});
        break;
      case 'anthropic':
        if (!prov.baseUrl || !apiKey) throw new ProviderError(`model ${def.id} (provider ${prov.id}): missing baseUrl or ${prov.apiKeyEnv}`, 'PROVIDER_BAD_REQUEST');
        p = new AnthropicProvider({ baseUrl: prov.baseUrl, apiKey, model: def.model, ...(def.maxOutputTokens ? { maxTokens: def.maxOutputTokens } : {}) }, this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {});
        break;
      case 'claude-cli':
        p = claudeCliProvider({
          kind: 'claude-cli',
          baseUrl: prov.baseUrl ?? '',
          apiKey: apiKey ?? '',
          model: def.model,
          ...(def.claude?.binPath ? { binPath: def.claude.binPath } : {}),
          ...(def.claude?.mcpConfigPath ? { mcpConfigPath: def.claude.mcpConfigPath } : {}),
          ...(this.opts.claudeEnv?.(def) ? { env: this.opts.claudeEnv!(def) } : {}),
        } as Parameters<typeof claudeCliProvider>[0]);
        break;
      case 'mock':
        p = new MockProvider([{ kind: 'assistant', content: `mock:${def.id}` }]);
        break;
    }
    this.providers.set(def.id, p);
    return p;
  }

  private noteHealth(id: string, ok: boolean, err?: string): void {
    const h = this.healthMap.get(id) ?? { id, ok: 0, failed: 0 };
    if (ok) { h.ok += 1; h.lastOkAt = Date.now(); delete h.lastError; delete h.cooldownUntil; }
    else {
      h.failed += 1; if (err) h.lastError = err.slice(0, 160);
      h.cooldownUntil = Date.now() + (this.registry.cooldownMs ?? DEFAULT_COOLDOWN_MS);
    }
    this.healthMap.set(id, h);
    // rolling window: keep the smaller bucket from growing unbounded
    if (h.ok + h.failed > HEALTH_WINDOW * 10) { h.ok = Math.min(h.ok, HEALTH_WINDOW); h.failed = Math.min(h.failed, HEALTH_WINDOW); }
  }

  private async runChain(chain: ModelDef[], comboId: string | undefined, messages: ProviderMessage[], tools: ProviderTool[], opts: { remainingMs: number; signal?: AbortSignal | undefined; onDelta?: ((delta: string) => void) | undefined; onTool?: ((e: { phase: 'call' | 'result'; name: string; arg?: string; result?: string; isError?: boolean }) => void) | undefined; sessionKey?: string | undefined }): Promise<ProviderResponse> {
    const retry = this.opts.retry ?? DEFAULT_RETRY;
    const deadline = Date.now() + Math.max(0, opts.remainingMs);
    let lastErr: unknown = null;

    for (let mi = 0; mi < chain.length; mi++) {
      const def = chain[mi]!;
      let provider: Provider;
      try {
        provider = this.providerFor(def);
      } catch (err) {
        this.opts.onEvent?.({ type: 'provider.route', model: def.id, ...(comboId ? { combo: comboId } : {}), attempt: mi + 1, outcome: 'advance' });
        this.noteHealth(def.id, false, err instanceof Error ? err.message : String(err));
        lastErr = err;
        continue;
      }

      for (let attempt = 1; attempt <= retry.maxRetries + 1; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) { lastErr = new ProviderError('route wall budget exhausted', 'PROVIDER_TIMEOUT'); break; }
        this.opts.onEvent?.({ type: 'provider.route', model: def.id, ...(comboId ? { combo: comboId } : {}), attempt, outcome: 'start' });
        let emittedDelta = false;
        try {
          const res = await provider.complete(messages, tools, {
            ...opts,
            remainingMs: remaining,
            onDelta: opts.onDelta ? (d) => { emittedDelta = true; opts.onDelta!(d); } : undefined,
          });
          this.noteHealth(def.id, true);
          return res;
        } catch (err) {
          lastErr = err;
          const pe = err instanceof ProviderError ? err : null;
          const retryable = pe ? pe.retryable || isRetryableStatus(pe.status ?? 0) : false;
          this.noteHealth(def.id, false, pe?.message ?? String(err));
          // NO fallback after the first emitted delta (Portkey rule): the UI
          // already showed tokens; a failover would duplicate visible text.
          if (emittedDelta) throw err;
          if (!retryable || attempt > retry.maxRetries) break; // advance to next member
          const delay = backoffDelay(attempt, retry);
          await new Promise((r) => setTimeout(r, Math.min(delay, deadline - Date.now())));
        }
      }
      this.opts.onEvent?.({ type: 'provider.route', model: def.id, ...(comboId ? { combo: comboId } : {}), attempt: 0, outcome: mi + 1 < chain.length ? 'advance' : 'exhausted' });
    }
    throw lastErr instanceof Error ? lastErr : new ProviderError('all models in the chain failed', 'PROVIDER_UNAVAILABLE');
  }
}

/** Anthropic Messages adapter: /v1/messages, SSE content_block_delta streaming
 *  (same event shape butler already parses for claude-cli stream_event), tool
 *  use normalized to ProviderMessage.tool_calls. */
export class AnthropicProvider implements Provider {
  readonly model: string;
  constructor(private readonly cfg: { baseUrl: string; apiKey: string; model: string; maxTokens?: number; timeoutMs?: number }, private readonly opts: { fetchImpl?: typeof fetch } = {}) {
    this.model = cfg.model;
  }

  async complete(messages: ProviderMessage[], tools: ProviderTool[], opts: { remainingMs: number; signal?: AbortSignal | undefined; onDelta?: ((delta: string) => void) | undefined }): Promise<ProviderResponse> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/v1/messages`;
    // map OpenAI-shape → Anthropic shape: system rides the top-level field;
    // tool messages become user turns with tool_result blocks; assistant
    // tool_calls become tool_use blocks.
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content ?? '').join('\n');
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      max_tokens: this.cfg.maxTokens ?? 4096,
      stream: Boolean(opts.onDelta),
      ...(system ? { system } : {}),
      messages: messages
        .filter((m) => m.role !== 'system')
        .map((m) => this.toAnthropicMessage(m)),
      ...(tools.length ? { tools: tools.map((t) => ({ name: t.function.name, description: t.function.description ?? '', input_schema: t.function.parameters ?? { type: 'object' } })) } : {}),
    };
    const res = await (this.opts.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.cfg.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: opts.signal ?? AbortSignal.timeout(Math.min(this.cfg.timeoutMs ?? 120_000, Math.max(1, opts.remainingMs))),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(`anthropic ${res.status}: ${text.slice(0, 200)}`, 'PROVIDER_UNAVAILABLE', res.status, isRetryableStatus(res.status));
    }
    if (!res.body) throw new ProviderError('anthropic: no body', 'PROVIDER_UNAVAILABLE', undefined, true);

    // SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let content = '';
    const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
    let usage: { promptTokens: number; completionTokens: number } | null = null;
    let finishReason: string | null = null;
    let blockIndex = -1;
    let currentTool: { id: string; name: string; args: string } | null = null;

    const flushTool = (): void => {
      if (currentTool) {
        toolCalls.push({ id: currentTool.id, type: 'function', function: { name: currentTool.name, arguments: currentTool.args || '{}' } });
        currentTool = null;
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const ev = JSON.parse(payload) as {
            type?: string; index?: number;
            delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
            content_block?: { type: string; id?: string; name?: string; text?: string };
            message?: { usage?: { input_tokens?: number; output_tokens?: number } };
            usage?: { input_tokens?: number; output_tokens?: number };
          };
          if (ev.type === 'content_block_start' && typeof ev.index === 'number') {
            flushTool();
            blockIndex = ev.index;
            if (ev.content_block?.type === 'tool_use') currentTool = { id: ev.content_block.id ?? `call_${ev.index}`, name: ev.content_block.name ?? '', args: '' };
          }
          if (ev.type === 'content_block_delta') {
            if (ev.delta?.type === 'text_delta' && ev.delta.text) { content += ev.delta.text; opts.onDelta?.(ev.delta.text); }
            if (ev.delta?.type === 'input_json_delta' && ev.delta.partial_json && currentTool) currentTool.args += ev.delta.partial_json;
            if (ev.delta?.stop_reason) finishReason = ev.delta.stop_reason;
          }
          if (ev.type === 'content_block_stop') flushTool();
          if (ev.type === 'message_delta' && ev.delta?.stop_reason) finishReason = ev.delta.stop_reason;
          const u = ev.usage ?? ev.message?.usage;
          if (u) {
            const prev: { promptTokens: number; completionTokens: number } = usage ?? { promptTokens: 0, completionTokens: 0 };
            usage = { promptTokens: Math.max(prev.promptTokens, u.input_tokens ?? 0), completionTokens: Math.max(prev.completionTokens, u.output_tokens ?? 0) };
          }
        } catch { /* partial json — a later chunk completes it */ }
      }
    }
    flushTool();
    void blockIndex;
    if (!content && toolCalls.length === 0) throw new ProviderError('anthropic streamed no content', 'PROVIDER_UNAVAILABLE', res.status, false);
    return {
      message: { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finishReason,
      usage,
    };
  }

  private toAnthropicMessage(m: ProviderMessage): Record<string, unknown> {
    if (m.role === 'assistant' && m.tool_calls) {
      return { role: 'assistant', content: [
        ...(m.content ? [{ type: 'text', text: m.content }] : []),
        ...m.tool_calls.map((tc) => ({ type: 'tool_use', id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments || '{}') })),
      ] };
    }
    if (m.role === 'tool') {
      return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: m.content ?? '' }] };
    }
    return { role: m.role, content: m.content ?? '' };
  }
}

/** Host factory: build the router + a route seam (PR1) from env-ish opts. */
export function createModelRouter(opts: RouterOpts): { provider: Provider; router: ModelRouter; route: ModelRouter['route'] } {
  const router = new ModelRouter(opts);
  return { provider: router, router, route: (m?: string) => router.route(m) };
}

/** Catalog discovery (9router modelsFetcher pattern): list a provider's
 *  models straight from the provider. openai kinds → GET {baseUrl}/models;
 *  anthropic → GET {baseUrl}/v1/models; CLI/mock kinds are unsupported.
 *  Never throws — the verdict rides the body. */
export async function fetchProviderCatalog(
  p: Pick<ProviderDef, 'id' | 'kind' | 'baseUrl' | 'apiKeyEnv'>,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ supported: boolean; models: string[]; error?: string }> {
  if (p.kind === 'claude-cli' || p.kind === 'mock') return { supported: false, models: [] };
  const key = env[p.apiKeyEnv];
  if (!key || !p.baseUrl) return { supported: true, models: [], error: !p.baseUrl ? 'provider has no baseUrl' : `env var '${p.apiKeyEnv}' not set` };
  const base = p.baseUrl.replace(/\/+$/, '');
  const url = p.kind === 'anthropic' ? `${base}/v1/models` : `${base}/models`;
  const headers = p.kind === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${key}` };
  try {
    const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return { supported: true, models: [], error: `HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 120)}` };
    const b = (await r.json()) as { data?: Array<{ id?: string } | string>; models?: Array<{ id?: string } | string> };
    const arr = b.data ?? b.models ?? [];
    const ids = arr.map((x) => (typeof x === 'string' ? x : x.id)).filter((x): x is string => typeof x === 'string' && x.length > 0);
    return { supported: true, models: ids };
  } catch (e) {
    return { supported: true, models: [], error: e instanceof Error ? e.message : String(e) };
  }
}
