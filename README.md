<div align="center">
  <img src="docs/assets/butler-mascot.png" width="160" alt="Butler" />
</div>

<h1 align="center">Butler</h1>

<p align="center"><strong>The reusable agent runtime. Your tools, your policy — his service.</strong></p>

<p align="center">
  <img src="https://img.shields.io/badge/tests-61%20passing-brightgreen" alt="tests" />
  <img src="https://img.shields.io/badge/node-24.12-blue" alt="node" />
  <img src="https://img.shields.io/badge/provider-OpenAI--compatible-blueviolet" alt="provider" />
  <img src="https://img.shields.io/badge/surfaces-conversation%20API%20%C2%B7%20MCP-teal" alt="surfaces" />
</p>

<p align="center">
  <a href="#architecture--flow">Architecture</a> ·
  <a href="#the-authoring-flow">Flow</a> ·
  <a href="#what-butler-does">What it does</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#design-invariants">Invariants</a> ·
  <a href="#docs-map">Docs</a>
</p>

---

Butler is a reusable agent runtime: an OpenAI-compatible provider, a bounded
tool-calling loop, permission-gated tools, layered memory with provenance,
multi-source ingestion, and conversation-API + MCP transports — all in one
importable package. A consumer (the generic `demo/` today, Lionidas tomorrow)
brings its own tools, sources, and policy; Butler brings the loop. He is the
butler, not the household.

**Live-proven:** a 10-hop authoring session against `glm-5.3-flash` searched
ingested tickets, drafted a spec, was corrected by the validator **twice**
(external signal — never model self-critique), reached VALID, and cited the
exact document sha256. Verified against the database, not the answer text
(`docs/drills.md`).

## Architecture & flow

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

## The authoring flow

Live-proven against glm-5.3-flash (`docs/drills.md`):

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

## What Butler does

| You bring | Butler brings |
|---|---|
| Provider config (any OpenAI-compatible base URL + key + model) | Retries capped by YOUR wall budget, per-call timeouts, deterministic mock |
| Tools with permission classes (`read`/`draft`/`act`) | The bounded ReAct loop, typed policy refusals, provider-visible filtering |
| A validator tool as ground truth | The authoring eval that judges drafts by it — never model self-report |
| Sources (`file`/`jira`/`github`/`repo`) + an artifacts dir | sha256 content-addressed ingestion, structural chunking, BM25 retrieval |
| A sqlite file and a Fastify app | Idempotent migrations, sessions/notes/documents, conversation API + MCP |

## Quickstart

```bash
pnpm install
npx tsx demo/app.ts     # mock provider; set BUTLER_PROVIDER_BASE_URL for live
# POST /api/agent/sessions · WS /ws (butler.* events) · POST /mcp (MCP)
```

```bash
curl -X POST localhost:8790/api/agent/sessions -H 'content-type: application/json' -d '{}'
curl -X POST localhost:8790/api/agent/sessions/<id>/messages \
  -H 'content-type: application/json' -d '{"content":"draft a spec from the tickets"}'
```

## Design invariants

- **Dependency direction is one way.** Consumers import Butler; Butler never
  imports app code. The boundary test fails CI on leakage.
- **Autonomy is a policy, not a fork.** Act-class tools are registered and
  REFUSED under `DRAFT` — the refusal is the product behavior.
- **Validators are the ground truth.** The model never grades its own draft.
- **Provenance is mandatory.** Notes without a source ref are rejected;
  supersession, never deletion.
- **The loop owns the wall clock.** A hanging provider is aborted at the
  deadline — budgets hold even when the model misbehaves.
- **Every claim has a test that can fail.** Evals ship with a canary that
  proves the harness detects regressions.

## Status — v0.1, all stages shipped

- [x] Stage 0 — repo skeleton, boundary guard (fails on app-import leakage)
- [x] Stage 1 — provider + loop (mock-driven; hang → `PROVIDER_TIMEOUT` inside wall budget)
- [x] Stage 2 — tools + policy + sqlite memory (provenance mandatory, supersession)
- [x] Stage 3 — source ingestion + structural chunking + BM25 retrieval
- [x] Stage 4 — generic demo consumer (conversation API + WS + MCP)
- [x] Stage 5 — eval harness + canary + consumer docs

71 tests green (`pnpm check` = tsc + vitest + UI build, hermetic — mock
provider, zero network in CI).

**Try the UI:** `npx tsx demo/app.ts` → open http://127.0.0.1:8790 — chat
with the live agent, watch tool calls stream, browse sessions/documents/
notes. Scripted tour: `npx tsx demo/tour.ts`. Guided walkthrough:
`docs/use-case-qa-spec.md`.

## Docs map

| Doc | What's in it |
|---|---|
| `docs/architecture.html` | The layer/flow diagram, rendered |
| `docs/api.md` | The package surface with runnable snippets |
| `docs/consumers.md` | The adoption contract (what you bring / what you get) |
| `docs/drills.md` | Live verification log (condition 3: glm-5.3-flash) |
| `ROADMAP.md` | Deferred machinery (orchestration L2 seams + triggers, embeddings, postgres, MCP stdio) |

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
