## [Unreleased] (detached send, server-owned queue, steering, push-on-append)

### Added
- **Detached send (opt-in)** — `POST /api/agent/sessions/:id/messages` with `detach: true`
  (requires an execution authority; else `400 DETACH_UNSUPPORTED`) answers at once:
  `202 {startedTurnId}` when idle, `202 {queued: {queueId, disposition}}` when busy
  (`mode: 'steer' | 'queue'`). Without `detach` the route is unchanged (held response).
- **Server-owned queue** — identity-bearing `message.queued` (`queueId`, `body {commands, model}`,
  request id + principal + fingerprint), one `queue.removed {queueId, reason: claimed | deleted |
  delivered}` row per removal, `queue.updated` snapshots gain parallel `ids`.
  `DELETE /api/agent/sessions/:id/queue/:queueId` removes a pending item.
- **Claim-all drain** — when any admitted turn (held or detached) settles, or the authority
  becomes ready at boot, every pending item runs as ONE next turn. The claim, the user row
  (`content` = the items' own text, `items[]`) and `turn.started` commit in one transaction;
  the composed prompt (`[N queued messages]` + items) goes only to the model. Legacy queue rows
  without ids are never auto-run. A runaway guard refuses to claim an id twice in one process.
- **Steering** — `LoopDeps.takeSteering` is called at each tool boundary; the transport's
  `steer.deliver` command records `queue.removed (delivered)`, `steer.delivered` and a
  `user_message.recorded {via: 'steer'}` row (so later turns keep it in model history) in one commit.
- **Duplicate-submit guard** — before reservation, a detached send's `clientRequestId` is looked
  up across admitted turns and every queued item (pending or gone): same content → the existing
  `startedTurnId` / `queueId`, different content → `409 REQUEST_ID_REUSE`.
- **`EventSink.onAppend(listener)`** — committed rows pushed per session, only after the
  outermost transaction commits; rollbacks are never pushed; listener faults are isolated.
- **`ExecutionAuthority.beginShutdown()`** — closing gate: nothing new is reserved after it, so a
  turn settling during shutdown cannot start queued work. Hosts call it before aborting turns.
- **`session.notice {level, text}`** row kind; written when a detached turn's finalization keeps
  failing after bounded retries (`ConversationDeps.finalizeRetryMs`, default 1s/5s/30s; the retry
  stops at shutdown and leaves the attempt reserved for recovery).

### Fixed
- Tool events without an invocation id get a per-turn counter id (`tc_<turn>_n<k>`, paired FIFO
  by name) instead of the bare tool name, in the conversation transport and workflow runs.
- `TurnEventBase.seq` comment: per-session, not per-turn (the schema is `UNIQUE(session_id, seq)`).

## [0.8.0] — 2026-10-21 (Stage 3: tree-sitter symbols + watchRoots + structured search)

### Added
- **tree-sitter WASM symbol extraction** — `extractSymbolsTree`/`symbolsFor` parse Swift /
  TypeScript / TSX / JS / Python via `web-tree-sitter` (0.25.4) + the `tree-sitter-wasms` pack.
  Grammar policy is CALLER-supplied (`SymbolGrammars`: ext → pack name or absolute .wasm path);
  `defaultSymbolGrammars()` ships butler's preset. No grammar configured → v1 TS/JS regex
  fallback; grammar load failure → empty result, never fatal.
  **Vendored `grammars/tree-sitter-swift.wasm`** (from tree-sitter-wasms@0.1.8): the pack's
  swift build ≥ 0.1.10 aborts Node ≥ 24 (`Fatal process out of memory: Zone`, V8 turboshaft
  wasm tier-up — background thread, process-fatal; `--liftoff-only` avoids it but is banned in
  NODE_OPTIONS). See grammars/README.md; re-extract when upstream fixes it.
- **Per-symbol chunks (F1)** — `NormalizedDocument.chunks?` passthrough: ingest stores
  pre-chunked docs verbatim. `repoConnector(symbols: true)` now emits one chunk per symbol with
  `heading_path "symbol: <name> (<kind>)"` (v1 concatenated all symbols into doc content,
  unretrievable by heading). Doc content stays a browsable summary.
- **`repoDocumentFor(cfg, absPath)`** (F3) — per-file normalize (file doc + symbol doc) honoring
  the same skip rules; the freshness watcher path re-ingests one changed file without paying the
  walk. `symbolDocFor` exported alongside.
- **`watchRoots(roots, opts, onBatch)`** — debounced changed-path batches, one OS watch per root
  (no polling), caller-supplied ignore policy, `healthy()`/`describe()` surface; watcher errors
  mark the root dead, never throw into the caller's loop.
- **`EsCompatRetriever.search({ query, headingPrefix?, size })`** (F2) — structured search:
  BM25 + optional heading_path prefix filter (match_phrase_prefix over the analyzed field).
  Same throw contract as `retrieve()`.
- Hermetic tests: WASM extraction per language, per-file normalize, chunks passthrough +
  idempotence, watcher batches/ignore/health (real fs events, tmp dirs), structured search
  (fake endpoint). Full suite 226 passed; `node:module` + `web-tree-sitter` added to the
  boundary allowlist.

## [0.7.0] — 2026-10-21 (Stage 2b: ES-compatible retrieval + xerj sidecar runner)

### Added
- `EsCompatRetriever` — a `Retriever` over any Elasticsearch-compatible HTTP endpoint (xerj in
  practice). BM25-only by design (Lionidas Stage-1 evidence: parity with in-memory BM25 at ~400×
  lower latency; hybrid/semantic added nothing on the eval corpus). Hit ids carry provenance:
  `<docSha256>#<ordinal>` (chunks) / `note:<id>` (notes). Failures throw — degradation is the
  runner's decision.
- `xerjSidecar()` — optional one-call runner: locate/spawn the sidecar (loopback, pinned flags),
  health-wait, then a resumable reconcile (mget existence checks + bulk with retries) from a
  consumer-supplied corpus enumerator (butler has no list-all seam). Returns
  `{ retriever, degraded, indexedCount, stop }`; every failure is a degraded result with the
  explicit install hint — never a throw, never a silent install, nothing spawns at import.
- `chunkToEsDoc` / `noteToEsDoc` helpers mapping butler row shapes to index docs.
- Hermetic tests over a fake ES endpoint (injectable fetch + spawn): provenance mapping, throw
  contract, attach/reconcile/idempotent-skip/degraded paths.

## [0.5.0] — 2026-10-13 (R3 final)

### Added (since rc)
- Orphan recovery: turns left `running`/`requested` by a dead process are marked failed at sink construction, partial content preserved (kill -9 semantics, live-drilled).
- Queue-drain seam: a queued followUp with no active turn starts its own turn — no stranded content after crash recovery.
- S6: migration test from a real v0.4.2 DB snapshot (fixture), concurrency (interleaved streams serialize; two sessions zero cross-talk), perf sanity (append < 5ms avg).

## [0.5.0-rc] — 2026-10-13 (R3: durable chat core + ACP v1 wire)

### Added
- Durable turn engine: `butler_turns` / `butler_turn_events` (append-only, parent_id, schema_version), pure orchestrator `decide()`, `EventSink` single-transaction commit (events + projections + receipts + outbox), `EffectWorker` drain. Crash-safe, replay-deterministic, idempotent commands.
- ACP v1 wire: `createAcpAgent()` library + stdio transport (one implementation, two transports). initialize/session lifecycle, 14 session/update kinds validated against the vendored ACP schema, tool patches by toolCallId.
- Budget-never-interrupts policy (operator decision): token cost meter advisory (warns via events), context meter drives auto-compaction at 80% (originals preserved), runaway guard is the only hard cost stop. Fan-out children keep deliberate hard caps (`hardTokenCap`).
- Workflow stage turns join the durable log (optional `deps.sink`); skills replayable; run lifecycle (gates) unchanged.

### Changed
- `runLoop` token budget no longer throws for chat turns (advisory event instead); `hardTokenCap: true` restores the old contract for fan-out.

### Migration
- Existing `butler_sessions`/`butler_messages` remain readable; new turns append events. First evented turn per session writes `session.imported`.

# Changelog

## v0.4.2 (2026-10-12)

Round 2 agent work (Lionidas `feat/agent-round2`).

### Event contract (cleanup note)

The deprecated `tool.call` / `tool.result` event pair is **gone** — removed when `turn.tool` became canonical in v0.3.4. Consumers should treat `turn.tool` (structured `{phase: 'call'|'result', name, arg, result, isError}`) and `turn.delta` as the only tool/text stream events. The workflow engine additionally forwards loop events as `workflow.<type>` (v0.4.1+), carrying `runId` + `stageId`.

### Fixes & features since v0.4.1

- **claude-cli carries conversation history in the prompt** (`5f32c7c`) — `claude -p` is stateless without `--resume`; the provider previously flattened the message list to the last user turn, so transcript rows (including cross-provider workflow-skill rows) vanished from context. History now rides the prompt text under a "Conversation so far" block.
- **Retrieval-based notes** (`9df5d6e`, `2395aaa`) — `butler_note_embeddings` side table (model, dim, vector BLOB) + `noteEmbeddings`/`saveNoteEmbedding` on the storage contract (postgres: honest no-op stubs); `TokenEmbedding` (deterministic IDF-weighted token overlap — the local, no-network embedder; `OpenAICompatEmbedding` remains the seam for real providers); `resolveProfile({embedder?, query?})` ranks scoped notes by cosine; `notesBlockFor` accepts the ranking (order + top-k) with the legacy recency top-20 as the single fallback path; the conversation transport ranks all-notes when the consumer passes an embedder.
- **Session isolation** (`94a3a16`) — `Provider.complete(opts.sessionKey)` addresses `--resume` per caller: one provider instance, many isolated claude sessions. The conversation transport keys by session id; workflow stages key by run id. Fixes cross-session context bleed.
- `TokenEmbedding` exported from the package root (`053ab4d`).

### Known limitations

- `TokenEmbedding` is lexical (no synonym matching) — a real embeddings provider via env supersedes it when available.
- claude-cli spawns per `complete()` (turn-based `-p` model). Measured CLI startup: ~0.44s — a persistent/REPL session is the recorded path if the spawn tax ever matters.
- Postgres storage does not implement note embeddings yet (typed no-ops).
