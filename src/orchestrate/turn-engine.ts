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
  seq: number;                   // per-SESSION monotonic, assigned by the sink (UNIQUE(session_id, seq))
  at: number;                    // epoch ms, assigned by the sink
}

export type TurnEventKind =
  | 'session.imported'
  | 'turn.requested'
  | 'turn.started'
  | 'user_message.recorded'
  | 'message.queued'             // pi: follow-up queue entry (decided, visible)
  | 'queue.updated'              // pi: steering/follow-up queue state changes
  | 'queue.removed'              // one item left the queue (claimed | deleted | delivered)
  | 'steer.delivered'            // steering items handed to the running turn
  | 'session.notice'             // generic host-visible notice (info | warn | error)
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
  | (TurnEventBase & { kind: 'user_message.recorded'; detail: { role: 'user' | 'assistant'; content: string; items?: QueueItemRef[]; via?: 'steer' } })
  | (TurnEventBase & { kind: 'message.queued'; detail: { content: string; disposition: 'steering' | 'followup' } & QueuedIdentity })
  | (TurnEventBase & { kind: 'queue.updated'; detail: { steering: string[]; followUp: string[]; ids?: { steering: string[]; followUp: string[] } } })
  | (TurnEventBase & { kind: 'queue.removed'; detail: { queueId: string; reason: QueueRemovalReason } })
  | (TurnEventBase & { kind: 'steer.delivered'; detail: { items: QueueItemRef[] } })
  | (TurnEventBase & { kind: 'session.notice'; detail: { level: NoticeLevel; text: string } })
  | (TurnEventBase & { kind: 'chunk'; detail: { delta: string; block?: TurnChunkBlock } })
  | (TurnEventBase & { kind: 'tool_call'; detail: { toolCallId: string; name: string; arg?: string } })
  | (TurnEventBase & { kind: 'tool_call_update'; detail: { toolCallId: string; result?: string; isError?: boolean } })
  | (TurnEventBase & { kind: 'usage'; detail: UsageMeters })
  | (TurnEventBase & { kind: 'compaction'; detail: { summary: string; preservedEventIds: string[] } })
  | (TurnEventBase & { kind: 'turn.completed'; detail: { answer: string } })
  | (TurnEventBase & { kind: 'turn.failed'; detail: { error: string; partial?: string } })
  | (TurnEventBase & { kind: 'turn.aborted'; detail: { reason: string } });

// ── Queue item identity (detached send / steer / claim-all drain) ──

/** A queue item as carried on user rows and steer deliveries. */
export interface QueueItemRef { queueId: string; content: string }
export type QueueRemovalReason = 'claimed' | 'deleted' | 'delivered';
export type NoticeLevel = 'info' | 'warn' | 'error';
/** Host-supplied request options a queued item keeps until it runs. */
export interface QueuedBody { commands?: string[]; model?: string }
/** Additive identity on `message.queued` (absent on legacy rows). */
export interface QueuedIdentity {
  queueId?: string;
  body?: QueuedBody;
  /** duplicate-submit guard: the host's client request id + principal + content fingerprint */
  requestId?: string;
  principalId?: string;
  fingerprint?: string;
}

// ── Commands (the ONLY way state changes) ──

/** chat-reliability F2 (text block lifecycle): durable block metadata riding
 *  chunk commands. Additive and optional — legacy readers concatenate `delta`
 *  exactly as before (start/end chunks carry an EMPTY delta). */
export interface TurnChunkBlock {
  id: string;
  phase: 'start' | 'delta' | 'end';
  /** provider-native block identity when one exists */
  native?: string;
  /** FULL block text — present on phase:'end' */
  text?: string;
}

export type TurnCommand =
  | { kind: 'session.import'; sessionId: string; note: string }
  /** `display`/`items`: the text recorded as the user message (and kept in
   *  model history) when it differs from the composed `prompt`; `claim`:
   *  queue ids removed (reason `claimed`) in the SAME decision that starts
   *  the turn — a crash can never both start the turn and keep the items. */
  | { kind: 'turn.request'; sessionId: string; turnId: string; prompt: string; refIds: string[]; at: number; display?: string; items?: QueueItemRef[]; claim?: string[] }
  | { kind: 'message.append'; sessionId: string; role: 'user' | 'assistant'; content: string; narrative?: boolean }
  | ({ kind: 'message.queue'; sessionId: string; content: string; disposition: 'steering' | 'followup' } & QueuedIdentity)
  | { kind: 'queue.remove'; sessionId: string; queueId: string; reason: QueueRemovalReason }
  /** hand every pending steering item in `queueIds` to the running turn */
  | { kind: 'steer.deliver'; sessionId: string; turnId: string; queueIds: string[] }
  | { kind: 'session.notice'; sessionId: string; turnId?: string; level: NoticeLevel; text: string }
  | { kind: 'turn.start'; sessionId: string; turnId: string }
  | { kind: 'turn.chunk'; sessionId: string; turnId: string; delta: string; block?: TurnChunkBlock }
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

