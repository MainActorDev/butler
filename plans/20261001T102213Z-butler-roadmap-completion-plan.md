# Butler roadmap completion — demo UI, orchestration L2, embeddings, drivers

- Source brainstorm: `../lionidas/brainstorm/20261001T102213Z-butler-roadmap-completion.md` (all material questions answered 2026-10-01)
- Status: **Ready**
- Plan date: 2026-10-01
- Home: Butler repo (`plans/` convention starts here — Butler is a standalone product; the brainstorm lives in Lionidas only because the conversation started there)

## Decision log

| # | Decision | Source |
|---|---|---|
| R1 | Finish the WHOLE roadmap except Lionidas integration | operator 2026-10-01: "Can we finish the whole roadmap? Except the integration to lionidas" |
| R2 | Driving problem: comprehensibility — "It's really hard to reason what Butler now can do" → the demo's face comes FIRST, machinery behind it | operator statement, verbatim |
| R3 | Demo UI = **Vue** — minimal chat + live tool calls + sessions/notes/documents browser, served by the demo app, consuming ONLY the conversation API/WS/MCP (reference client) | operator 2026-10-01: "1. Vue" |
| R4 | Orchestration L2 **approved** — supervisor + spawn machinery now; lead use case = eval fan-out; ships with its own eval family (the D16 deal) | operator 2026-10-01: "2. approved." |
| R5 | Embeddings via the z.ai key — VERIFIED LIMITATION (2026-10-01): z.ai's GLOBAL endpoint serves NO embeddings (issue zai-org/z-ai-sdk-python#67, maintainer-confirmed; probes of embedding-2/3, text-embedding-3-small → `1211 Unknown Model` on paas/v4 AND coding/paas/v4). The seam stays OpenAI-compatible so any endpoint works; live-drill provider is an open item below | operator "3. my z.ai key" + independent verification |
| R6 | Sequencing (brainstorm, unobjected): demo UI+tour → MCP stdio → L2 → embeddings → postgres → tree-sitter | brainstorm §Sequencing, operator moved to planning without objection |

## Objective

Make Butler **legible** (a Vue demo UI that shows, live, what the agent is doing) and **complete** (every ROADMAP item except Lionidas integration built, each with evals that can fail per D6): the demo tour, the Vue demo app, the MCP stdio bin, orchestration L2 (supervisor/children/budget trees/cancellation), the embedding seam with hybrid retrieval, the postgres storage driver, and tree-sitter symbol chunks.

## Completion conditions (measurable)

1. `demo/tour.ts` runs N scripted scenarios end-to-end in CI (hermetic) printing a narrated transcript — search→draft→validate→repair→VALID→refusal-of-act all appear.
2. The Vue demo UI: served by the demo app at `/`, against the LIVE z.ai chat endpoint a user can hold a session, watch tool calls stream in real time (WS `butler.*` events), see validator verdicts inline, and browse sessions/notes/documents — using ONLY public API/WS/MCP surfaces (no internals).
3. `butler-mcp` stdio bin: an MCP client config line can mount Butler's registry over stdio (verified with the SDK's own client in a test).
4. Orchestration L2: a supervisor session spawns child sessions (parent_session_id populated); children run CONCURRENTLY with independent budgets that roll up to the parent's caps; aborting the parent cancels children (in-flight provider calls aborted, no orphaned rows); the supervisor receives summaries, not transcripts; an `eval-orchestration` family runs N authoring fixtures concurrently and asserts the fan-out completes within budget.
5. Embedding seam: `EmbeddingProvider` interface + OpenAI-compatible HTTP adapter + deterministic hash-based mock (CI hermetic). `StorageRetriever` gains hybrid mode (BM25 + cosine rerank) behind a config toggle; the retrieval eval measures BM25 vs hybrid on a synthetic corpus (≥200 docs) and the result is asserted + logged — the toggle never silently replaces BM25.
6. Postgres driver: `PostgresStorage` implements the SAME Storage contract; the existing sqlite contract tests run parameterized over both drivers (pg via testcontainers-style ephemeral or a local `pg` in CI is an open item below).
7. tree-sitter: repo connector accepts `symbols: true` per source; indexed repos emit symbol chunks (functions/types with names + spans) alongside file chunks; boundary test extended for the new dep.
8. ROADMAP.md rewritten: every entry either built (with the eval that gates it) or explicitly Lionidas-only; README/docs updated to teach the new capabilities; all gates green (tsc + vitest + build for the Vue app).

