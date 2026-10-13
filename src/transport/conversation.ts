/** Conversation transport (plan Stage 4): a mountable Fastify plugin exposing
 *  sessions + messages, and emitting turn events on a consumer-provided sink
 *  (`butler.*` event types — D10/F9; no SSE anywhere). Sessions resume from
 *  rows alone (condition 4). */
import type { FastifyInstance } from 'fastify';
import type { Storage } from '../memory/contract.ts';
import { runLoop } from '../loop.ts';
import type { EventSink } from '../orchestrate/event-sink.ts';
import type { Provider } from '../provider/index.ts';
import type { Policy, ToolRegistry } from '../tools.ts';
import type { TurnEvent } from '../loop.ts';
import { toolFromRegistry } from './loop-adapter.ts';
import { notesBlockFor } from '../profile/profile.ts';
import { cosine } from '../embeddings/index.ts';
import type { EmbeddingProvider } from '../embeddings/index.ts';

export interface ConversationDeps {
  /** R3-S5: durable engine — when set, turns ride the event log (single-writer rule) */
  sink?: EventSink;
  /** R3-S5: provider context window for the usage meter (default 200k) */
  contextWindow?: number;
  storage: Storage;
  provider: Provider;
  registry: ToolRegistry;
  policy: Policy;
  systemPrompt: string;
  /** R2-F3: note embedder — enables ranked note injection (falls back to recency) */
  embedder?: EmbeddingProvider;
  budget?: { maxHops?: number; maxTokens?: number; wallMs?: number };
  /** consumer's event sink (WS bus in the demo; anything callable) */
  emit(event: TurnEvent & { sessionId: string }): void;
  /** streaming seam: per-session delta handler factory */
  onDelta?: (sessionId: string) => (delta: string) => void;
}

export interface TurnOutcome {
  sessionId: string;
  ok: boolean;
  answer?: string;
  error?: string | undefined;
  code?: string | undefined;
  tokens: { in: number; out: number };
  hops: number;
}

/** active turns: session id → AbortController (review F1 — abort support) */
const activeTurns = new Map<string, AbortController>();

