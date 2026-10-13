/** R3-S1: EventSink — the single sqlite transaction that appends events,
 *  updates projections, records the command receipt, and enqueues outbox
 *  effects. The ONLY writer of butler_turns/butler_turn_events, and (single-
 *  writer rule, review R1) the only writer of butler_messages going forward.
 *
 *  Recovery model: decide() is pure; the sink's transaction is atomic; the
 *  EffectWorker retries un-retired outbox rows with idempotency keys. A crash
 *  between commit and effect leaves intent durable — exactly the t3code shape. */

import type Database from 'better-sqlite3';
import { decide, fold, initialState, TURN_EVENT_SCHEMA_VERSION, type OrchestratorState, type TurnCommand, type TurnEvent } from './turn-engine.ts';

export interface EventRow {
  id: string;
  turn_id: string | null;
  session_id: string;
  parent_id: string | null;
  schema_version: number;
  seq: number;
  kind: string;
  detail_json: string;
  at: number;
}

export interface OutboxRow {
  id: string;
  session_id: string;
  effect_json: string;
  retired_at: number | null;
  attempts: number;
}

const ULIDish = (): string => {
  const t = Date.now().toString(36).padStart(8, '0');
  const r = Math.random().toString(36).slice(2, 10).padStart(8, '0');
  return `${t}${r}`;
};

const DDL = `
CREATE TABLE IF NOT EXISTS butler_turns(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,             -- requested|running|completed|failed|aborted
  prompt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS butler_turn_events(
  id TEXT PRIMARY KEY,
  turn_id TEXT NULL,                -- null for session-level events (session.imported)
  session_id TEXT NOT NULL,
  parent_id TEXT NULL,              -- pi: tree-ready from day one
  schema_version INTEGER NOT NULL,  -- dsh: frozen-migration discipline
  seq INTEGER NOT NULL,             -- per-session monotonic
  kind TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  at INTEGER NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_turn_events_session ON butler_turn_events(session_id, seq);
CREATE TABLE IF NOT EXISTS butler_command_receipts(
  command_key TEXT PRIMARY KEY,     -- idempotency: hash of (session, command, nonce)
  session_id TEXT NOT NULL,
  decided_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS butler_outbox(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  effect_json TEXT NOT NULL,
  retired_at INTEGER NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
`;

export type Effect =
  | { type: 'runTurn'; sessionId: string; turnId: string }
  | { type: 'emit'; event: TurnEvent };

export class EventSink {
  private states = new Map<string, OrchestratorState>();

  constructor(private readonly db: Database.Database) {
    db.exec(DDL);
  }

  /** Load (and cache) a session's orchestrator state by folding its events. */
  state(sessionId: string): OrchestratorState {
    const cached = this.states.get(sessionId);
    if (cached) return cached;
    const rows = this.db
      .prepare('SELECT * FROM butler_turn_events WHERE session_id = ? ORDER BY seq ASC')
      .all(sessionId) as Array<EventRow>;
    let st = initialState(sessionId);
    for (const r of rows) st = fold(st, { ...toEvent(r) } as TurnEvent);
    this.states.set(sessionId, st);
    return st;
  }