## Out of scope

- Lionidas integration (R1) — remains its own future plan
- Embeddings as default retrieval — hybrid stays opt-in behind the toggle until measured better
- Multi-tenant auth, billing, UI polish beyond the minimal demo app
- Changing the v0.1 public API of shipped modules (additive only)

## Architecture additions

```
demo/ui/            Vue 3 + Vite app (chat · live tool calls · data browser)
                    served at / by the demo Fastify (static build output)
demo/tour.ts        scripted narrated walkthrough (CI smoke + teaching artifact)
bin/butler-mcp.ts   stdio MCP server over the same registry (SDK transport)
src/orchestrate/
  supervisor.ts     spawn(children) → concurrent loops → summary collection
  budgets.ts        token/hop/wall ROLL-UP: child caps derive from parent remainder
  cancel.ts         AbortSignal graph: parent abort ⇒ children ⇒ provider calls
src/embeddings/
  types.ts          EmbeddingProvider seam (+ hash-mock for hermetic CI)
  openai-compat.ts  /embeddings adapter (any OpenAI-compatible base)
  hybrid.ts         cosine rerank over BM25 candidates (toggle-gated)
src/memory/postgres.ts   Storage over pg (same contract, same migrations logic)
src/sources/tree-sitter.ts   symbol chunks for repo sources (opt-in)
```

