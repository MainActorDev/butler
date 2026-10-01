# ROADMAP — Butler

## orchestration-L2 (seams shipped; machinery NOT built — D16)

**Status:** seams only. `butler_sessions.parent_session_id` + `depth` exist and are
tested (session-tree test in Stage 2); the spawn-tool slot is documented as an
extension point in `src/tools.ts`. No supervisor, no child-session machinery, no
budget roll-up exists yet — by decision, not neglect (brainstorm
`20261001T081628Z` §2 risk register: no paying use case, cost multiplies
through every subsystem, testing goes nonlinear, library-not-daemon).

**Trigger conditions — graduate this entry to a plan when any fires:**
- A real ingestion workload needs PARALLEL sub-tree processing (e.g. one child
  per repo subtree, chunking large repos within sane wall-clock).
- Per-failed-run triage wants one child agent per failed run (post-autonomy).
- Eval fan-out demands concurrent fixture runs to stay inside CI time.

When a trigger fires: write the L2 plan with its own evals FIRST (eval-gated
autonomy, plan D6), then build budget trees, cancellation propagation, and the
supervisor loop. Do not build ahead of the trigger.

## Other deferred items (from plan out-of-scope)

- Embeddings/vector retrieval (Layer 3) — only on the documented trigger: a real
  query SQL+notes cannot answer.
- Postgres storage driver — interface ships in v1; driver when a consumer needs it.
- MCP stdio bin — when a CLI consumer exists.
- tree-sitter symbol indexing — repo connector v1 is tree + grep + file fetch.
- Lionidas integration — its own plan in the Lionidas repo (seed: plan
  `20261001T035356Z` follow-up section).
