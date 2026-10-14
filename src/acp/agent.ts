/** R3-S3: ACP v1 wire — `createAcpAgent()` — the Agent Client Protocol method
 *  surface as a LIBRARY (review R2). One implementation, two transports:
 *  - lionidas imports these handlers in-process and forwards notifications over WS
 *  - `acp-stdio` (bin/) wraps the same handlers for third-party JSON-RPC clients
 *
 *  Scope (plan decisions 4/R3/R4/R8):
 *  - initialize (two-sided capabilities) + session/new|prompt|update|cancel|load|list
 *  - session/update notifications: the 14 kinds mapped from the durable turn events
 *  - fs/* + terminal/* = CLIENT-side methods; we never call them in v0.5.0
 *  - no permission capability advertised (auto-approve unchanged)
 *  - session/prompt returns at TURN end even when a triggered run is gated (the
 *    run lifecycle stays a Lionidas-level API — the ACP/run boundary)
 *
 *  Schema vendored at ../vendor-acp-v1-schema.json (ACP is MIT/Apache-2; the
 *  JSON Schema artifact is used for conformance tests, license-noted here). */

import type { TurnEvent, UsageMeters } from '../orchestrate/turn-engine.ts';

// ── JSON-RPC 2.0 envelope ──

export interface JsonRpcRequest { jsonrpc: '2.0'; id: number | string; method: string; params?: unknown }
export interface JsonRpcNotification { jsonrpc: '2.0'; method: string; params?: unknown }
export interface JsonRpcResponse { jsonrpc: '2.0'; id: number | string; result?: unknown; error?: { code: number; message: string; data?: unknown } }

// ── Capabilities (initialize handshake — ACP v1 shapes) ──

export interface AgentCapabilities {
  loadSession: boolean;
  promptCapabilities: { image: boolean; audio: boolean; embeddedContext: boolean };
}

export const BUTLER_AGENT_CAPS: AgentCapabilities = {
  loadSession: true,
  promptCapabilities: { image: false, audio: false, embeddedContext: false },
};

// ── Session/update kinds (ACP v1 taxonomy; mapped from durable events) ──

export type SessionUpdate =
  | { sessionUpdate: 'user_message_chunk'; content: { type: 'text'; text: string } }
  | { sessionUpdate: 'agent_message_chunk'; content: { type: 'text'; text: string } }
  | { sessionUpdate: 'agent_thought_chunk'; content: { type: 'text'; text: string } | { type: 'reasoning' } }
  | { sessionUpdate: 'tool_call'; toolCallId: string; title: string; kind: 'execute' | 'read' | 'edit' | 'delete' | 'think' | 'fetch' | 'other'; status: 'pending' | 'in_progress' | 'completed' | 'failed'; content?: Array<{ type: 'text'; text: string }>; locations?: unknown[] }
  | { sessionUpdate: 'tool_call_update'; toolCallId: string; title?: string; kind?: 'execute' | 'read' | 'edit' | 'delete' | 'think' | 'fetch' | 'other'; status?: 'pending' | 'in_progress' | 'completed' | 'failed'; content?: Array<{ type: 'text'; text: string }>; locations?: unknown[] }
  | { sessionUpdate: 'plan'; plan: unknown }
  | { sessionUpdate: 'available_commands_update'; commands: unknown[] }
  | { sessionUpdate: 'current_mode_update'; current_mode_id: string }
  | { sessionUpdate: 'config_option_update'; config_option: unknown }
  | { sessionUpdate: 'session_info_update'; session_info: unknown }
  | { sessionUpdate: 'usage_update'; usage: { context_window_used: number; context_window_size: number; cost: number } }
  | { sessionUpdate: 'notice'; notice: { message: string; level: 'info' | 'warning' | 'error'; id?: string } }
  | { sessionUpdate: 'compaction_update'; compaction: { id: string; status: 'pending' | 'in_progress' | 'completed' | 'failed' } }
  | { sessionUpdate: 'compaction_summary_chunk'; compaction_id: string; chunk: { type: 'text'; text: string } };