**Invariants preserved:** one-way dependency direction (the UI is a consumer like any other; it may not import `src/` internals beyond the public barrel); policy gates unchanged (children inherit the parent's policy); provenance unchanged; hermetic CI (mock provider + hash embeddings; live runs env-gated).

## Implementation stages

### Stage A — Demo tour (legibility first)
- `demo/tour.ts`: runs the scripted authoring scenario (search→get→draft→INVALID→repair→VALID→attempted publish refused) against the mock provider, printing a narrated, timestamped transcript with tool calls, observations, and validator verdicts; exits non-zero if any expected beat is missing.
- Wired into `pnpm check` as a vitest test (hermetic).
- **Deliverable:** condition 1; `npx tsx demo/tour.ts` is the 60-second answer to "what can Butler do".

### Stage B — Vue demo UI (the reference consumer)
- `demo/ui/` Vue 3 + Vite: chat pane (session create + message POST), live activity feed (WS `butler.*` events → streaming tool-call cards with expand/collapse), validator verdict badges, sessions/notes/documents browsers (GET endpoints; a small read-only JSON view).
- Demo app serves the built UI at `/` and keeps a dev proxy; `.env` creds drive the live chat provider (verified working); mock fallback labeled in the UI header.
- Talks ONLY to `/api/agent/*`, `/ws`, `/mcp` — boundary test asserts `demo/ui/src` imports no `../../src` internals.
- **Deliverable:** condition 2; manual live drill logged in `docs/drills.md`; UI build added to `pnpm check`.

### Stage C — MCP stdio bin
- `bin/butler-mcp.ts`: builds a demo-configured registry (or loads a consumer module path via `--registry <module>`) and serves it over the SDK's stdio transport.
- Test: SDK client connects over stdio, tools/list + tools/call round-trip.
- README: Claude Code / Codex / Hermes config snippets.
- **Deliverable:** condition 3.

### Stage D — Orchestration L2 (evals first, per the D16 deal)
- **D.0 evals before machinery:** `eval-orchestration` family — fan out N=4 authoring fixtures concurrently; assert all complete, budgets respected (parent token cap ≥ sum of child spend), wall time < serial time (bounded, deterministic mocks).
- `budgets.ts`: child budget = share of parent REMAINING (tokens pro-rata, wall = parent deadline minus elapsed); overflow → child gets `BUDGET_EXCEEDED`, supervisor observes, fan-out continues (named-skip semantics, never abort the batch).
- `cancel.ts`: `AbortSignal.any` graph parent→children→provider; parent abort mid-fanout → all children settle with partial transcripts persisted (resumable), zero orphan rows (each child row carries parent_session_id — the seam from Stage 2 finally earns its keep).
- `supervisor.ts`: `spawn` becomes a REAL tool (draft-class); children get narrowed system prompts; supervisor receives `{childId, summary, tokens, verdict}` — summaries, never transcripts (context economy).
- Policy: children inherit the parent policy; `spawn` itself is draft-class (an ACT policy can spawn act-children; DRAFT cannot escalate).
- **Deliverable:** condition 4; ROADMAP orchestration entry flips to built; anti-forgetting design retires honorably.

### Stage E — Embedding seam + hybrid retrieval
- `types.ts` seam + `openai-compat.ts` adapter + `mock.ts` (deterministic hash→vector; same API shape; CI hermetic).
- `hybrid.ts`: embed query → cosine rerank of BM25 top-50 → final top-k; `StorageRetriever(config: { mode: 'bm25' | 'hybrid' })` — default stays bm25.
- Synthetic corpus (≥200 generated docs, planted relevance) + extended retrieval eval asserting and LOGGING bm25-vs-hybrid recall@k; the comparison itself becomes a test artifact.
- Live drill: needs an embeddings endpoint — z.ai global confirmed unavailable (R5); open item Q1 below.
- **Deliverable:** condition 5.

### Stage F — Postgres storage driver
- `memory/postgres.ts` implementing Storage; migrations as idempotent SQL (CREATE IF NOT EXISTS, same schema); `pg` driver dep (boundary allowlist).
- Contract tests refactored into a shared suite parameterized `[sqlite, postgres]`; postgres leg runs when a `BUTLER_TEST_PG` URL exists, skips honestly otherwise.
- **Deliverable:** condition 6.

### Stage G — tree-sitter symbol chunks
- `sources/tree-sitter.ts`: web-tree-sitter; repo connector `symbols: true` emits symbol chunks (name, kind, span, enclosing file) that flow through the SAME chunk pipeline (they're just heading_path="symbol: foo" chunks — retrieval needs no changes).
- Grammars fetched at build (wasm) — no runtime network; opt-in per source config; boundary allowlist for the dep.
- **Deliverable:** condition 7.

### Stage H — Docs & ROADMAP closeout
- ROADMAP rewritten (built items + evidence links; Lionidas-only remainder), README gains the UI screenshot + tour mention, `docs/api.md` + `docs/consumers.md` extended (orchestration, embeddings, drivers).
- **Deliverable:** condition 8.

## Edge & failure cases (designed)

- Child budget overflow → named-skip (fan-out continues); supervisor report lists skipped children with reasons.
- Parent abort mid-fanout → children settle via cancel graph; partial transcripts persisted; UI shows the tree state.
- Spawn of unknown/failing child (bad system prompt) → child error becomes supervisor observation, not a crash.
- Embedding endpoint down → hybrid mode degrades to BM25 with a logged warning, never a hard failure (retrieval must not depend on the network).
- pg unavailable in CI → postgres leg skipped, honestly reported; sqlite leg always runs.
- tree-sitter grammar missing for a file type → falls back to plain file chunks, logged.
- Vue UI with backend down → connection banner, retries; never a blank screen of death.

## Scientific grounding checkpoints (per D6)

- L2 supervisor/summaries: information-bottleneck discipline — summaries-not-transcripts is the known mitigation; budget trees + named-skip = eval-gated autonomy at the fan-out level.
- Hybrid retrieval: BM25-strong-baseline (BEIR) honored — hybrid must MEASURE its win before becoming default; rerank-after-first-stage is the replicated pattern (cross-encoder literature adapted to cosine).
- Embedding mock determinism: hermetic CI reproducibility (same input → same vector) mirrors the MockProvider discipline.

## Open items (non-blocking, operator input at build time)

1. **Q-embeddings endpoint (Stage E live drill):** z.ai global has NO embeddings (R5). Options: (a) mainland `open.bigmodel.cn/api/paas/v4` with the same key (untested — different platform, may need separate account); (b) any other OpenAI-compatible embeddings endpoint you have; (c) ship hybrid with mock embeddings only and run the live comparison later. The seam is endpoint-agnostic; this only gates the LIVE drill, not the build.
2. **Q-pg test instance (Stage F):** local postgres via Docker for the parameterized leg, or always-skip in CI with sqlite-only? (Default: skip-honestly unless `BUTLER_TEST_PG` set.)

## Rollout

All work on `main` behind per-stage feature branches (`feat/demo-ui`, `feat/orchestration-l2`, …) — operator merges. Each stage lands with tests green; live drills logged in `docs/drills.md`. No breaking changes to the public barrel (additive exports only).
