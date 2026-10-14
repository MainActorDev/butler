# Butler model management & routing — any LLM, managed

- Source prompt: "I want Butler have an LLM models management/routing that supports any LLM models out there." + two references: Portkey-AI/gateway, Lionparcel/liorouter
- Created: 2026-10-14T08:49:23Z
- Status: Exploring

## Goal and context

Butler currently hardcodes a single provider per deployment: one `BUTLER_PROVIDER` (claude-cli or openai-compat), one model, one key. The user wants butler to **manage multiple LLM models and route between them** — "any LLM models out there" — taking the two reference gateways as the pattern library.

Direct statements (confirmed):
- The target is **Butler** (the agentic core), not Lionidas-the-app directly.
- Features wanted: model **management** (catalog of configured models) + **routing** (which model serves a request).
- Two repos given as references to learn from.

Interpretations (not confirmed):
- This is in-process routing inside butler (a library-level router), not a separate network gateway service (Portkey runs as a standalone HTTP gateway; butler is embedded in Lionidas).
- "Any LLM" pragmatically means: anything speaking OpenAI Chat Completions (covers ~all aggregators + most direct providers) or Anthropic Messages, plus local runtimes (ollama speaks OpenAI-compat). Not 78 bespoke provider adapters à la Portkey.

## Confirmed inputs and decisions

- Verified from the reference repos (cloned + read):
  - **Portkey AI Gateway**: 78 provider adapters; routing via per-request `config { mode: single|fallback|loadbalance, options[], retry{..., on_status_codes}, strategy }`; unified OpenAI/Anthropic surfaces; plugins/guardrails; <1ms, 122kb. Strength: config-object routing semantics (fallback chains, weighted loadbalance, retry-on-status). Weakness for us: it's a separate HTTP service — heavy for an embedded lib.
  - **liorouter (Lionparcel's own internal gateway, Go+React+Postgres)**: `provider_accounts` table (provider_key, label, models[], priority, concurrency, paused, credential bytea, health, draining), model catalog migrations, OpenAI+Anthropic-compatible endpoints, combo aliases ("auto"), safe failover ordered by priority, usage analytics + quotas. Strength: the *account* abstraction (multiple creds per provider, health, drain) and ops maturity (this is the user's own house pattern). Also: agent CLIs as models (Claude Code via ACP workers — butler already does this natively).
  - Butler today (code): `Provider` seam is narrow (`complete(messages, tools, {remainingMs, signal, onDelta, onTool, sessionKey})`); implementations: openai-compat (SSE streaming, tool-call accumulation), claude-cli (subprocess harness), mock. `ProviderConfig {baseUrl, apiKey, model, timeoutMs, temperature}`, typed `ProviderError` codes, DEFAULT_RETRY with jitter. Lionidas constructs ONE provider from env (`BUTLER_*`).
- House rules: secrets via env only, never in chat/DB (status page precedent: key-present booleans); sketch-first for UI; zero-dep preference; merges human-only.

## Exploration

### What "any LLM + routing" decomposes into

1. **Model registry** — configured models as DATA: `{id, provider, baseUrl, model, apiKeyEnv, protocol: openai|anthropic, priority, enabled, maxTokens?}`. liorouter's provider_accounts + Portkey's provider table are the pattern. Config file/env (v1) → DB management later (Lionidas settings UI) — matches secrets-in-env rule.
2. **Protocol adapters** — two native protocols cover "any LLM out there": OpenAI Chat (vast majority incl. openrouter/ollama/vLLM/GLM/together/groq/deepseek) and Anthropic Messages (claude + claude-compatible). Butler has the first; the second arrives with claude-API access (distinct from the current claude-CLI harness path).
3. **Routing policy** — per-turn model selection:
   - `single` (today's behavior)
   - `fallback` chain (Portkey semantics: try A, on failure/status-code try B…)
   - `loadbalance` (weights across accounts serving the same model — liorouter's priority+concurrency)
   - alias resolution ("auto", "cheap", "smart" — liorouter combo aliases)
4. **Per-caller model choice** — Lionidas surfaces a model picker (chat composer); pipeline stages can pin different models (author on a big model, triage on a cheap one).
5. **Health & observability** — account health (liorouter), route events on the provider event stream butler already has (`provider.request/retry/response`), surface in the status page.

### Shape options

**Option A — router inside butler, registry from config (recommended v1).**
`ModelRouter` wraps N provider instances; `complete(..., {model: 'glm-5.3-flash'})` resolves alias → policy → adapter, with fallback chains + retries reusing existing `ProviderError.retryable`. Registry: `BUTLER_MODELS` env/JSON file. No new service, no DB, tests hermetic with MockProviders.
- Fits: embedded-lib reality, zero-dep, incremental (openai-compat works day 1; anthropic adapter lands next).
- Cost: no runtime management UI yet; no cross-team quota sharing (single consumer anyway).

**Option B — butler speaks to a running gateway (Portkey/liorouter) as ONE provider.**
Point `BUTLER_PROVIDER_BASE_URL` at liorouter; it handles routing/failover/keys; butler stays single-model.
- Fits: zero work if liorouter is deployed; the user's org already runs it internally.
- Cost: butler itself learns nothing ("supports any LLM" stays the gateway's job); extra hop + dependency; streaming + tool-calling must survive two proxies; MCP/tools interplay outside our control. This is deployment config, not a butler feature.

**Option C — build butler its own HTTP gateway service (mini-Portkey).**
- Rejected for v1: standalone service + auth + console duplicates what an embedded router gives Lionidas for free; zero-dep preference rules it out as a first move.

### Risks / open edges with real effect

- **Tool-calling fidelity differs per provider** — GLM/claude/qwen emit tool_calls differently; the router must normalize (openai-compat already accumulates fragments; anthropic adapter needs the same care). Test each protocol with recorded fixtures.
- **Streaming + fallback interact** — if A fails mid-stream (tokens already emitted to UI), falling over to B duplicates visible text. Portkey marks requests non-fallbackable after first byte; copy that rule.
- **claude-CLI harness is special** — it's an agentic subprocess, not a chat endpoint; it stays a first-class "model" (liorouter does exactly this with Claude Code workers) but the anthropic-HTTP adapter is separate from it.
- **Secret hygiene** — registry references env var NAMES, never values; status/settings pages show presence booleans only.

## Open questions

1. **Scope of v1 management**: config-file registry only, or also a Lionidas settings UI (model list editor + health badges) in v1? Affects whether this lands as butler-only or butler+Lionidas round.
2. **Anthropic Messages adapter in v1?** Needed for "any LLM" completeness (claude direct), but claude-CLI already covers claude-shaped usage today. Could land v1 as OpenAI-compat-only (still covers most of the market) with anthropic as the fast-follow.
3. **Default routing policy**: pure alias map (explicit per-UI pick), or should v1 ship a fallback chain (e.g. primary → cheap fallback) as the default so outages degrade instead of failing?

## Next step

Answer the three questions (suggested defaults: 1 = butler-only v1, UI next round; 2 = yes, include anthropic adapter — it's the "any LLM" claim's other half; 3 = alias map + optional fallback, explicit). Then plan → review → implement, with recorded fixture tests per protocol and a live drill routing the same prompt through two real models.