/** Map one durable turn event → zero or more ACP session/update notifications. */
export function toSessionUpdate(e: TurnEvent): SessionUpdate[] {
  switch (e.kind) {
    case 'user_message.recorded':
      return [{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: e.detail.content } }];
    case 'chunk':
      return [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: e.detail.delta } }];
    case 'tool_call':
      return [{ sessionUpdate: 'tool_call', toolCallId: e.detail.toolCallId, title: e.detail.name, kind: 'other', status: 'pending' }];
    case 'tool_call_update':
      return [{ sessionUpdate: 'tool_call_update', toolCallId: e.detail.toolCallId, status: e.detail.isError ? 'failed' : 'completed', ...(e.detail.result !== undefined ? { content: [{ type: 'text', text: e.detail.result }] } : {}) }];
    case 'usage': {
      const m = e.detail as UsageMeters;
      return [{ sessionUpdate: 'usage_update', usage: { context_window_used: m.contextUsed, context_window_size: m.contextWindow, cost: m.cost } }];
    }
    case 'compaction':
      return [
        { sessionUpdate: 'compaction_update', compaction: { id: `c_${e.id}`, status: 'completed' } },
        { sessionUpdate: 'compaction_summary_chunk', compaction_id: `c_${e.id}`, chunk: { type: 'text', text: e.detail.summary } },
      ];
    case 'message.queued':
    case 'queue.updated':
      return [{ sessionUpdate: 'notice', notice: { message: e.kind === 'message.queued' ? 'message queued' : 'queue updated', level: 'info' } }];
    case 'turn.failed':
      return [{ sessionUpdate: 'notice', notice: { message: `turn failed: ${e.detail.error}`, level: 'error' } }];
    default:
      return []; // turn.requested/started/completed/aborted/session.imported ride the RPC response, not updates
  }
}

// ── The agent surface (transport-agnostic) ──

export interface AcpAgentDeps {
  /** create a new session — returns the ACP sessionId */
  newSession(): Promise<string>;
  /** run one turn to completion (the ACP/run boundary: returns at TURN end) */
  prompt(sessionId: string, text: string): Promise<{ stopReason: 'end_turn' | 'cancelled' | 'refusal' | 'max_tokens'; summary?: string }>;
  /** cancel the in-flight turn of a session */
  cancel(sessionId: string): Promise<void>;
  /** resume notifications from afterSeq (client reconnect replay) */
  updates(sessionId: string, afterSeq: number): Promise<TurnEvent[]>;
  /** list sessions */
  listSessions(): Promise<Array<{ sessionId: string; title?: string }>>;
  /** load a prior session's events for replay */
  loadSession(sessionId: string): Promise<TurnEvent[]>;
}

export interface AcpAgent {
  initialized: boolean;
  handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse>;
  /** subscribe to session/update notifications (transport forwards these) */
  onUpdate(listener: (sessionId: string, update: SessionUpdate) => void): () => void;
}

export function createAcpAgent(deps: AcpAgentDeps): AcpAgent {
  const listeners = new Set<(sessionId: string, update: SessionUpdate) => void>();
  const emit = (sessionId: string, u: SessionUpdate) => { for (const l of listeners) l(sessionId, u); };

  const agent: AcpAgent = {
    initialized: false,
    onUpdate(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async handleRequest(req) {
      try {
        switch (req.method) {
          case 'initialize':
            agent.initialized = true;
            return { jsonrpc: '2.0', id: req.id, result: { protocolVersion: 1, agentCapabilities: BUTLER_AGENT_CAPS, authMethods: [] } };
          case 'session/new':
            if (!agent.initialized) return err(req.id, -32000, 'initialize first');
            return { jsonrpc: '2.0', id: req.id, result: { sessionId: await deps.newSession() } };
          case 'session/prompt': {
            if (!agent.initialized) return err(req.id, -32000, 'initialize first');
            const p = req.params as { sessionId: string; prompt: Array<{ type: string; text?: string }> };
            const text = (p.prompt ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('');
            const out = await deps.prompt(p.sessionId, text);
            return { jsonrpc: '2.0', id: req.id, result: { stopReason: out.stopReason, ...(out.summary !== undefined ? { summary: out.summary } : {}) } };
          }
          case 'session/cancel': {
            const p = req.params as { sessionId: string };
            await deps.cancel(p.sessionId);
            return { jsonrpc: '2.0', id: req.id, result: {} };
          }
          case 'session/load': {
            const p = req.params as { sessionId: string; events?: unknown[] };
            const events = await deps.loadSession(p.sessionId);
            return { jsonrpc: '2.0', id: req.id, result: { sessionId: p.sessionId, ...(events.length ? { events } : {}) } };
          }
          case 'session/list':
            return { jsonrpc: '2.0', id: req.id, result: { sessions: await deps.listSessions() } };
          default:
            return err(req.id, -32601, `method not found: ${req.method}`);
        }
      } catch (e) {
        return err(req.id, -32000, e instanceof Error ? e.message : String(e));
      }
    },
  };
  return agent;
}

function err(id: number | string, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
