/** R3-S1: the durable turn engine's pure core — commands, events, and the
 *  orchestrator that decides them. NO I/O: (state, command) → events, ever.
 *  Persistence (EventSink), side effects (EffectWorker), and the ACP wire live
 *  beside this, never inside it.
 *
 *  Design lineage (plans/20261013T034831Z, commits d40295b..efa6a00):
 *  - t3code orchestration-v2: pure orchestrator, single-txn EventSink, outbox
 *  - ACP v1: event vocabulary shapes (session/update kinds), patch-by-id tools
 *  - pi: session TREE (parent_id), steering vs follow-up queues
 *  - operator decision 4: cost budget is ADVISORY; context drives compaction */

// ── Events (append-only; schema_version stamped from day one — dsh discipline) ──

export const TURN_EVENT_SCHEMA_VERSION = 1;

export interface TurnEventBase {
  id: string;                    // ULID-ish, assigned by the sink at append
  turn_id: string;
  session_id: string;
  parent_id: string | null;      // pi: tree-ready from day one (nullable column)
  schema_version: number;        // frozen-migration discipline (dsh)
  seq: number;                   // per-turn monotonic, assigned by the sink
  at: number;                    // epoch ms, assigned by the sink
}

export type TurnEventKind =
  | 'session.imported'
  | 'turn.requested'
  | 'turn.started'
  | 'user_message.recorded'
  | 'message.queued'             // pi: follow-up queue entry (decided, visible)
  | 'queue.updated'              // pi: steering/follow-up queue state changes
  | 'chunk'                      // assistant text delta
  | 'tool_call'                  // ACP entity: first sighting fixes timeline position
  | 'tool_call_update'           // ACP patch by toolCallId (never order-correlation)
  | 'usage'                      // ACP usage_update: BOTH meters
  | 'compaction'                 // originals preserved; summary entry recorded
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.aborted';

export interface UsageMeters {
  /** Σ per-hop tokens — ADVISORY only (operator decision 4). Never aborts. */
  cost: number;
  /** last-hop input tokens vs provider window — drives auto-compaction. */
  contextUsed: number;
  contextWindow: number;
}

export type TurnEvent =
  | (TurnEventBase & { kind: 'session.imported'; detail: { note: string } })
  | (TurnEventBase & { kind: 'turn.requested'; detail: { prompt: string; refIds: string[] } })
  | (TurnEventBase & { kind: 'turn.started'; detail: {} })
  | (TurnEventBase & { kind: 'user_message.recorded'; detail: { role: 'user' | 'assistant'; content: string } })
  | (TurnEventBase & { kind: 'message.queued'; detail: { content: string; disposition: 'steering' | 'followup' } })
  | (TurnEventBase & { kind: 'queue.updated'; detail: { steering: string[]; followUp: string[] } })
  | (TurnEventBase & { kind: 'chunk'; detail: { delta: string } })
  | (TurnEventBase & { kind: 'tool_call'; detail: { toolCallId: string; name: string; arg?: string } })
  | (TurnEventBase & { kind: 'tool_call_update'; detail: { toolCallId: string; result?: string; isError?: boolean } })
  | (TurnEventBase & { kind: 'usage'; detail: UsageMeters })
  | (TurnEventBase & { kind: 'compaction'; detail: { summary: string; preservedEventIds: string[] } })
  | (TurnEventBase & { kind: 'turn.completed'; detail: { answer: string } })
  | (TurnEventBase & { kind: 'turn.failed'; detail: { error: string; partial?: string } })
  | (TurnEventBase & { kind: 'turn.aborted'; detail: { reason: string } });

// ── Commands (the ONLY way state changes) ──

