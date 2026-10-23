/** chat-reliability F1/F2: execution authority — one compliant executor per
 *  canonical local agent SQLite DB.
 *
 *  Election: a dedicated tiny control DB (`<agent-db>.execution-control.db`)
 *  holds a `BEGIN IMMEDIATE` transaction for the authority's entire lifetime.
 *  A competing executor fails election with SQLITE_BUSY before serving; the OS
 *  releases the lock when the process dies. This is NOT a distributed lease.
 *
 *  The bare lock is explicitly NOT sufficient (proved by an orphan-child
 *  probe): worker rows are tracked durably, unsettled previous-epoch work is
 *  recovered truthfully (one EXECUTION_INTERRUPTED terminal), and unproven
 *  survivors put the authority in global quarantine — fresh execution is
 *  blocked until an operator resolves the evidence. No scheduler, no timers,
 *  no PID-only death guesses.
 *
 *  Admission: tryReserve installs an in-process attempt synchronously (no
 *  await between check and acquire); admit() commits the turn.request events,
 *  projections, command receipt AND the execution-ledger row in ONE agent-DB
 *  transaction (EventSink.handleInTransaction) and requires the intended
 *  turn.started event to have landed. Losers and queue decisions roll back
 *  entirely. The continuation stash is PEEKED during preparation and consumed
 *  only at beginExecution()'s committed boundary via exact CAS delete. */

import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import type { EventSink } from './event-sink.ts';
import type { Storage } from '../memory/contract.ts';
import type { NoticeLevel, QueueEntry, QueueItemRef, QueueRemovalReason, QueuedBody, TurnCommand, TurnEvent } from './turn-engine.ts';

/** Thrown when another executor already holds the control lock for this
 *  agent DB. The caller must fail startup — never serve alongside it. */
export class ExecutionAuthorityBusyError extends Error {
  constructor(readonly controlPath: string) {
    super(`another executor holds the authority lock: ${controlPath}`);
    this.name = 'ExecutionAuthorityBusyError';
  }
}

export interface ExecutionAttempt {
  readonly sessionId: string;
  readonly turnId: string;
  readonly epoch: string;
  readonly attemptId: string;
  readonly controller: AbortController;
}

export type ReserveResult =
  | { status: 'reserved'; attempt: ExecutionAttempt }
  | { status: 'busy'; turnId?: string }
  | { status: 'unavailable'; reason: 'quarantined' | 'recovering' | 'draining' | 'closed' };

export type AdmissionResult =
  | { status: 'admitted'; events: TurnEvent[] }
  | { status: 'rejected'; code: RejectCode; turnId?: string; message?: string };

type RejectCode = 'SESSION_ACTIVE' | 'REQUEST_ALREADY_ADMITTED' | 'REQUEST_ID_REUSE' | 'QUEUE_DECISION' | 'STALE_ATTEMPT' | 'STOP_BEFORE_START' | 'ROLLBACK';

/** Common execution read (session GET + timeline GET must agree). */
export type ExecutionRead =
  | { state: 'idle'; admission: 'ready' | 'blocked'; blockedReason?: string }
  | { state: 'preparing' | 'running' | 'stopping'; turnId: string; startedAt: number; admission: 'busy' }
  | { state: 'uncertain'; turnId?: string; startedAt: number | null; reason: 'legacy_owner' | 'owner_not_local' | 'recovery_in_progress' | 'authority_unavailable' | 'worker_quarantine'; admission: 'blocked' };

export type StopResult =
  | { status: 'aborting'; turnId: string }
  | { status: 'no_active' }
  | { status: 'stale' }
  | { status: 'nonlocal' };

export type RecoveryResult = { recovered: number; quarantined: boolean; uncertainWorkers: number };

/** Prior use of a client request id on a session (duplicate-submit guard). */
export type RequestLookup =
  | { kind: 'turn'; turnId: string; sameContent: boolean }
  | { kind: 'queued'; queueId: string; sameContent: boolean }
  | null;

export interface EnqueueInput {
  content: string;
  disposition: 'steering' | 'followup';
  principalId: string;
  requestId?: string;
  body?: QueuedBody;
}

export interface ResolveWorkerInput {
  expectedEpoch: string;
  operatorIdentity: string;
  evidenceRef: string;
}

