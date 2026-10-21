import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteStorage } from '../src/memory/sqlite.ts';
import { EventSink } from '../src/orchestrate/event-sink.ts';
import { createSqliteExecutionAuthority, ExecutionAuthority, ExecutionAuthorityBusyError, type ExecutionAttempt } from '../src/orchestrate/execution-authority.ts';

/** chat-reliability F1/F2: the execution authority — election, atomic durable
 *  admission, stash CAS boundary, truthful dead-owner recovery, worker
 *  quarantine — exercised on real disk SQLite (two files: storage + agent). */

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function rig(name: string): { dir: string; main: string; agent: string; storage: SqliteStorage; sink: EventSink } {
  const dir = mkdtempSync(join(tmpdir(), `butler-auth-${name}-`));
  dirs.push(dir);
  // production shape: storage (sessions/messages/stash) and the event sink
  // share the SAME agent DB file; the authority opens a second connection to it
  const main = join(dir, 'main.db');
  const agent = join(dir, 'agent.db');
  const storage = new SqliteStorage(agent);
  const sink = new EventSink(storage['db'] as InstanceType<typeof Database>, { passive: true, enqueueRunTurn: false });
  return { dir, main, agent, storage, sink };
}

async function elect(r: ReturnType<typeof rig>): Promise<ExecutionAuthority> {
  return createSqliteExecutionAuthority({ dbPath: r.agent, sink: r.sink, storage: r.storage });
}

async function ensureSession(r: ReturnType<typeof rig>, sessionId: string): Promise<void> {
  if (!(await r.storage.getSession(sessionId))) await r.storage.createSession({ id: sessionId });
}

async function admittedTurn(r: ReturnType<typeof rig>, auth: ExecutionAuthority, sessionId: string, content = 'do the thing', requestId?: string): Promise<ExecutionAttempt> {
  await ensureSession(r, sessionId);
  const res = auth.tryReserve(sessionId);
  expect(res.status).toBe('reserved');
  const attempt = (res as { attempt: ExecutionAttempt }).attempt;
  const adm = auth.admit(attempt, { content, principalId: 'u1', ...(requestId ? { requestId } : {}) });
  expect(adm.status).toBe('admitted');
  return attempt;
}

describe('F2 — election: one authority per agent DB', () => {
  it('a second executor fails election with SQLITE_BUSY, not silent co-ownership', async () => {
    const r = rig('elect');
    const a = await elect(r);
    await expect(elect(r)).rejects.toBeInstanceOf(ExecutionAuthorityBusyError);
    await a.drain();
    // after a clean release the next executor CAN take over
    const b = await elect(r);
    expect(b.currentPhase()).toBe('ready');
    await b.drain();
  });

  it('a passive sink constructor never fails stale live work (no sweep)', async () => {
    const r = rig('passive');
    await ensureSession(r, 'sess_legacy');
    // fabricate a legacy active fold directly
    r.sink.handle('sess_legacy', { kind: 'turn.request', sessionId: 'sess_legacy', turnId: 't_legacy', prompt: 'p', refIds: [], at: Date.now() } as never, 'chat:sess_legacy:t_legacy');
    const before = r.sink.events('sess_legacy').length;
    const second = new EventSink(new Database(r.agent), { passive: true, enqueueRunTurn: false });
    expect(second.events('sess_legacy').length).toBe(before); // nothing failed
    expect(second.readSnapshot('sess_legacy').state.activeTurnId).toBe('t_legacy');
  });
});