export type TurnCommand =
  | { kind: 'session.import'; sessionId: string; note: string }
  | { kind: 'turn.request'; sessionId: string; turnId: string; prompt: string; refIds: string[]; at: number }
  | { kind: 'message.append'; sessionId: string; role: 'user' | 'assistant'; content: string; narrative?: boolean }
  | { kind: 'message.queue'; sessionId: string; content: string; disposition: 'steering' | 'followup' }
  | { kind: 'turn.start'; sessionId: string; turnId: string }
  | { kind: 'turn.chunk'; sessionId: string; turnId: string; delta: string }
  | { kind: 'turn.tool'; sessionId: string; turnId: string; phase: 'call' | 'update'; toolCallId: string; name?: string; arg?: string; result?: string; isError?: boolean }
  | { kind: 'turn.usage'; sessionId: string; turnId: string; meters: UsageMeters }
  | { kind: 'turn.compaction'; sessionId: string; turnId: string; summary: string; preservedEventIds: string[] }
  | { kind: 'turn.complete'; sessionId: string; turnId: string; answer: string }
  | { kind: 'turn.fail'; sessionId: string; turnId: string; error: string; partial?: string }
  | { kind: 'turn.abort'; sessionId: string; turnId: string; reason: string };

// ── Orchestrator state (loaded per session; projections derive from events) ──

export interface QueueState {
  steering: string[];
  followUp: string[];
}

export interface OrchestratorState {
  sessionId: string;
  turns: Array<{ id: string; status: 'requested' | 'running' | 'completed' | 'failed' | 'aborted'; prompt: string }>;
  activeTurnId: string | null;
  queue: QueueState;
  imported: boolean;
}

export function initialState(sessionId: string): OrchestratorState {
  return { sessionId, turns: [], activeTurnId: null, queue: { steering: [], followUp: [] }, imported: false };
}

// ── The pure orchestrator: decide(state, command) → events ──
// Idempotency: the sink checks command receipts before invoking decide; a replayed
// command never reaches here. The orchestrator itself stays pure and total.

export function decide(state: OrchestratorState, cmd: TurnCommand): TurnEvent[] {
  const S = (turn_id: string): TurnEventBase => ({
    id: '', turn_id, session_id: state.sessionId, parent_id: null,
    schema_version: TURN_EVENT_SCHEMA_VERSION, seq: 0, at: 0,
  });

  switch (cmd.kind) {
    case 'session.import':
      return [{ ...S(''), kind: 'session.imported', detail: { note: cmd.note } }]; // turn_id='' placeholder; sink rewrites

    case 'turn.request': {
      if (state.activeTurnId !== null) {
        // A turn is already running: the new prompt QUEUES (pi semantics).
        return [
          { ...S(cmd.turnId), kind: 'message.queued', detail: { content: cmd.prompt, disposition: 'followup' } },
          { ...S(cmd.turnId), kind: 'queue.updated', detail: { ...state.queue, followUp: [...state.queue.followUp, cmd.prompt] } },
        ];
      }
      return [
        { ...S(cmd.turnId), kind: 'turn.requested', detail: { prompt: cmd.prompt, refIds: cmd.refIds } },
        { ...S(cmd.turnId), kind: 'user_message.recorded', detail: { role: 'user', content: cmd.prompt } },
        { ...S(cmd.turnId), kind: 'turn.started', detail: {} },
      ];
    }

    case 'message.append':
      return [{ ...S(state.activeTurnId ?? ''), kind: 'user_message.recorded', detail: { role: cmd.role, content: cmd.content } }];

    case 'message.queue':
      return [
        { ...S(state.activeTurnId ?? ''), kind: 'message.queued', detail: { content: cmd.content, disposition: cmd.disposition } },
        { ...S(state.activeTurnId ?? ''), kind: 'queue.updated', detail: cmd.disposition === 'steering'
          ? { steering: [...state.queue.steering, cmd.content], followUp: state.queue.followUp }
          : { steering: state.queue.steering, followUp: [...state.queue.followUp, cmd.content] } },
      ];

    case 'turn.start': {
      const t = state.turns.find((x) => x.id === cmd.turnId);
      if (!t) return [];                                   // unknown turn: no events (honest no-op)
      if (t.status !== 'requested') return [];             // idempotent: already started
      return [{ ...S(cmd.turnId), kind: 'turn.started', detail: {} }];
    }

    case 'turn.chunk': {
      const t = state.turns.find((x) => x.id === cmd.turnId);
      if (!t || t.status !== 'running') return [];
      return [{ ...S(cmd.turnId), kind: 'chunk', detail: { delta: cmd.delta } }];
    }

    case 'turn.tool': {
      const t = state.turns.find((x) => x.id === cmd.turnId);
      if (!t || t.status !== 'running') return [];
      return cmd.phase === 'call'
        ? [{ ...S(cmd.turnId), kind: 'tool_call', detail: { toolCallId: cmd.toolCallId, name: cmd.name ?? 'unknown', ...(cmd.arg !== undefined ? { arg: cmd.arg } : {}) } }]
        : [{ ...S(cmd.turnId), kind: 'tool_call_update', detail: { toolCallId: cmd.toolCallId, ...(cmd.result !== undefined ? { result: cmd.result } : {}), ...(cmd.isError !== undefined ? { isError: cmd.isError } : {}) } }];
    }

    case 'turn.usage': {
      const t = state.turns.find((x) => x.id === cmd.turnId);
      if (!t || t.status !== 'running') return [];
      return [{ ...S(cmd.turnId), kind: 'usage', detail: cmd.meters }];
    }

    case 'turn.compaction': {
      const t = state.turns.find((x) => x.id === cmd.turnId);
      if (!t || t.status !== 'running') return [];
      return [{ ...S(cmd.turnId), kind: 'compaction', detail: { summary: cmd.summary, preservedEventIds: cmd.preservedEventIds } }];
    }

    case 'turn.complete': {
      const t = state.turns.find((x) => x.id === cmd.turnId);
      if (!t || t.status !== 'running') return [];
      // Follow-up queue drains via NEW turn.request commands issued by the sink
      // when it observes turn.completed with a non-empty followUp queue — the
      // orchestrator stays pure and never invents turn ids.
      return [{ ...S(cmd.turnId), kind: 'turn.completed', detail: { answer: cmd.answer } }];
    }

    case 'turn.fail': {
      const t = state.turns.find((x) => x.id === cmd.turnId);
      if (!t || t.status !== 'running') return [];
      return [{ ...S(cmd.turnId), kind: 'turn.failed', detail: { error: cmd.error, ...(cmd.partial !== undefined ? { partial: cmd.partial } : {}) } }];
    }

    case 'turn.abort': {
      const t = state.turns.find((x) => x.id === cmd.turnId);
      if (!t) return [];
      if (t.status !== 'running' && t.status !== 'requested') return []; // terminal turns stay terminal
      return [{ ...S(cmd.turnId), kind: 'turn.aborted', detail: { reason: cmd.reason } }];
    }

    default:
      return []; // unknown command kind: no events, never a crash (ACP lenient-rule)
  }
}