const EXECUTION_DDL = `
CREATE TABLE IF NOT EXISTS butler_execution_authority(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch TEXT NOT NULL,
 db_identity TEXT NOT NULL, pid INTEGER NOT NULL, acquired_at INTEGER NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('recovering','ready','draining','quarantined','released')));
CREATE TABLE IF NOT EXISTS butler_executions(
 turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, epoch TEXT NOT NULL,
 principal_id TEXT NOT NULL, request_id TEXT, started_at INTEGER NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('preparing','executing','settled')),
 stop_requested INTEGER NOT NULL DEFAULT 0, terminal_code TEXT,
 resume_turn_id TEXT, resume_json TEXT, settled_at INTEGER, request_hash TEXT,
 UNIQUE(principal_id,session_id,request_id));
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_active ON butler_executions(session_id) WHERE phase != 'settled';
CREATE TABLE IF NOT EXISTS butler_execution_workers(
 worker_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, turn_id TEXT, kind TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('starting','running','settled','uncertain')),
 pid INTEGER, identity TEXT, created_at INTEGER NOT NULL, settled_at INTEGER);
`;

const CONTROL_DDL = `
CREATE TABLE IF NOT EXISTS authority_lock(singleton INTEGER PRIMARY KEY CHECK(singleton=1),format INTEGER NOT NULL);
INSERT OR IGNORE INTO authority_lock VALUES(1,1);
`;

/** Internal control-flow signal — mapped to an AdmissionResult, never escapes. */
class Reject extends Error {
  constructor(readonly code: RejectCode, readonly turnId?: string, message?: string) {
    super(message ?? code);
  }
}

const requestFingerprint = (content: string): string =>
  createHash('sha256').update(JSON.stringify({ v: 1, content }), 'utf8').digest('hex');

export interface ExecutionAuthorityDeps {
  /** canonical path of the AGENT event DB (the DB the sink writes to) */
  dbPath: string;
  sink: EventSink;
  storage: Storage;
  /** override for the derived control path (tests) */
  controlPath?: string;
}

export async function createSqliteExecutionAuthority(deps: ExecutionAuthorityDeps): Promise<ExecutionAuthority> {
  const canonical = realpathSync(deps.dbPath);
  const controlPath = deps.controlPath ?? `${canonical}.execution-control.db`;
  // identity safety: never follow a symlinked/replaced control target
  // (a not-yet-existing control file is fine — SQLite creates it)
  let controlStat: ReturnType<typeof lstatSync> | undefined;
  try { controlStat = lstatSync(controlPath); } catch { controlStat = undefined; }
  if (controlStat?.isSymbolicLink()) throw new Error(`refusing symlinked control DB: ${controlPath}`);

  const control = new Database(controlPath);
  control.pragma('busy_timeout = 0');
  try {
    // both statements need the write lock — either failing with SQLITE_BUSY
    // means another executor owns this control DB
    control.exec(CONTROL_DDL);
    control.exec('BEGIN IMMEDIATE'); // held for the authority's lifetime
  } catch {
    control.close();
    throw new ExecutionAuthorityBusyError(controlPath);
  }

  const agent = new Database(canonical);
  agent.pragma('busy_timeout = 5000');
  agent.exec(EXECUTION_DDL);

  const authority = new ExecutionAuthority(canonical, control, agent, deps.sink, deps.storage, randomUUID());
  authority.recoverPreviousEpochs(); // synchronous SQLite — complete before readiness
  return authority;
}

export class ExecutionAuthority {
  private phase: 'recovering' | 'ready' | 'draining' | 'quarantined' | 'released' = 'recovering';
  private readonly active = new Map<string, ExecutionAttempt>();
  private readonly tracked = new Map<string, Promise<unknown>>();
  private released = false;
  /** closing gate: set by beginShutdown() BEFORE the host aborts running
   *  turns, so a turn settling during shutdown can never start new work */
  private closing = false;
  private readonly readyWaiters: Array<() => void> = [];

  constructor(
    readonly dbPath: string,
    private readonly control: Database.Database,
    private readonly agent: Database.Database,
    private readonly sink: EventSink,
    private readonly storage: Storage,
    readonly epoch: string,
  ) {
    this.agent
      .prepare('INSERT OR REPLACE INTO butler_execution_authority(singleton,epoch,db_identity,pid,acquired_at,phase) VALUES (1,?,?,?,?,?)')
      .run(epoch, this.dbPath, process.pid, Date.now(), 'recovering');
  }

