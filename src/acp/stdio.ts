#!/usr/bin/env node
/** R3-S3: acp-stdio — the thin transport wrapper (review R2). Reads JSON-RPC
 *  from stdin, writes to stdout (newline-delimited). SAME handlers as the
 *  in-process consumers: no protocol logic lives here. SIGTERM/SIGINT drain.
 *  Wires the ACP surface onto the durable engine via a host-provided factory
 *  (see bin wiring in package.json → src/acp/stdio-main.ts for the default). */

import { createAcpAgent, type AcpAgentDeps, type JsonRpcNotification } from './agent.ts';
import { EventSink } from '../orchestrate/event-sink.ts';
import { EffectWorker } from '../orchestrate/effect-worker.ts';
import type { Provider, ProviderMessage } from '../provider/types.ts';
import { toSessionUpdate } from './agent.ts';

export interface StdioAgentConfig {
  db: import('better-sqlite3').Database;
  provider: Provider;
  systemPrompt: string;
  contextWindow: number;
  tools?: import('../loop.ts').LoopTool[];
  history?: ProviderMessage[];
}

/** Build the transport-neutral deps from the durable engine. */
export function engineDeps(cfg: StdioAgentConfig): AcpAgentDeps {
  const sink = new EventSink(cfg.db);
  let counter = 0;
  const workers = new Map<string, EffectWorker>(); // sessionId → worker

  const ensureWorker = (sessionId: string) => {
    let w = workers.get(sessionId);
    if (!w) {
      w = new EffectWorker({ sink, provider: cfg.provider, systemPrompt: cfg.systemPrompt, tools: cfg.tools ?? [], contextWindow: cfg.contextWindow, ...(cfg.history !== undefined ? { history: cfg.history } : {}) });
      workers.set(sessionId, w);
    }
    return w;
  };

  return {
    async newSession() {
      counter += 1;
      const id = `acp_sess_${Date.now().toString(36)}_${counter}`;
      sink.handle(id, { kind: 'session.import', sessionId: id, note: 'ACP session/new' }, `acp:new:${id}`);
      return id;
    },
    async prompt(sessionId, text) {
      const turnId = `t_${Date.now().toString(36)}_${counter++}`;
      const { effects } = sink.handle(sessionId, { kind: 'turn.request', sessionId, turnId, prompt: text, refIds: [], at: Date.now() }, `acp:prompt:${turnId}`);
      void effects;
      // stream events as session/update notifications while the turn runs
      const seen = new Set<number>();
      const emitLine = (line: string) => {
        try { process.stdout.write(`${line}\n`); } catch { /* client gone: stop emitting (EPIPE) */ }
      };
      const flush = () => {
        let highest = 0;
        for (const n of seen) if (n > highest) highest = n;
        for (const e of sink.events(sessionId)) {
          if (e.seq <= highest || seen.has(e.seq)) continue;
          seen.add(e.seq);
          for (const u of toSessionUpdate(e)) {
            emitLine(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } } satisfies JsonRpcNotification));
          }
        }
      };
      const watcher = setInterval(flush, 25);
      try {
        flush();                       // events already appended (request/user_message/start)
        const draining = ensureWorker(sessionId).drain();
        flush();                       // anything the first synchronous stretch appended
        await draining;
        flush();                       // final events (complete/fail) — the interval may have missed the tail
        const evs = sink.events(sessionId);
        const last = evs.filter((e) => e.turn_id === turnId).at(-1);
        if (last?.kind === 'turn.failed') return { stopReason: 'refusal' as const, summary: last.detail.error };
        return { stopReason: 'end_turn' as const, ...(last?.kind === 'turn.completed' ? { summary: last.detail.answer.slice(0, 200) } : {}) };
      } finally {
        clearInterval(watcher);
      }
    },
    async cancel(sessionId) {
      sink.handle(sessionId, { kind: 'turn.abort', sessionId, turnId: '', reason: 'client cancel' }, `acp:cancel:${sessionId}:${Date.now()}`);
    },
    async updates(sessionId, afterSeq) { return sink.events(sessionId, afterSeq); },
    async listSessions() { return []; }, // host overrides for real listings
    async loadSession(sessionId) { return sink.events(sessionId); },
  };
}

export function runStdio(deps: AcpAgentDeps): void {
  const agent = createAcpAgent(deps);
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let req: { jsonrpc?: string; id?: number | string; method?: string; params?: unknown };
      try { req = JSON.parse(line); } catch { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`); continue; }
      if (req.method === undefined) continue; // responses from client (none expected v0.5.0)
      if (req.id === undefined) continue;     // client → agent notifications (none in v0.5.0 scope)
      void agent.handleRequest(req as never).then((res) => { process.stdout.write(`${JSON.stringify(res)}\n`); });
    }
  });
  const drain = () => { setTimeout(() => process.exit(0), 10).unref?.(); };
  process.on('SIGTERM', drain);
  process.on('SIGINT', drain);
}