/** One pending queue item with its identity. Legacy rows (no queueId) get a
 *  synthetic `q_legacy_<seq>` id and `legacy: true` — they are visible but
 *  never auto-drained (they predate the claim-all contract). */
export interface QueueEntry extends QueuedIdentity {
  queueId: string;
  content: string;
  disposition: 'steering' | 'followup';
  legacy?: boolean;
}

export interface OrchestratorState {
  sessionId: string;
  turns: Array<{ id: string; status: 'requested' | 'running' | 'completed' | 'failed' | 'aborted'; prompt: string }>;
  activeTurnId: string | null;
  queue: QueueState;
  /** pending items in queue order (steering and follow-up interleaved as queued) */
  entries: QueueEntry[];
  imported: boolean;
}

export function initialState(sessionId: string): OrchestratorState {
  return { sessionId, turns: [], activeTurnId: null, queue: { steering: [], followUp: [] }, entries: [], imported: false };
}

/** queue.updated detail computed from entries (strings kept for legacy readers). */
function snapshotOf(entries: QueueEntry[]): { steering: string[]; followUp: string[]; ids: { steering: string[]; followUp: string[] } } {
  const st = entries.filter((e) => e.disposition === 'steering');
  const fu = entries.filter((e) => e.disposition === 'followup');
  return { steering: st.map((e) => e.content), followUp: fu.map((e) => e.content), ids: { steering: st.map((e) => e.queueId), followUp: fu.map((e) => e.queueId) } };
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
      // claim-all: the claimed items leave the queue in THIS decision. A claim
      // that matches no pending item decides nothing (the drain lost a race —
      // never start a turn for items someone else already took).
      const claimed = cmd.claim ? state.entries.filter((e) => cmd.claim!.includes(e.queueId)) : [];
      if (cmd.claim && cmd.claim.length > 0 && claimed.length === 0) return [];
      const claimEvents: TurnEvent[] = claimed.length === 0 ? [] : [
        ...claimed.map((e) => ({ ...S(cmd.turnId), kind: 'queue.removed' as const, detail: { queueId: e.queueId, reason: 'claimed' as const } })),
        { ...S(cmd.turnId), kind: 'queue.updated', detail: snapshotOf(state.entries.filter((e) => !claimed.includes(e))) },
      ];
      return [
        ...claimEvents,
        { ...S(cmd.turnId), kind: 'turn.requested', detail: { prompt: cmd.prompt, refIds: cmd.refIds } },
        { ...S(cmd.turnId), kind: 'user_message.recorded', detail: { role: 'user', content: cmd.display ?? cmd.prompt, ...(cmd.items !== undefined ? { items: cmd.items } : {}) } },
        { ...S(cmd.turnId), kind: 'turn.started', detail: {} },
      ];
    }

    case 'message.append':
      return [{ ...S(state.activeTurnId ?? ''), kind: 'user_message.recorded', detail: { role: cmd.role, content: cmd.content } }];

    case 'message.queue': {
      const { kind: _k, sessionId: _s, content, disposition, ...identity } = cmd;
      // duplicate-submit guard (second line of defence; the host route checks
      // removed items too): a still-pending item with the same request id
      // from the same principal decides nothing.
      if (identity.requestId !== undefined && state.entries.some((e) => e.requestId === identity.requestId && e.principalId === identity.principalId)) return [];
      if (identity.queueId === undefined) {
        // legacy shape (no identity): unchanged string-snapshot behaviour
        return [
          { ...S(state.activeTurnId ?? ''), kind: 'message.queued', detail: { content, disposition } },
          { ...S(state.activeTurnId ?? ''), kind: 'queue.updated', detail: disposition === 'steering'
            ? { steering: [...state.queue.steering, content], followUp: state.queue.followUp }
            : { steering: state.queue.steering, followUp: [...state.queue.followUp, content] } },
        ];
      }
      const entry: QueueEntry = { ...identity, queueId: identity.queueId, content, disposition };
      return [
        { ...S(state.activeTurnId ?? ''), kind: 'message.queued', detail: { content, disposition, ...identity } },
        { ...S(state.activeTurnId ?? ''), kind: 'queue.updated', detail: snapshotOf([...state.entries, entry]) },
      ];
    }

    case 'queue.remove': {
      const hit = state.entries.find((e) => e.queueId === cmd.queueId);
      if (!hit) return []; // unknown or already gone: idempotent no-op
      return [
        { ...S(state.activeTurnId ?? ''), kind: 'queue.removed', detail: { queueId: cmd.queueId, reason: cmd.reason } },
        { ...S(state.activeTurnId ?? ''), kind: 'queue.updated', detail: snapshotOf(state.entries.filter((e) => e !== hit)) },
      ];
    }

    case 'steer.deliver': {
      const t = state.turns.find((x) => x.id === cmd.turnId);
      if (!t || t.status !== 'running') return [];
      const taken = state.entries.filter((e) => e.disposition === 'steering' && !e.legacy && cmd.queueIds.includes(e.queueId));
      if (taken.length === 0) return [];
      const items = taken.map((e) => ({ queueId: e.queueId, content: e.content }));
      return [
        ...taken.map((e) => ({ ...S(cmd.turnId), kind: 'queue.removed' as const, detail: { queueId: e.queueId, reason: 'delivered' as const } })),
        { ...S(cmd.turnId), kind: 'queue.updated', detail: snapshotOf(state.entries.filter((e) => !taken.includes(e))) },
        { ...S(cmd.turnId), kind: 'steer.delivered', detail: { items } },
        // model memory: later turns rebuild history from user rows only — a
        // delivered steer must be one, ordered before this turn's answer.
        ...items.map((it) => ({ ...S(cmd.turnId), kind: 'user_message.recorded' as const, detail: { role: 'user' as const, content: it.content, via: 'steer' as const } })),
      ];
    }

    case 'session.notice':
      return [{ ...S(cmd.turnId ?? state.activeTurnId ?? ''), kind: 'session.notice', detail: { level: cmd.level, text: cmd.text } }];

    case 'turn.start': {
      const t = state.turns.find((x) => x.id === cmd.turnId);
      if (!t) return [];                                   // unknown turn: no events (honest no-op)
      if (t.status !== 'requested') return [];             // idempotent: already started
      return [{ ...S(cmd.turnId), kind: 'turn.started', detail: {} }];
    }

    case 'turn.chunk': {
      const t = state.turns.find((x) => x.id === cmd.turnId);
      if (!t || t.status !== 'running') return [];
      // F2: `block` rides along additively (absent on legacy chunks); the fold
      // reads only the fields it knows and ignores any other unknown field.
      return [{ ...S(cmd.turnId), kind: 'chunk', detail: { delta: cmd.delta, ...(cmd.block !== undefined ? { block: cmd.block } : {}) } }];
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
  const next: OrchestratorState = { ...state, turns: [...state.turns], queue: { ...state.queue }, entries: [...(state.entries ?? [])] };
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
      const d = e.detail as { content: string; disposition: 'steering' | 'followup' } & QueuedIdentity;
      next.queue = { steering: [...next.queue.steering], followUp: [...next.queue.followUp] };
      if (d.disposition === 'steering') next.queue.steering.push(d.content);
      else next.queue.followUp.push(d.content);
      next.entries.push(d.queueId !== undefined
        ? { ...d, queueId: d.queueId }
        : { queueId: `q_legacy_${e.seq}`, content: d.content, disposition: d.disposition, legacy: true });
      return next;
    }
    case 'queue.removed': {
      const d = e.detail as { queueId: string };
      next.entries = next.entries.filter((x) => x.queueId !== d.queueId);
      return next;
    }
    case 'queue.updated': {
      const d = e.detail as { steering: string[]; followUp: string[]; ids?: { steering: string[]; followUp: string[] } };
      next.queue = { steering: [...d.steering], followUp: [...d.followUp] };
      if (d.ids) {
        const keep = new Set([...d.ids.steering, ...d.ids.followUp]);
        next.entries = next.entries.filter((x) => keep.has(x.queueId));
      } else {
        // legacy snapshot: entries follow the strings; an existing entry with
        // the same content/disposition keeps its identity, the rest are legacy
        const pool = [...next.entries];
        const take = (content: string, disposition: 'steering' | 'followup', i: number): QueueEntry => {
          const at = pool.findIndex((x) => x.content === content && x.disposition === disposition);
          if (at !== -1) return pool.splice(at, 1)[0]!;
          return { queueId: `q_legacy_${e.seq}_${disposition}_${i}`, content, disposition, legacy: true };
        };
        next.entries = [
          ...d.steering.map((c, i) => take(c, 'steering', i)),
          ...d.followUp.map((c, i) => take(c, 'followup', i)),
        ];
      }
      return next;
    }
    default:
      return next; // chunk/tool/usage/compaction events don't change turn status
  }
}