  // ── admission ──

  tryReserve(sessionId: string): ReserveResult {
    if (this.released) return { status: 'unavailable', reason: 'closed' };
    if (this.phase === 'quarantined') return { status: 'unavailable', reason: 'quarantined' };
    if (this.phase === 'draining' || this.closing) return { status: 'unavailable', reason: 'draining' };
    if (this.phase !== 'ready') return { status: 'unavailable', reason: 'recovering' };
    const local = this.active.get(sessionId);
    if (local) return { status: 'busy', turnId: local.turnId };
    const durable = this.unsettledRow(sessionId);
    if (durable) return { status: 'busy', turnId: durable.turn_id };
    const attempt: ExecutionAttempt = {
      sessionId,
      turnId: `t_${randomUUID().slice(0, 12)}`,
      epoch: this.epoch,
      attemptId: randomUUID(),
      controller: new AbortController(),
    };
    this.active.set(sessionId, attempt); // atomic in-process acquire
    return { status: 'reserved', attempt };
  }

  /** Durable atomic admission: turn.request events + projections + receipt +
   *  execution row in one commit; the intended turn.started must have landed.
   *  Releases the reservation on every non-admitted path. */
  admit(attempt: ExecutionAttempt, input: { content: string; principalId: string; requestId?: string; display?: string; items?: QueueItemRef[]; claim?: string[] }): AdmissionResult {
    if (!this.owns(attempt)) return { status: 'rejected', code: 'STALE_ATTEMPT' };
    const fp = requestFingerprint(input.content);
    const release = () => this.releaseAttempt(attempt);
    try {
      // ONE connection (the sink's), ONE commit: epoch check, ledger check,
      // request idempotence, turn.request events + projections + receipt and
      // the execution row land together or not at all.
      this.sink.withTransaction((db) => {
        const auth = db.prepare('SELECT epoch FROM butler_execution_authority WHERE singleton = 1').get() as { epoch: string } | undefined;
        if (!auth || auth.epoch !== this.epoch) throw new Reject('STALE_ATTEMPT');
        const unsettled = db.prepare("SELECT turn_id FROM butler_executions WHERE session_id = ? AND phase != 'settled'").get(attempt.sessionId) as { turn_id: string } | undefined;
        if (unsettled && unsettled.turn_id !== attempt.turnId) throw new Reject('SESSION_ACTIVE', unsettled.turn_id);
        if (input.requestId) {
          const prior = db
            .prepare('SELECT turn_id, request_hash FROM butler_executions WHERE principal_id = ? AND session_id = ? AND request_id = ?')
            .get(input.principalId, attempt.sessionId, input.requestId) as { turn_id: string; request_hash: string } | undefined;
          if (prior) {
            if (prior.request_hash === fp) throw new Reject('REQUEST_ALREADY_ADMITTED', prior.turn_id);
            throw new Reject('REQUEST_ID_REUSE', prior.turn_id);
          }
        }
        const cmd: TurnCommand = {
          kind: 'turn.request', sessionId: attempt.sessionId, turnId: attempt.turnId, prompt: input.content, refIds: [], at: Date.now(),
          ...(input.display !== undefined ? { display: input.display } : {}),
          ...(input.items !== undefined ? { items: input.items } : {}),
          ...(input.claim !== undefined ? { claim: input.claim } : {}),
        } as TurnCommand;
        const { events } = this.sink.handleInTransaction(attempt.sessionId, cmd, `chat:${attempt.sessionId}:${attempt.turnId}`, (txnDb) => {
          txnDb.prepare('INSERT INTO butler_executions(turn_id,session_id,epoch,principal_id,request_id,started_at,phase,stop_requested,request_hash) VALUES (?,?,?,?,?,?,?,0,?)')
            .run(attempt.turnId, attempt.sessionId, this.epoch, input.principalId, input.requestId ?? null, Date.now(), 'preparing', fp);
        });
        // the intended turn must have ACTUALLY started in this commit — a
        // queue decision or a foreign active turn rolls everything back.
        if (!events.some((e) => e.kind === 'turn.started' && e.turn_id === attempt.turnId)) {
          throw new Reject('QUEUE_DECISION');
        }
      });
      return { status: 'admitted', events: [] };
    } catch (err) {
      release();
      this.sink.invalidate(attempt.sessionId);
      if (err instanceof Reject) return { status: 'rejected', code: err.code, ...(err.turnId !== undefined ? { turnId: err.turnId } : {}), message: err.message };
      return { status: 'rejected', code: 'ROLLBACK', message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Execution boundary: snapshot + CAS-consume the continuation stash, mark
   *  the execution `executing`. Returns the seeded partial messages (validated)
   *  or null. A Stop requested before start aborts without consuming anything.
   *  NOTE: the stash lives in the MAIN storage DB while the ledger lives in
   *  the agent DB — the snapshot is committed to the ledger first, then the
   *  exact stash bytes are CAS-deleted; a crash between the two leaves an
   *  inspectable snapshot and a recoverable (interrupted) execution. */
  async beginExecution(attempt: ExecutionAttempt): Promise<{ seeded: unknown[] | null; stashTurnId: string | null } | { status: 'rejected'; code: 'STALE_ATTEMPT' | 'STOP_BEFORE_START' | 'STASH_CHANGED' }> {
    if (!this.owns(attempt)) return { status: 'rejected', code: 'STALE_ATTEMPT' };
    const row = this.agent.prepare('SELECT phase, stop_requested FROM butler_executions WHERE turn_id = ?').get(attempt.turnId) as { phase: string; stop_requested: number } | undefined;
    if (!row || row.phase !== 'preparing') return { status: 'rejected', code: 'STALE_ATTEMPT' };
    if (row.stop_requested) {
      this.releaseAttempt(attempt);
      return { status: 'rejected', code: 'STOP_BEFORE_START' };
    }
    const stash = (await this.storage.peekPartial?.(attempt.sessionId)) ?? null;
    let seeded: unknown[] | null = null;
    if (stash) {
      try { seeded = JSON.parse(stash.json) as unknown[]; } catch { seeded = null; } // corrupt stash never kills the turn; bytes stay
    }
    const mark = this.agent.transaction(() => {
      const auth = this.agent.prepare('SELECT epoch FROM butler_execution_authority WHERE singleton = 1').get() as { epoch: string } | undefined;
      if (!auth || auth.epoch !== this.epoch) throw new Reject('STALE_ATTEMPT');
      if (stash) {
        this.agent.prepare('UPDATE butler_executions SET phase = ?, resume_turn_id = ?, resume_json = ? WHERE turn_id = ? AND phase = ?')
          .run('executing', stash.turnId, stash.json, attempt.turnId, 'preparing');
      } else {
        this.agent.prepare('UPDATE butler_executions SET phase = ? WHERE turn_id = ? AND phase = ?').run('executing', attempt.turnId, 'preparing');
      }
    });
    try {
      mark();
    } catch {
      this.releaseAttempt(attempt);
      return { status: 'rejected', code: 'STALE_ATTEMPT' };
    }
    if (stash) {
      const consumed = (await this.storage.consumePartialExact?.(attempt.sessionId, stash.turnId, stash.json)) ?? false;
      if (!consumed) {
        // the stash changed under us — abort before any provider work; the
        // newer stash stays intact for its own owner.
        await this.settle(attempt, 'STASH_CHANGED');
        return { status: 'rejected', code: 'STASH_CHANGED' };
      }
    }
    return { seeded, stashTurnId: stash?.turnId ?? null };
  }

  /** Durable durable-write seam for the owning transport: every command is
   *  fenced by epoch + attempt identity. */
  handleOwned(attempt: ExecutionAttempt, sessionId: string, cmd: TurnCommand, commandKey: string): { events: TurnEvent[] } {
    if (!this.owns(attempt)) throw new Error('stale attempt');
    const result = this.sink.handle(sessionId, cmd, commandKey);
    return { events: result.events };
  }

  /** Terminal settlement of an execution (idempotent; owner-only). */
  async settle(attempt: ExecutionAttempt, terminalCode: string | null): Promise<void> {
    if (!this.owns(attempt)) return;
    this.agent
      .prepare("UPDATE butler_executions SET phase = 'settled', terminal_code = ?, settled_at = COALESCE(settled_at, ?) WHERE turn_id = ? AND epoch = ?")
      .run(terminalCode, Date.now(), attempt.turnId, this.epoch);
    this.releaseAttempt(attempt);
  }

  /** chat-reliability §3.5: OWNED ATOMIC FINALIZATION — terminal event,
   *  projections, session accounting, budget stash and the execution-ledger
   *  settle commit in ONE sink-connection transaction. Exact duplicate
   *  finalize is a no-op (engine terminality guard returns no events →
   *  already-terminal; the ledger still reconciles). A storage failure rolls
   *  everything back and leaves the attempt reserved for an idempotent retry
   *  — success is never reported for an uncommitted terminal. */
  async finalizeOwned(
    attempt: ExecutionAttempt,
    input: {
      kind: 'turn.complete' | 'turn.fail';
      answer?: string;
      error?: string;
      commandKey: string;
      settleCode: string;
      accounting?: { status?: 'active' | 'ended' | 'error'; tokensInDelta?: number; tokensOutDelta?: number };
      stash?: { json: string };
    },
  ): Promise<{ status: 'finalized' | 'already-terminal' | 'stale'; accounted: boolean }> {
    if (!this.owns(attempt)) return { status: 'stale', accounted: false };
    let accounted = false;
    let wroteTerminal = false;
    try {
      this.sink.withTransaction((db) => {
        const auth = db.prepare('SELECT epoch FROM butler_execution_authority WHERE singleton = 1').get() as { epoch: string } | undefined;
        if (!auth || auth.epoch !== this.epoch) throw new Error('stale authority epoch');
        const cmd: TurnCommand = (input.kind === 'turn.complete'
          ? { kind: 'turn.complete', sessionId: attempt.sessionId, turnId: attempt.turnId, answer: input.answer ?? '' }
          : { kind: 'turn.fail', sessionId: attempt.sessionId, turnId: attempt.turnId, error: input.error ?? 'turn failed' }) as TurnCommand;
        const { events } = this.sink.handleInTransaction(attempt.sessionId, cmd, input.commandKey, undefined);
        wroteTerminal = events.some((e) => e.kind === 'turn.completed' || e.kind === 'turn.failed');
        if (input.stash) this.storage.stashPartialSync?.(attempt.sessionId, attempt.turnId, input.stash.json);
        if (input.accounting) {
          this.storage.applyAccountingSync?.(attempt.sessionId, input.accounting);
          accounted = true;
        }
        db.prepare("UPDATE butler_executions SET phase = 'settled', terminal_code = ?, settled_at = ? WHERE turn_id = ? AND epoch = ? AND phase != 'settled'")
          .run(input.settleCode, Date.now(), attempt.turnId, this.epoch);
      });
    } catch (err) {
      this.sink.invalidate(attempt.sessionId);
      throw err; // attempt stays reserved: retry this idempotent finalization only
    }
    this.sink.invalidate(attempt.sessionId);
    this.releaseAttempt(attempt);
    return { status: wroteTerminal ? 'finalized' : 'already-terminal', accounted };
  }

  // ── queue (detached send / steer / claim-all drain) ──

  /** Duplicate-submit guard, read BEFORE tryReserve: a client request id is
   *  looked up in BOTH stores — admitted turns (ledger) and every queued
   *  item of the session, pending or already claimed/deleted/delivered. */
  lookupRequest(sessionId: string, principalId: string, requestId: string, content: string): RequestLookup {
    const fp = requestFingerprint(content);
    const turn = this.agent
      .prepare('SELECT turn_id, request_hash FROM butler_executions WHERE principal_id = ? AND session_id = ? AND request_id = ?')
      .get(principalId, sessionId, requestId) as { turn_id: string; request_hash: string | null } | undefined;
    if (turn) return { kind: 'turn', turnId: turn.turn_id, sameContent: turn.request_hash === fp };
    const queued = this.agent
      .prepare("SELECT json_extract(detail_json,'$.queueId') AS qid, json_extract(detail_json,'$.fingerprint') AS fp FROM butler_turn_events WHERE session_id = ? AND kind = 'message.queued' AND json_extract(detail_json,'$.requestId') = ? AND json_extract(detail_json,'$.principalId') = ? ORDER BY seq LIMIT 1")
      .get(sessionId, requestId, principalId) as { qid: string | null; fp: string | null } | undefined;
    if (queued?.qid) return { kind: 'queued', queueId: queued.qid, sameContent: queued.fp === fp };
    return null;
  }

  /** Durable enqueue with identity. Returns the item id (the existing one
   *  when the engine refused a still-pending duplicate). */
  enqueue(sessionId: string, input: EnqueueInput): { queueId: string; disposition: 'steering' | 'followup' } {
    const queueId = `q_${randomUUID().slice(0, 12)}`;
    this.sink.handle(sessionId, {
      kind: 'message.queue', sessionId, content: input.content, disposition: input.disposition,
      queueId, principalId: input.principalId, fingerprint: requestFingerprint(input.content),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
    } as TurnCommand, `queue:${sessionId}:${queueId}`);
    const entries = this.sink.state(sessionId).entries;
    const mine = entries.find((e) => e.queueId === queueId)
      ?? (input.requestId !== undefined ? entries.find((e) => e.requestId === input.requestId && e.principalId === input.principalId) : undefined);
    return { queueId: mine?.queueId ?? queueId, disposition: mine?.disposition ?? input.disposition };
  }

  /** Remove one pending item; false when it is unknown or already gone. */
  removeQueued(sessionId: string, queueId: string, reason: QueueRemovalReason = 'deleted'): boolean {
    const { events } = this.sink.handle(sessionId, { kind: 'queue.remove', sessionId, queueId, reason } as TurnCommand, `queue:${sessionId}:${queueId}:remove`);
    return events.length > 0;
  }

  /** Pending items that may run (legacy rows without identity never auto-run). */
  pendingQueue(sessionId: string): QueueEntry[] {
    return this.sink.state(sessionId).entries.filter((e) => !e.legacy);
  }

  /** Sessions holding identity-bearing pending items (boot drain input). */
  sessionsWithPending(): string[] {
    const rows = this.agent
      .prepare("SELECT DISTINCT session_id FROM butler_turn_events WHERE kind = 'message.queued' AND json_extract(detail_json,'$.queueId') IS NOT NULL")
      .all() as Array<{ session_id: string }>;
    return rows.map((r) => r.session_id).filter((sid) => this.pendingQueue(sid).length > 0);
  }

  /** Steer delivery at a tool boundary, owner-fenced: every pending steering
   *  item leaves the queue and is recorded as delivered (plus a user row for
   *  model memory) in ONE commit; the items are returned for the loop. */
  deliverSteering(attempt: ExecutionAttempt): QueueItemRef[] {
    if (!this.owns(attempt)) return [];
    const steers = this.pendingQueue(attempt.sessionId).filter((e) => e.disposition === 'steering');
    if (steers.length === 0) return [];
    const { events } = this.handleOwned(attempt, attempt.sessionId, {
      kind: 'steer.deliver', sessionId: attempt.sessionId, turnId: attempt.turnId, queueIds: steers.map((e) => e.queueId),
    } as TurnCommand, `steer:${attempt.turnId}:${steers.map((e) => e.queueId).join(',')}`);
    const delivered = events.find((e) => e.kind === 'steer.delivered');
    return delivered && delivered.kind === 'steer.delivered' ? delivered.detail.items : [];
  }

  /** Generic durable notice row (no host vocabulary). */
  notice(sessionId: string, level: NoticeLevel, text: string, turnId?: string): void {
    this.sink.handle(sessionId, { kind: 'session.notice', sessionId, level, text, ...(turnId !== undefined ? { turnId } : {}) } as TurnCommand, `notice:${sessionId}:${randomUUID()}`);
  }

  /** Closing gate. Call BEFORE aborting running turns at shutdown: from here
   *  on nothing new is reserved (sends, drains), so a turn that settles
   *  during shutdown cannot start the next queued work. Idempotent. */
  beginShutdown(): void {
    this.closing = true;
  }

  isClosing(): boolean {
    return this.closing || this.released || this.phase === 'draining';
  }

  /** Run `cb` once the authority is ready (now, or when quarantine resolves). */
  whenReady(cb: () => void): void {
    if (this.phase === 'ready' && !this.closing) { cb(); return; }
    this.readyWaiters.push(cb);
  }

  /** Release the in-process reservation ONLY if the identity still matches. */
  releaseAttempt(attempt: ExecutionAttempt): void {
    if (this.active.get(attempt.sessionId) === attempt) this.active.delete(attempt.sessionId);
  }

  // ── stop / read / workers ──

  requestStop(sessionId: string, expectedTurnId?: string): StopResult {
    const local = this.active.get(sessionId);
    const durable = this.unsettledRow(sessionId);
    if (!local && !durable) return { status: 'no_active' };
    const turnId = local?.turnId ?? durable!.turn_id;
    if (expectedTurnId !== undefined && turnId !== expectedTurnId) return { status: 'stale' };
    if (durable) this.agent.prepare('UPDATE butler_executions SET stop_requested = 1 WHERE turn_id = ?').run(durable.turn_id);
    if (local) local.controller.abort();
    return { status: 'aborting', turnId };
  }

  /** Single-snapshot execution read; performs NO recovery and NO dispatch. */
  readSession(sessionId: string): ExecutionRead {
    if (this.phase === 'quarantined') {
      const row = this.unsettledRow(sessionId);
      return { state: 'uncertain', ...(row?.turn_id !== undefined ? { turnId: row.turn_id } : {}), startedAt: row?.started_at ?? null, reason: 'worker_quarantine', admission: 'blocked' };
    }
    const local = this.active.get(sessionId);
    const row = this.unsettledRow(sessionId);
    if (local && row && row.turn_id === local.turnId) {
      const stopping = row.stop_requested === 1;
      return { state: stopping ? 'stopping' : row.phase === 'preparing' ? 'preparing' : 'running', turnId: row.turn_id, startedAt: row.started_at, admission: 'busy' };
    }
    if (row) {
      // durable non-settled work this process does not own locally
      return { state: 'uncertain', turnId: row.turn_id, startedAt: row.started_at, reason: 'owner_not_local', admission: 'blocked' };
    }
    // legacy: an active fold with no execution row is uncertain, never idle
    const fold = this.sink.readSnapshot(sessionId).state;
    if (fold.activeTurnId !== null) {
      return { state: 'uncertain', turnId: fold.activeTurnId, startedAt: null, reason: 'legacy_owner', admission: 'blocked' };
    }
    return { state: 'idle', admission: this.phase === 'ready' ? 'ready' : 'blocked', ...(this.phase === 'ready' ? {} : { blockedReason: `authority ${this.phase}` }) };
  }

  /** Record `starting` BEFORE any spawn/tail; settled only on actual promise
   *  settlement. The returned promise mirrors `start()`'s outcome. */
  trackWorker(scope: { turnId?: string; identity?: Record<string, unknown> }, kind: string, start: () => Promise<unknown>): Promise<unknown> {
    const workerId = `w_${randomUUID().slice(0, 12)}`;
    this.agent
      .prepare('INSERT INTO butler_execution_workers(worker_id,epoch,turn_id,kind,phase,pid,identity,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(workerId, this.epoch, scope.turnId ?? null, kind, 'starting', process.pid, JSON.stringify(scope.identity ?? {}), Date.now());
    const tracked = Promise.resolve()
      .then(start)
      .finally(() => {
        this.agent.prepare('UPDATE butler_execution_workers SET phase = ?, settled_at = ? WHERE worker_id = ?').run('settled', Date.now(), workerId);
        this.tracked.delete(workerId);
      });
    this.tracked.set(workerId, tracked);
    return tracked;
  }

  /** Operator-only: resolve one uncertain worker with recorded evidence.
   *  All uncertain workers must be resolved before readiness returns. */
  resolveUncertainWorker(workerId: string, input: ResolveWorkerInput): boolean {
    const row = this.agent.prepare('SELECT epoch, phase, identity FROM butler_execution_workers WHERE worker_id = ?').get(workerId) as { epoch: string; phase: string; identity: string | null } | undefined;
    if (!row || row.phase !== 'uncertain') return false;
    if (row.epoch !== input.expectedEpoch) return false;
    const evidence = { ...(row.identity ? JSON.parse(row.identity) as Record<string, unknown> : {}), resolvedBy: input.operatorIdentity, evidenceRef: input.evidenceRef };
    const updated = this.agent
      .prepare("UPDATE butler_execution_workers SET phase = 'settled', settled_at = ?, identity = ? WHERE worker_id = ? AND phase = 'uncertain'")
      .run(Date.now(), JSON.stringify(evidence), workerId);
    if (updated.changes === 0) return false;
    const remaining = this.agent.prepare("SELECT COUNT(*) AS n FROM butler_execution_workers WHERE phase = 'uncertain'").get() as { n: number };
    if (remaining.n === 0 && this.phase === 'quarantined') this.setPhase('ready');
    return true;
  }

  // ── recovery / lifecycle ──

  /** Only the lock-holding authority runs this, before accepting messages.
   *  Known previous-epoch executions get ONE truthful interruption terminal
   *  (or ledger-only reconcile when already terminal). Nothing is replayed. */
  recoverPreviousEpochs(): RecoveryResult {
    const stale = this.agent.prepare("SELECT turn_id, session_id FROM butler_executions WHERE epoch != ? AND phase != 'settled'").all(this.epoch) as Array<{ turn_id: string; session_id: string }>;
    let recovered = 0;
    for (const row of stale) {
      try {
        this.sink.withTransaction((db) => {
          const fold = this.sink.readSnapshot(row.session_id).state;
          if (fold.activeTurnId === row.turn_id) {
            this.sink.handleInTransaction(
              row.session_id,
              { kind: 'turn.fail', sessionId: row.session_id, turnId: row.turn_id, error: 'execution interrupted: the owning executor went away; partial content is preserved in prior events — resend to continue' } as TurnCommand,
              `recover:${row.turn_id}`,
              undefined,
            );
          }
          db.prepare("UPDATE butler_executions SET phase = 'settled', terminal_code = 'EXECUTION_INTERRUPTED', settled_at = ? WHERE turn_id = ? AND phase != 'settled'").run(Date.now(), row.turn_id);
        });
        recovered += 1;
      } finally {
        this.sink.invalidate(row.session_id);
      }
    }
    // unfinished workers from any earlier epoch are unproven survivors
    this.agent.prepare("UPDATE butler_execution_workers SET phase = 'uncertain' WHERE epoch != ? AND phase IN ('starting','running')").run(this.epoch);
    const uncertain = (this.agent.prepare("SELECT COUNT(*) AS n FROM butler_execution_workers WHERE phase = 'uncertain'").get() as { n: number }).n;
    this.setPhase(uncertain > 0 ? 'quarantined' : 'ready');
    return { recovered, quarantined: uncertain > 0, uncertainWorkers: uncertain };
  }

  /** Close admission, await tracked workers, then (and only then) release the
   *  control lock. A drain problem keeps the lock held — never close anyway. */
  async drain(): Promise<void> {
    if (this.released) return;
    this.closing = true;
    this.setPhase('draining');
    await Promise.allSettled([...this.tracked.values()]);
    this.setPhase('released');
    this.released = true;
    try {
      this.control.exec('ROLLBACK'); // releases BEGIN IMMEDIATE
    } finally {
      this.control.close();
      this.agent.close();
    }
  }

  currentPhase(): 'recovering' | 'ready' | 'draining' | 'quarantined' | 'released' {
    return this.phase;
  }

  // ── internals ──

  private owns(attempt: ExecutionAttempt): boolean {
    return attempt.epoch === this.epoch && this.active.get(attempt.sessionId) === attempt;
  }

  private unsettledRow(sessionId: string): { turn_id: string; started_at: number; phase: string; stop_requested: number } | undefined {
    return this.agent.prepare("SELECT turn_id, started_at, phase, stop_requested FROM butler_executions WHERE session_id = ? AND phase != 'settled'").get(sessionId) as { turn_id: string; started_at: number; phase: string; stop_requested: number } | undefined;
  }

  private setPhase(phase: 'recovering' | 'ready' | 'draining' | 'quarantined' | 'released'): void {
    this.phase = phase;
    this.agent.prepare('UPDATE butler_execution_authority SET phase = ? WHERE singleton = 1').run(phase);
    if (phase === 'ready' && !this.closing) {
      for (const cb of this.readyWaiters.splice(0)) {
        try { cb(); } catch { /* a waiter fault never blocks readiness */ }
      }
    }
  }
}
