# ROADMAP — Butler

## orchestration-L2 — ✅ BUILT (2026-10-01, roadmap-completion plan Stage D)

The operator fired the trigger deliberately ("finish the roadmap"), with
eval-fanout as the lead use case. Shipped per the D16 deal — evals FIRST
(`test/eval-orchestration.test.ts`: completion, roll-up, structural
concurrency, named-skip), then machinery (`src/orchestrate/supervisor.ts`):
fanOut with per-child providers, budget roll-up (tokens/wall pro-rata from
the parent remainder; hops stay per-loop ceilings — dividing them starved
children, caught live), summaries-not-transcripts (information bottleneck),
session-tree rows (the Stage-2 seam earning its keep), and agent.spawn as a
draft-class tool.

Deferred to a future trigger: cross-process fleets (L3), durable supervision,
cancellation-graph hardening beyond the single-process AbortSignal chain.

## Other deferred items (from plan out-of-scope)

- Embeddings/vector retrieval (Layer 3) — only on the documented trigger: a real
  query SQL+notes cannot answer.
- ~~Postgres storage driver~~ ✅ built (src/memory/postgres.ts; contract suite parameterized over both drivers — pg leg runs when BUTLER_TEST_PG is set, skips honestly otherwise; no local pg on this machine at build time, so the pg leg ran skipped: mechanism reviewed, execution awaits a pg instance).
- ~~MCP stdio bin~~ ✅ built (bin/butler-mcp.ts, proven with a real SDK client over stdio).
- tree-sitter symbol indexing — repo connector v1 is tree + grep + file fetch.
- Lionidas integration — its own plan in the Lionidas repo (seed: plan
  `20261001T035356Z` follow-up section).
