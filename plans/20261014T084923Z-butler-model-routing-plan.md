# Butler model management & routing — PLAN

- Source brainstorm: `brainstorm/20261014T084923Z-butler-model-routing.md` (`1f9bc70`)
- Created: 2026-10-14T08:52:55Z
- Status: Ready

## Goal and context

Butler gains multi-model management and routing: a registry of configured models, two protocol adapters (OpenAI Chat + Anthropic Messages), alias resolution with **model combos**, default **fallback chains** (user decision 3), and a **Lionidas settings UI** (user decision 1: both butler and UI in this round). "Any LLM out there" = anything speaking either protocol — which covers direct providers, aggregators (openrouter), and local runtimes (ollama/vLLM, both OpenAI-compat).

User decisions (verbatim): 1. "Both" (butler + Lionidas UI). 2. "Yes" (Anthropic adapter in v1). 3. "Default fallback. Model combos."

Audience: Lionidas operators picking models per chat; pipeline stages pinning models; butler as the single place routing lives.

## Confirmed inputs and decisions

- From brainstorm (code-verified): `Provider` seam (`complete(messages, tools, opts)`), openai-compat adapter with SSE + tool-call accumulation, claude-cli harness stays a first-class model kind, typed `ProviderError` with `retryable`, `DEFAULT_RETRY`, provider event stream (`provider.request/retry/response`), Lionidas constructs one provider from `BUTLER_*` env.
- From references (repo-verified): Portkey routing semantics (fallback mode, retry on status codes, no-fallback-after-first-byte), liorouter account model (priority, paused, health, credential-by-reference) and combo aliases.
- House rules: secrets via env only — the registry stores env var NAMES; UI shows presence booleans; zero new runtime deps (fetch is built in); merges human-only.

## Design

### Model registry (data)

`ModelDef`:
```ts
interface ModelDef {
  id: string;              // stable slug used by aliases & the UI ("glm-flash")
  kind: 'openai' | 'anthropic' | 'claude-cli' | 'mock';
  baseUrl?: string;        // openai/anthropic (claude-cli/mock ignore)
  model: string;           // provider-side model id ("glm-5.3-flash")
  apiKeyEnv: string;       // ENV VAR NAME — never a value
  priority: number;        // lower = preferred (liorouter semantics)
  enabled: boolean;
  maxOutputTokens?: number;
}
interface ModelCombo {                     // user decision 3: model combos
  id: string;              // alias: "auto", "cheap", "smart"...
  members: string[];       // model ids ordered as the fallback chain
  strategy: 'fallback';    // v1: fallback only (loadbalance later)
}
```
Sources, in precedence order: `BUTLER_MODELS_FILE` (JSON) → `BUTLER_MODELS` (inline JSON) → legacy single-model env fallback (`BUTLER_PROVIDER`/`BUTLER_MODEL`/…, unchanged behavior). Secrets resolved at CALL time from `process.env[apiKeyEnv]` — registry stays serializable/safe for UI + status.

### Router (`src/provider/router.ts`)

```ts
class ModelRouter implements Provider {
  complete(messages, tools, opts & { model?: string })  // opts.model = combo/model id, default combo
}
```
- Resolution: `opts.model` → combo? expand to member chain : single model. Unknown id → `PROVIDER_BAD_REQUEST` with the catalog in the message.
- **Fallback chain walk** (Portkey semantics, adapted): try members by priority; retry a member per existing `RetryPolicy` when `ProviderError.retryable`; advance to next member on exhausted retries or non-retryable errors; **stop fallback after first delta emitted** (no duplicated visible text) — record `provider.fallback` events.
- Provider events extended: `{type:'provider.route', model, combo?, attempt}` before each member attempt — the status page and pipeline logs can show which model served a turn.
- Anthropic adapter (`src/provider/anthropic.ts`): Messages API `/v1/messages`, SSE `content_block_delta` streaming (butler already parses this exact shape for claude-cli `stream_event` — reuse the knowledge), tool use via Anthropic's `tools`/`tool_use` blocks normalized to `ProviderMessage.tool_calls`.
- Health: per-model rolling window (last N outcomes, in-memory, surfaced via `router.health()`) — v1 status only; no auto-pause (liorouter's draining lands later).

### Lionidas integration

- Server: `GET/PUT /api/agent/models` (admin) — registry + combos read/write to the JSON file (path env), secrets masked (`apiKeyEnv` name + `present: boolean`); `GET /api/agent/models/health` (operator) — router health rollup. Chat send accepts optional `model` (combo or id) plumbed through conversation transport `complete` opts → turn events record the routed model.
- Web: Settings page gains a "models" section (admin): model rows (id, kind, baseUrl, model, apiKeyEnv→present dot, priority, enabled toggle), combo rows (alias → ordered members), and the chat composer gains a compact model picker (combos + direct models) — selection rides each send. Sketch-first for the picker + section layouts per house rule.
- Status page: provider·mcp card gains `routed model` + per-model health dots from `router.health()`.

## Implementation steps (ordered)

1. **Butler: registry + router core** — types, file/env loading, resolution, fallback walk, route events. Unit tests with MockProviders (chain succeeds on 2nd member; retryable-then-next; unknown id; no-fallback-after-delta).
2. **Butler: anthropic adapter** — HTTP + SSE + tool normalize. Recorded-fixture tests (captured payloads, no network in CI); one live smoke against the real backend.
3. **Butler: exports + wiring** — `createProviderFromRegistry(env)` replacing direct construction (legacy env still works); version → 0.6.0.
4. **Lionidas server** — models routes (admin CRUD on JSON file, masked), chat `model` param plumbing, health endpoint. Route tests incl. secret masking.
5. **Lionidas web** — sketch (2 variants: settings section + composer picker) → user picks → implement; nav/settings wiring; status card addition.
6. **Live drill** — configure glm + a second real model as combo "auto"; send chat asking each model to identify itself; verify fallback by pointing member 1 at a dead URL; verify UI picker + settings CRUD + status health dots.

## Acceptance criteria

1. Registry loads from file/env with legacy fallback; secrets are env-name references only (test-asserted: serialized registry contains no key values).
2. Router serves `complete` via combo fallback: member-1 exhaustion advances to member-2 (test); **no fallback after first emitted delta** (test).
3. Anthropic adapter completes + streams + carries tool calls (fixture tests + one live smoke).
4. `GET/PUT /api/agent/models` CRUD works; responses never contain secret values; non-admin gets 403 (test).
5. Chat composer model picker sends `model`; the served model is visible on the turn (event/status).
6. Status page shows routed-model + health dots.
7. Suites green (butler + lionidas server + web), tsc clean, live drill passes.

## Out of scope (v1)

Load-balance strategy (weighted), auto-pause/draining on bad health, quotas/usage accounting, embedding models, images/audio modalities, gateway-as-a-service (HTTP surface for other consumers).