  /** Handle a command: pure decide → ONE transaction (events + projections +
   *  receipt + outbox). Returns the appended events and the enqueued effects.
   *  Idempotent per commandKey: a replayed command returns [] and no effects. */
  handle(sessionId: string, cmd: TurnCommand, commandKey: string): { events: TurnEvent[]; effects: Effect[] } {
    if (this.db.prepare('SELECT 1 FROM butler_command_receipts WHERE command_key = ?').get(commandKey)) {
      return { events: [], effects: [] };
    }
    const st = this.state(sessionId);
    const events = decide(st, cmd);
    if (events.length === 0) {
      this.db.prepare('INSERT OR IGNORE INTO butler_command_receipts(command_key, session_id, decided_at) VALUES (?,?,?)').run(commandKey, sessionId, Date.now());
      return { events: [], effects: [] };
    }
    const appended: TurnEvent[] = [];
    const effects: Effect[] = [];
    const txn = this.db.transaction(() => {
      let seq = (this.db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM butler_turn_events WHERE session_id = ?').get(sessionId) as { m: number }).m;
      const now = Date.now();
      for (const e of events) {
        seq += 1;
        const row: TurnEvent = { ...e, id: ULIDish(), seq, at: now };
        appended.push(row);
        this.db.prepare('INSERT INTO butler_turn_events(id, turn_id, session_id, parent_id, schema_version, seq, kind, detail_json, at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(row.id, row.turn_id === '' ? null : row.turn_id, sessionId, row.parent_id, TURN_EVENT_SCHEMA_VERSION, seq, row.kind, JSON.stringify(row.detail), now);
        // fold into cached state as we go (the sink's cache IS the projection source)
        this.states.set(sessionId, fold(this.state(sessionId), row));
      }
      // projections: butler_turns + butler_messages stay derivable
      for (const e of appended) {
        this.project(e);
        effects.push({ type: 'emit', event: e });
      }
      // first requested/started event of a turn schedules the provider effect
      if (cmd.kind === 'turn.request') {
        const anyTurn = appended.some((e) => e.kind === 'turn.started');
        if (anyTurn) effects.push({ type: 'runTurn', sessionId, turnId: cmd.turnId });
      }
      this.db.prepare('INSERT OR IGNORE INTO butler_command_receipts(command_key, session_id, decided_at) VALUES (?,?,?)').run(commandKey, sessionId, now);
    });
    txn();
    // outbox rows AFTER the txn commits (the effect worker owns retirement)
    for (const eff of effects) {
      if (eff.type === 'runTurn') {
        this.db.prepare('INSERT INTO butler_outbox(id, session_id, effect_json, attempts) VALUES (?,?,?,0)').run(ULIDish(), sessionId, JSON.stringify(eff));
      }
    }
    return { events: appended, effects };
  }

  /** Un-retired outbox rows for crash recovery (EffectWorker consumes these). */
  pendingEffects(sessionId?: string): OutboxRow[] {
    const q = sessionId
      ? 'SELECT * FROM butler_outbox WHERE retired_at IS NULL AND session_id = ? ORDER BY id'
      : 'SELECT * FROM butler_outbox WHERE retired_at IS NULL ORDER BY id';
    return (this.db.prepare(q).all(...(sessionId ? [sessionId] : [])) as OutboxRow[]).filter((r) => {
      try { JSON.parse(r.effect_json); return true; } catch { return false; }
    });
  }

  retire(effectId: string): void {
    this.db.prepare('UPDATE butler_outbox SET retired_at = ? WHERE id = ?').run(Date.now(), effectId);
  }

  /** Deterministic replay: fold a session's raw rows → state. Property-test hook. */
  replay(sessionId: string): OrchestratorState {
    const rows = this.db.prepare('SELECT * FROM butler_turn_events WHERE session_id = ? ORDER BY seq ASC').all(sessionId) as EventRow[];
    let st = initialState(sessionId);
    for (const r of rows) st = fold(st, toEvent(r) as TurnEvent);
    return st;
  }

  events(sessionId: string, afterSeq = 0): TurnEvent[] {
    const rows = this.db.prepare('SELECT * FROM butler_turn_events WHERE session_id = ? AND seq > ? ORDER BY seq ASC').all(sessionId, afterSeq) as EventRow[];
    return rows.map((r) => toEvent(r) as TurnEvent);
  }

  private project(e: TurnEvent): void {
    if (e.kind === 'turn.requested') {
      this.db.prepare('INSERT OR REPLACE INTO butler_turns(id, session_id, status, prompt, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run(e.turn_id, e.session_id, 'requested', e.detail.prompt, e.at, e.at);
    } else if (e.kind === 'turn.started') {
      this.db.prepare('UPDATE butler_turns SET status = ?, updated_at = ? WHERE id = ?').run('running', e.at, e.turn_id);
    } else if (e.kind === 'turn.completed' || e.kind === 'turn.failed' || e.kind === 'turn.aborted') {
      this.db.prepare('UPDATE butler_turns SET status = ?, updated_at = ? WHERE id = ?').run(e.kind === 'turn.completed' ? 'completed' : e.kind === 'turn.failed' ? 'failed' : 'aborted', e.at, e.turn_id);
    }
    // message projection: user_message.recorded → butler_messages row (single-writer rule)
    if (e.kind === 'user_message.recorded') {
      this.db.prepare('INSERT INTO butler_messages(id, session_id, role, content, tool_calls_json, tool_results_json, tokens_in, tokens_out, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(e.id, e.session_id, e.detail.role, e.detail.content, null, null, 0, 0, e.at);
    }
  }
}

function toEvent(r: EventRow): TurnEvent {
  return {
    id: r.id,
    turn_id: r.turn_id ?? '',
    session_id: r.session_id,
    parent_id: r.parent_id,
    schema_version: r.schema_version,
    seq: r.seq,
    at: r.at,
    kind: r.kind as TurnEvent['kind'],
    detail: JSON.parse(r.detail_json),
  } as TurnEvent;
}