// ── Fold: events → next state (replay IS the fold; projections read the same fold) ──

export function fold(state: OrchestratorState, e: TurnEvent): OrchestratorState {
  const next: OrchestratorState = { ...state, turns: [...state.turns], queue: { ...state.queue } };
  switch (e.kind) {
    case 'session.imported':
      next.imported = true;
      return next;
    case 'turn.requested':
      next.turns.push({ id: e.turn_id, status: 'requested', prompt: e.detail.prompt });
      return next;
    case 'turn.started': {
      const t = next.turns.find((x) => x.id === e.turn_id);
      if (t) t.status = 'running';
      next.activeTurnId = e.turn_id;
      return next;
    }
    case 'turn.completed': {
      const t = next.turns.find((x) => x.id === e.turn_id);
      if (t) t.status = 'completed';
      if (next.activeTurnId === e.turn_id) next.activeTurnId = null;
      return next;
    }
    case 'turn.failed':
    case 'turn.aborted': {
      const t = next.turns.find((x) => x.id === e.turn_id);
      if (t) t.status = e.kind === 'turn.failed' ? 'failed' : 'aborted';
      if (next.activeTurnId === e.turn_id) next.activeTurnId = null;
      return next;
      }
    case 'message.queued': {
      const d = e.detail as { content: string; disposition: 'steering' | 'followup' };
      if (d.disposition === 'steering') next.queue.steering.push(d.content);
      else next.queue.followUp.push(d.content);
      return next;
    }
    case 'queue.updated': {
      const d = e.detail as { steering: string[]; followUp: string[] };
      next.queue = { steering: [...d.steering], followUp: [...d.followUp] };
      return next;
    }
    default:
      return next; // chunk/tool/usage/compaction events don't change turn status
  }
}
