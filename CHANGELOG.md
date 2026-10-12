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