describe('F1 — atomic durable admission', () => {
  it('admit lands events + ledger row in one commit; the session is busy; other sessions are free', async () => {
    const r = rig('admit');
    const auth = await elect(r);
    const attempt = await admittedTurn(r, auth, 'sess_a');

    const fold = r.sink.readSnapshot('sess_a').state;
    expect(fold.activeTurnId).toBe(attempt.turnId);
    const row = new Database(r.agent, { readonly: true }).prepare('SELECT phase, epoch, principal_id FROM butler_executions WHERE turn_id = ?').get(attempt.turnId) as { phase: string; epoch: string; principal_id: string };
    expect(row.phase).toBe('preparing');
    expect(row.epoch).toBe(auth.epoch);
    expect(row.principal_id).toBe('u1');
    expect(auth.tryReserve('sess_a').status).toBe('busy');
    expect(auth.tryReserve('sess_b').status).toBe('reserved');
    await auth.drain();
  });

  it('duplicate requestId: same content → REQUEST_ALREADY_ADMITTED with the original turn; different content → REQUEST_ID_REUSE', async () => {
    const r = rig('reqid');
    const auth = await elect(r);
    const first = await admittedTurn(r, auth, 'sess_a', 'same prompt', '11111111-1114-4111-8111-111111111111');
    await auth.settle(first, 'COMPLETED');

    const again = auth.tryReserve('sess_a');
    expect(again.status).toBe('reserved');
    const dup = auth.admit((again as { attempt: ExecutionAttempt }).attempt, { content: 'same prompt', principalId: 'u1', requestId: '11111111-1114-4111-8111-111111111111' });
    expect(dup).toMatchObject({ status: 'rejected', code: 'REQUEST_ALREADY_ADMITTED' });
    expect((dup as { turnId?: string }).turnId).toBe(first.turnId);

    const other = auth.tryReserve('sess_a');
    const reuse = auth.admit((other as { attempt: ExecutionAttempt }).attempt, { content: 'DIFFERENT prompt', principalId: 'u1', requestId: '11111111-1114-4111-8111-111111111111' });
    expect(reuse).toMatchObject({ status: 'rejected', code: 'REQUEST_ID_REUSE' });
    await auth.drain();
  });

  it('a queue decision rolls back entirely: no execution row, no receipt, fold unchanged', async () => {
    const r = rig('queue');
    const auth = await elect(r);
    await ensureSession(r, 'sess_q');
    // legacy active fold with NO execution row
    r.sink.handle('sess_q', { kind: 'turn.request', sessionId: 'sess_q', turnId: 't_old', prompt: 'p', refIds: [], at: Date.now() } as never, 'chat:sess_q:t_old');
    const res = auth.tryReserve('sess_q');
    expect(res.status).toBe('reserved');
    const adm = auth.admit((res as { attempt: ExecutionAttempt }).attempt, { content: 'new', principalId: 'u1' });
    expect(adm).toMatchObject({ status: 'rejected', code: 'QUEUE_DECISION' });
    const check = new Database(r.agent, { readonly: true });
    expect((check.prepare('SELECT COUNT(*) AS n FROM butler_executions').get() as { n: number }).n).toBe(0);
    expect(r.sink.readSnapshot('sess_q').state.activeTurnId).toBe('t_old'); // untouched
    await auth.drain();
  });
});

describe('F1 — execution boundary: stash peek + CAS consume', () => {
  it('beginExecution snapshots then CAS-consumes the exact stash; Stop-before-start leaves it intact', async () => {
    const r = rig('stash');
    const auth = await elect(r);
    await r.storage.stashPartial('sess_s', 't_prev', JSON.stringify([{ role: 'tool', content: 'earlier work' }]));

    const attempt = await admittedTurn(r, auth, 'sess_s');
    // preparation failed/never ran → stash still there
    expect((await r.storage.peekPartial?.('sess_s'))?.turnId).toBe('t_prev');

    const begun = await auth.beginExecution(attempt);
    expect(beguun(begun)).toBe(true);
    const { seeded } = begun as { seeded: unknown[] | null };
    expect(seeded).toEqual([{ role: 'tool', content: 'earlier work' }]);
    expect(await r.storage.peekPartial?.('sess_s')).toBeNull(); // consumed exactly once
    const row = new Database(r.agent, { readonly: true }).prepare('SELECT phase, resume_turn_id, resume_json FROM butler_executions WHERE turn_id = ?').get(attempt.turnId) as { phase: string; resume_turn_id: string; resume_json: string };
    expect(row.phase).toBe('executing');
    expect(row.resume_turn_id).toBe('t_prev');
    expect(JSON.parse(row.resume_json)).toEqual([{ role: 'tool', content: 'earlier work' }]);
    await auth.drain();
  });

  it('Stop requested during preparation aborts before start without touching the stash', async () => {
    const r = rig('stop');
    const auth = await elect(r);
    await r.storage.stashPartial('sess_st', 't_prev', '[{"role":"user","content":"x"}]');
    const attempt = await admittedTurn(r, auth, 'sess_st');
    const stop = auth.requestStop('sess_st');
    expect(stop).toMatchObject({ status: 'aborting', turnId: attempt.turnId });
    const begun = await auth.beginExecution(attempt);
    expect(begun).toMatchObject({ status: 'rejected', code: 'STOP_BEFORE_START' });
    expect((await r.storage.peekPartial?.('sess_st'))?.turnId).toBe('t_prev');
    expect(attempt.controller.signal.aborted).toBe(true);
    await auth.drain();
  });
});

function beguun(x: unknown): boolean {
  return typeof x === 'object' && x !== null && 'seeded' in x;
}

