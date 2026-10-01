# Butler API — package surface (v0.1)

Butler is a reusable agent runtime. A consumer brings: a provider config, tools,
a policy, sources, and a place to put the sqlite file. Butler brings everything
else. Every export lives in `@mainactordev/butler` (single barrel `src/index.ts`).

## Provider (`src/provider/`)

```ts
import { OpenAICompatProvider } from '@mainactordev/butler';

const provider = new OpenAICompatProvider({
  baseUrl: 'https://api.z.ai/api/paas/v4',   // any OpenAI-compatible base
  apiKey: process.env['BUTLER_API_KEY']!,
  model: 'glm-5.3-flash',
}); // per-call timeout 120s default; retries 429/5xx; retries capped by YOUR wall budget
```

- `MockProvider(scriptedTurns)` — deterministic turns for tests (incl. `{kind:'hang'}`).
- `ProviderError` codes: `PROVIDER_UNAVAILABLE | PROVIDER_TIMEOUT | PROVIDER_BAD_REQUEST`.

## Loop (`runLoop`)

```ts
const result = await runLoop(systemPrompt, userMessage, {
  provider, tools,
  budget: { maxHops: 12, maxTokens: 200_000, wallMs: 600_000 }, // DEFAULT_BUDGET
  onMessage: (m, meta) => persist(m, meta),   // every message, with per-turn tokens
  onEvent: (e) => bus.emit(e),                // turn.start/provider.response/tool.call/...
  signal: abortController.signal,             // cooperative cancel
});
// result: { answer, messages, hops, tokens: {in, out}, wallMs }
```

Guarantees: the LOOP owns the wall clock (a hanging provider is aborted at the
deadline); tool-handler throws become observations (ReAct); invalid tool-call
JSON gets ONE repair prompt then `TOOL_CALL_INVALID`; every error carries the
partial transcript (`LoopError.partial`) so sessions stay resumable.

## Tools + policy (`ToolRegistry`)

```ts
const registry = new ToolRegistry()
  .register({ name: 'docs.read', description: '…', parameters: JSON_SCHEMA,
              permission: 'read',  execute: async (args, ctx) => 'string' })
  .register({ /* … permission: 'draft' … */ })
  .register({ name: 'thing.publish', permission: 'act', /* … */ });

await registry.execute('thing.publish', {}, ctx, DRAFT);
// → PolicyRefusal: tool "thing.publish" requires act permission; policy draft
```

Policies: `READ_ONLY < DRAFT < ACT`. Provider-visible tool lists are filtered
by policy with the class stamped in the description.

## Memory (`Storage` seam; `SqliteStorage` driver)

```ts
const storage = new SqliteStorage('./agent.db');  // consumer owns the file
await storage.createSession({ id, title });
await storage.appendMessage({ session_id, role: 'user', content, … });
const note = await storage.insertNote({ scope_key, kind: 'pitfall', content,
  source_type: 'session', source_ref: sessionId /* MANDATORY */, created_by });
await storage.supersedeNote(oldId, newId, Date.now()); // never deleted — audit trail
```

Tables: `butler_sessions` (incl. `parent_session_id`/`depth` orchestration seam —
tested, machinery deferred per ROADMAP), `butler_messages`, `butler_notes`,
`butler_sources`, `butler_documents`, `butler_document_chunks`.

## Sources + ingestion

```ts
import { fileConnector, jiraConnector, githubConnector, repoConnector, ingest } from '@mainactordev/butler';

const result = await ingest(fileConnector('my-files', { root: './docs' }), storage, {
  artifactsDir: './artifacts',                       // binaries land here, never in the DB
  writeBinary: async (sha, bytes) => writeSomewhere(sha, bytes),
});
// result.documents: [{ sha256, uri, title, chunks, cached }] — content-addressed, cache-first
```

Caps: 2 MB text/doc (truncate-with-marker), 10k chunks/source, 20 MB binaries.
Chunking is structural: markdown headings, diff file-sections, ticket fields.

## Retrieval (`StorageRetriever` / `bm25Rank`)

```ts
const retriever = new StorageRetriever(storage);
retriever.registerChunks(await storage.documentChunks(sha));  // after ingest
const hits = await retriever.retrieve('login settle wait', 3); // BM25, sorted
```

Embeddings are deliberately deferred (BEIR-first; ROADMAP holds the trigger).

## Transports (mount on YOUR Fastify app)

```ts
import { registerConversationApi, mountMcp } from '@mainactordev/butler';

await registerConversationApi(app, { storage, provider, registry, policy: DRAFT,
  systemPrompt: '…', emit: (e) => wsBus.broadcast(e) });   // POST/GET /api/agent/*
await mountMcp(app, { registry, policy: DRAFT, serverInfo: { name, version } }); // POST /mcp
```

- Conversation API: `POST /api/agent/sessions`, `GET /:id`, `POST /:id/messages`
  (returns `{ turn: { ok, answer?, error?, code?, tokens, hops } }`). Sessions
  resume from rows alone.
- Turn events (`turn.start`, `provider.response`, `tool.call`, `tool.result`,
  `turn.end`, `turn.error`) flow to your `emit` sink — wire it to YOUR WebSocket
  bus (`butler.*` naming convention). No SSE anywhere.
- MCP: stateless streamable-HTTP via the official SDK; tools/list is
  policy-filtered; tools/call drives the same gated registry.

## Eval harness (`evalRetrieval` / `evalBudget` / `evalAuthoring`)

Fixture-driven metrics that run in CI and can fail. The authoring eval's judge
is YOUR validator (ground truth, never model self-report). See `test/eval.test.ts`
for the canary pattern (an intentionally wrong expectation must fail the suite
on the metric assertion).
