# Butler

A reusable agent runtime: an OpenAI-compatible provider, a bounded tool-calling
loop, permission-gated tool registry, layered memory (sessions, provenance-stamped
notes, content-addressed documents), source ingestion, and conversation-API +
MCP transports. Consumers bring their own tools, sources, and policy — Butler
is the butler, not the household.

**Try it** — the generic demo consumer (`demo/`) exercises every subsystem and
doubles as the executable quickstart:

```bash
pnpm install
npx tsx demo/app.ts        # mock provider; set BUTLER_PROVIDER_BASE_URL for live
# POST /api/agent/sessions · WS /ws (butler.* events) · POST /mcp (MCP)
```

## Architecture & flow

**Layer map** (top = what consumers see, bottom = what Butler owns):

```
┌─────────────────────────────────────────────────────────────────────────┐
│ CONSUMER APP (demo/ · later Lionidas)                                   │
│ registers tools + validator-as-ground-truth · picks policy (DRAFT)      │
│ wires sources · owns the sqlite file · provides auth + WebSocket bus    │
└───────────────▲─────────────────────────────────────────┬───────────────┘
                │ tools/policy/storage/events injected in │ imports butler
┌───────────────┴─────────────────────────────────────────▼───────────────┐
│ TRANSPORTS          conversation API (/api/agent/*) · MCP (/mcp, SDK)   │
│                     turn events → consumer's WS bus (butler.*)          │
├─────────────────────────────────────────────────────────────────────────┤
│ EVAL HARNESS        retrieval top-k · budget caps · authoring judged    │
│                     by YOUR validator — canary proves it can fail       │
├─────────────────────────────────────────────────────────────────────────┤
│ LOOP                reason→act→observe · budgets (hops/tokens/WALL —    │
│                     the loop owns the clock) · ReAct observations ·     │
│                     partial transcript rides every error                │
├──────────────────┬──────────────────────────────────────────────────────┤
│ TOOLS + POLICY    registry: read < draft < act · typed named refusals   │
├──────────────────┼──────────────────────────────────────────────────────┤
│ PROVIDER          plain fetch, any OpenAI-compatible base · retries     │
│                   capped by remaining wall · deterministic mock         │
├──────────────────┴──────────────────────────────────────────────────────┤
│ MEMORY             sqlite (six butler_* tables, idempotent migrations)  │
│ RETRIEVAL          BM25 over chunks + notes (embeddings deferred)       │
│ SOURCES            file · jira · github · repo → sha256 documents,      │
│                    structural chunks, caps, binaries to artifacts dir   │
└─────────────────────────────────────────────────────────────────────────┘
```

Rendered diagram: `docs/architecture.html`.

**The authoring flow** (live-proven against glm-5.3-flash — see
`docs/drills.md`):

```
1.  user message → conversation API (or MCP tools/call — same registry)
2.  session resumed from rows alone (butler_messages replay)
3.  LOOP assembles context → PROVIDER call (wall budget owns everything)
4.  model calls docs.search   → BM25 over ingested chunks
5.  model calls docs.get      → full ticket fixture by sha256
6.  model calls spec.draft    → VALIDATOR: INVALID   ← external signal,
7.  model repairs the draft   → VALIDATOR: INVALID     never self-critique
8.  model repairs again       → VALIDATOR: VALID ✓    (observed live, twice)
9.  act-class tools           → REFUSED by policy (DRAFT) — human publishes
10. final answer + cited sha256 → persisted · WS events · tokens accounted
```

Every message, tool call, and token lands in `butler_messages` — a session is
replayable from rows alone.

## Status — v0.1, all stages shipped

- [x] Stage 0 — repo skeleton, boundary guard (fails on app-import leakage)
- [x] Stage 1 — provider + loop (mock-driven; hang → `PROVIDER_TIMEOUT` inside wall budget)
- [x] Stage 2 — tools + policy + sqlite memory (provenance mandatory, supersession)
- [x] Stage 3 — source ingestion + structural chunking + BM25 retrieval
- [x] Stage 4 — generic demo consumer (conversation API + WS + MCP)
- [x] Stage 5 — eval harness + canary + consumer docs

61 tests green (`pnpm check` = tsc + vitest, hermetic — mock provider, zero
network in CI).

## Docs

- `docs/architecture.html` — the layer/flow diagram, rendered
- `docs/api.md` — the package surface with runnable snippets
- `docs/consumers.md` — the adoption contract (what you bring / what you get)
- `docs/drills.md` — live verification log (condition 3: glm-5.3-flash,
  10-hop authoring loop, sha citation verified against the DB)
- `ROADMAP.md` — deferred machinery (orchestration L2 seams + triggers,
  embeddings, postgres driver, MCP stdio)

Plan of record: `plans/20261001T035356Z-agentic-infrastructure-core-plan.md`
(rev 3.1, in the Lionidas repo).

## Development

```bash
pnpm install
pnpm check            # tsc --noEmit + vitest (mock provider — hermetic)
```

Node ≥ 24.12 (better-sqlite3 ABI). Live drills: set `BUTLER_PROVIDER_BASE_URL`,
`BUTLER_API_KEY`, `BUTLER_MODEL` (works with any OpenAI-compatible endpoint;
verified against z.ai's coding endpoint).