export async function registerConversationApi(app: FastifyInstance, deps: ConversationDeps): Promise<void> {
  const { storage, registry, policy } = deps;

  // ── consumer API completion (plan Stage B.0) ──

  // sessions list (Sessions browser)
  app.get('/api/agent/sessions', async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(Number.parseInt(q.limit ?? '50', 10) || 50, 200);
    return { sessions: await storage.listSessions(limit) };
  });

  // documents list (Documents browser)
  app.get('/api/agent/documents', async () => {
    const docs = await storage.listDocuments(200);
    return { documents: docs };
  });

  // notes list, provenance included (Notes browser)
  app.get('/api/agent/notes', async () => ({ notes: await storage.activeNotes() }));

  // abort the active turn (review F1): clean ABORTED outcome, partial transcript persisted
  app.post('/api/agent/sessions/:id/abort', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ac = activeTurns.get(id);
    if (!ac) return reply.code(409).send({ error: 'no active turn on this session' });
    ac.abort();
    return { aborting: true };
  });

  app.post('/api/agent/sessions', async (req, reply) => {
    const b = (req.body ?? {}) as { title?: string; userId?: string };
    const id = `sess_${crypto.randomUUID().slice(0, 12)}`;
    const row = await storage.createSession({ id, title: b.title ?? null, user_id: b.userId ?? null });
    reply.code(201);
    return { session: row };
  });

  app.get('/api/agent/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await storage.getSession(id);
    if (!row) return reply.code(404).send({ error: 'session not found' });
    return { session: row, messages: await storage.sessionMessages(id) };
  });

  app.post('/api/agent/sessions/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { content?: string };
    if (!b.content?.trim()) return reply.code(400).send({ error: 'content required' });
    const session = await storage.getSession(id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (activeTurns.has(id)) return reply.code(409).send({ error: 'turn already in flight on this session' });

    // R3-S5 single-writer rule: user message rides the durable log when a sink
    // is wired; the projection writes butler_messages. Legacy path (no sink)
    // keeps the direct append so existing hosts don't break.
    const durableTurnId = `t_${crypto.randomUUID().slice(0, 12)}`;
    if (deps.sink) {
      // R3 queue-drain: a followUp message queued against an earlier (now-dead)
      // turn starts ITS OWN turn — the queue must never strand content silently.
      const st = deps.sink.state(id);
      const queuedIdx = st.queue.followUp.indexOf(b.content);
      const noActive = st.activeTurnId === null;
      if (queuedIdx !== -1 && noActive) {
        // drain: this request IS the queued message → run as the next turn
        deps.sink.handle(id, { kind: 'message.queue', sessionId: id, content: b.content, disposition: 'steering' }, `chat:${id}:${durableTurnId}:dequeue`);
      }
      deps.sink.handle(id, { kind: 'turn.request', sessionId: id, turnId: durableTurnId, prompt: b.content, refIds: [], at: Date.now() }, `chat:${id}:${durableTurnId}`);
    } else {
      await storage.appendMessage({ session_id: id, role: 'user', content: b.content, tool_calls_json: null, tool_results_json: null, tokens_in: 0, tokens_out: 0 });
    }

    // resume context from rows alone (condition 4)
    const history = (await storage.sessionMessages(id))
      .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content ?? '' }));

    const outcome: TurnOutcome = { sessionId: id, ok: false, tokens: { in: 0, out: 0 }, hops: 0 };
    const ac = new AbortController();
    activeTurns.set(id, ac);
    try {
      // core-side note injection (review F3): active notes ride the system
      // prompt, provenance-marked — knowledge crosses sessions
      const notes = await storage.activeNotes();
      // R2-F3: ranked retrieval when the consumer provides an embedder; the
      // legacy recency top-20 remains the fallback (same block renderer)
      let notesBlock = '';
      if (deps.embedder) {
        try {
          const stored = await storage.noteEmbeddings(deps.embedder.model);
          if (stored.length) {
            const qv = (await deps.embedder.embed([b.content]))[0]!;
            const byId = new Map(notes.map((n) => [n.id, n]));
            const ranked = stored
              .map((se) => ({ note: byId.get(se.noteId), score: cosine(qv, Array.from(se.vector)) }))
              .filter((r): r is { note: NonNullable<typeof r.note>; score: number } => r.note !== undefined)
              .sort((a, b2) => b2.score - a.score);
            notesBlock = notesBlockFor(notes, undefined, ranked);
          } else {
            notesBlock = notesBlockFor(notes, undefined);
          }
        } catch { notesBlock = notesBlockFor(notes, undefined); }
      } else {
        notesBlock = notesBlockFor(notes, undefined);
      }
      const sink = deps.sink; // durable path: chunks/tools/usage/completion ride commands
      const result = await runLoop(deps.systemPrompt + notesBlock, b.content, {
        sessionKey: id, // R2-F4: per-Lionidas-session claude --resume isolation
        history: history.length > 1 ? history.slice(-40, -1) : [], // prior turns only — the current message rides as userMessage
        provider: deps.provider,
        tools: registry.list().filter((t) => permissionRank(policy.allows) >= permissionRank(t.permission)).map((t) => toolFromRegistry(t.name, registry, policy, { sessionId: id })),
        ...(deps.budget ? { budget: deps.budget } : {}),
        signal: ac.signal,
        // rev10: live token stream → transport events (WS bridge streams UI)
        ...(deps.onDelta ? { onDelta: deps.onDelta(id) } : {}),
        onMessage: (msg, meta) => {
          if (!sink) void storage.appendMessage({
            session_id: id, role: msg.role, content: msg.content,
            tool_calls_json: msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
            tool_results_json: null, tokens_in: meta.tokensIn, tokens_out: meta.tokensOut,
          });
        },
        onEvent: (e) => {
          deps.emit({ ...e, sessionId: id });
          if (sink) {
            if (e.type === 'turn.delta' && e.detail && typeof e.detail === 'object' && 'delta' in e.detail) sink.handle(id, { kind: 'turn.chunk', sessionId: id, turnId: durableTurnId, delta: String((e.detail as { delta: unknown }).delta) }, `chat:${durableTurnId}:d:${Math.random()}`);
            if (e.type === 'provider.response' && e.detail && typeof e.detail === 'object' && 'tokens' in e.detail) {
              const t = (e.detail as { tokens?: { promptTokens?: number; completionTokens?: number } }).tokens;
              if (t) sink.handle(id, { kind: 'turn.usage', sessionId: id, turnId: durableTurnId, meters: { cost: (t.promptTokens ?? 0) + (t.completionTokens ?? 0), contextUsed: t.promptTokens ?? 0, contextWindow: deps.contextWindow ?? 200_000 } }, `chat:${durableTurnId}:u:${Math.random()}`);
            }
          }
        },
      });
      if (sink) sink.handle(id, { kind: 'turn.complete', sessionId: id, turnId: durableTurnId, answer: result.answer }, `chat:${durableTurnId}:done`);
      outcome.ok = true;
      outcome.answer = result.answer;
      outcome.tokens = result.tokens;
      outcome.hops = result.hops;
      await storage.updateSession(id, { status: 'active', tokens_in: session.tokens_in + result.tokens.in, tokens_out: session.tokens_out + result.tokens.out });
      activeTurns.delete(id);
      return { turn: outcome };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      outcome.error = e.message ?? String(err);
      if (deps.sink) deps.sink.handle(id, { kind: 'turn.fail', sessionId: id, turnId: durableTurnId, error: outcome.error }, `chat:${durableTurnId}:fail`);
      outcome.code = e.code ?? undefined;
      await storage.updateSession(id, { status: 'error' });
      activeTurns.delete(id);
      return { turn: outcome }; // the turn failed; the REQUEST succeeded — outcome carries the verdict
    }
  });
}

function permissionRank(p: 'read' | 'draft' | 'act'): number {
  return p === 'read' ? 0 : p === 'draft' ? 1 : 2;
}
