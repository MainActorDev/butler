# Adopting Butler — the consumer contract

How a second product (after the demo) builds on Butler. Lionidas's integration
plan is a concrete instance of this document.

## What you bring

1. **A provider config** — any OpenAI-compatible base URL + key + model.
2. **Tools** — your domain's tools, registered with a permission class
   (`read` / `draft` / `act`) and a JSON schema each. Your validators are the
   ground truth: register a `*.validate` tool and never let the model judge its
   own output.
3. **A policy** — pick `READ_ONLY`, `DRAFT`, or `ACT` per integration surface.
   Start at `DRAFT` (authoring-only); graduate only with evals that can fail.
4. **Sources** — `file` / `jira` / `github` / `repo` connectors (or your own
   `SourceConnector`), plus an artifacts dir for binaries.
5. **A sqlite file you own** — `new SqliteStorage(path)`. Butler's migrations
   are guarded and idempotent; the file lives wherever your app's data lives.
6. **A Fastify app** (or any HTTP host that can hand raw req/res to the SDK) —
   mount `registerConversationApi` + `mountMcp`, and wire `emit` to your
   WebSocket bus.

## What you get for free

- The bounded ReAct loop (hops/tokens/wall budgets, abort, per-turn accounting)
- Policy-gated tool execution with named refusals
- Sessions/messages/notes persistence with resume-from-rows
- Provenance-stamped notes with supersession (audit-safe memory)
- Content-addressed ingestion with structural chunking + BM25 retrieval
- The conversation API AND the MCP surface over the same registry
- The eval harness (retrieval/budget/authoring) for CI

## Rules of engagement

- **Dependency direction:** your app imports Butler; Butler never imports you.
  If Butler needs your data, expose it as a tool or a retrieval provider.
- **No domain vocabulary in the core.** Butler knows documents, notes, tools,
  sessions, sources — not cases, screens, or runs. Keep it that way when adding
  tools: `spec.validate` is a fine name; `case.yaml.validate` belongs to YOUR
  app's tool names, and that's fine too — the core doesn't care.
- **Autonomy is a policy, not a fork.** Don't patch the loop to restrict the
  agent — register the act tools and run under `DRAFT`. The refusal is the
  product behavior (the demo's `spec.publish` shows the pattern).
- **Notes need provenance.** Every `insertNote` carries `source_ref`; blank
  refs are rejected. Supersede, never delete.
- **Evals gate autonomy.** Before flipping a surface from `DRAFT` to `ACT`,
  you need eval cases whose failure would block the flip — the canary pattern
  in `test/eval.test.ts` is the minimum bar.

## Known limits (v0.1)

- Orchestration L2 is seams-only (session trees representable; no supervisor
  machinery — ROADMAP lists the triggers).
- Embeddings/Layer-3 retrieval deferred until SQL+notes demonstrably fail.
- sqlite only (postgres driver later); MCP stdio bin later; no image OCR.

## Checklist for a new consumer

- [ ] Provider config + smoke test (`docs/drills.md` pattern)
- [ ] Tools registered, permission classes assigned, validator tool present
- [ ] Policy chosen per surface; refusal test written
- [ ] Sources + artifacts dir wired; ingestion caps reviewed
- [ ] Conversation API mounted behind YOUR auth; emit → your WS bus
- [ ] MCP mounted (optional) — verify tools/list filtering
- [ ] Eval fixtures for YOUR domain; canary present
- [ ] A live drill logged in `docs/drills.md`