describe('F2 — truthful recovery and quarantine', () => {
  it('a died executor\'s unsettled turn gets ONE interruption terminal; re-recovery is a no-op; the session returns to ready', async () => {
    const r = rig('recover');
    const a = await elect(r);
    const attempt = await admittedTurn(r, a, 'sess_r');
    await a.drain(); // owner released WITHOUT settling (simulated death)

    const b = await elect(r);
    expect(b.currentPhase()).toBe('ready');
    const evs = r.sink.events('sess_r');
    const failed = evs.filter((e) => e.kind === 'turn.failed');
    expect(failed).toHaveLength(1);
    expect((failed[0]!.detail as { error: string }).error).toContain('interrupted');
    expect(r.sink.readSnapshot('sess_r').state.activeTurnId).toBeNull(); // terminal
    const row = new Database(r.agent, { readonly: true }).prepare('SELECT phase, terminal_code FROM butler_executions WHERE turn_id = ?').get(attempt.turnId) as { phase: string; terminal_code: string };
    expect(row.phase).toBe('settled');
    expect(row.terminal_code).toBe('EXECUTION_INTERRUPTED');
    expect(b.readSession('sess_r')).toMatchObject({ state: 'idle', admission: 'ready' });

    await b.drain();
    const c = await elect(r);
    expect(r.sink.events('sess_r').filter((e) => e.kind === 'turn.failed')).toHaveLength(1); // still exactly one
    expect(c.readSession('sess_r')).toMatchObject({ state: 'idle', admission: 'ready' });
    await c.drain();
  });

  it('unproven previous-epoch workers quarantine ALL fresh execution until operator resolution', async () => {
    const r = rig('quarantine');
    const a = await elect(r);
    // simulate a worker the dead executor never settled: insert directly
    const raw = new Database(r.agent);
    raw.prepare("INSERT INTO butler_execution_workers(worker_id,epoch,turn_id,kind,phase,pid,identity,created_at) VALUES ('w_orphan','" + a.epoch + "',NULL,'cli-child','running'," + process.pid + ",'{}',1)").run();
    raw.close();
    await a.drain();

    const b = await elect(r);
    expect(b.currentPhase()).toBe('quarantined');
    expect(b.tryReserve('sess_any')).toMatchObject({ status: 'unavailable', reason: 'quarantined' });
    expect(b.readSession('sess_any')).toMatchObject({ state: 'uncertain', reason: 'worker_quarantine', admission: 'blocked' });

    // wrong epoch evidence is refused
    expect(b.resolveUncertainWorker('w_orphan', { expectedEpoch: 'not-the-epoch', operatorIdentity: 'op', evidenceRef: 'ps: verified' })).toBe(false);
    expect(b.resolveUncertainWorker('w_orphan', { expectedEpoch: a.epoch, operatorIdentity: 'op', evidenceRef: 'ps: tree verified dead' })).toBe(true);
    expect(b.currentPhase()).toBe('ready');
    expect(b.tryReserve('sess_any').status).toBe('reserved');
    await b.drain();
  });
});

describe('F2 — reads and lifecycle', () => {
  it('readSession walks idle → preparing → running → stopping → idle through a real turn', async () => {
    const r = rig('reads');
    const auth = await elect(r);
    expect(auth.readSession('sess_rw')).toMatchObject({ state: 'idle', admission: 'ready' });
    const attempt = await admittedTurn(r, auth, 'sess_rw');
    expect(auth.readSession('sess_rw')).toMatchObject({ state: 'preparing', turnId: attempt.turnId, admission: 'busy' });
    await auth.beginExecution(attempt);
    expect(auth.readSession('sess_rw')).toMatchObject({ state: 'running', turnId: attempt.turnId });
    auth.requestStop('sess_rw');
    expect(auth.readSession('sess_rw')).toMatchObject({ state: 'stopping', turnId: attempt.turnId });
    // close the turn the way the owning transport does (terminal event first),
    // then settle the ledger — reads must converge to idle
    auth.handleOwned(attempt, 'sess_rw', { kind: 'turn.fail', sessionId: 'sess_rw', turnId: attempt.turnId, error: 'aborted by caller' } as never, `chat:${attempt.turnId}:fail`);
    await auth.settle(attempt, 'ABORTED');
    expect(auth.readSession('sess_rw')).toMatchObject({ state: 'idle', admission: 'ready' });
    await auth.drain();
  });

  it('requestStop with a stale expectedTurnId is rejected; unknown sessions are no_active', async () => {
    const r = rig('stop2');
    const auth = await elect(r);
    expect(auth.requestStop('sess_none')).toMatchObject({ status: 'no_active' });
    const attempt = await admittedTurn(r, auth, 'sess_st2');
    expect(auth.requestStop('sess_st2', 't_someone_else')).toMatchObject({ status: 'stale' });
    expect(auth.requestStop('sess_st2', attempt.turnId)).toMatchObject({ status: 'aborting', turnId: attempt.turnId });
    await auth.drain();
  });

  it('drain awaits tracked workers before releasing the lock', async () => {
    const r = rig('drain');
    const auth = await elect(r);
    let finished = false;
    const worker = auth.trackWorker({ identity: { probe: true } }, 'tail', async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      finished = true;
    });
    const drained = auth.drain();
    await worker;
    expect(finished).toBe(true);
    await drained;
    expect(auth.currentPhase()).toBe('released');
  });
});
