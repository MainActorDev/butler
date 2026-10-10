/** P1 C2 — sqlite workflow storage: butler_workflow_runs / butler_workflow_stages
 *  (guarded CREATE IF NOT EXISTS on the consumer's DB). */
import type Database from 'better-sqlite3';
import type { WorkflowStorage, WorkflowRunRow, WorkflowStageRow } from './spec.ts';

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS butler_workflow_runs(
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','awaiting_answer','done','failed')),
  input_json TEXT NOT NULL,
  current_stage TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS butler_workflow_stages(
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','paused','done','failed')),
  attempt INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT,
  output_json TEXT,
  question_json TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  PRIMARY KEY(run_id, stage_id)
);
`;

export class SqliteWorkflowStorage implements WorkflowStorage {
  constructor(private db: Database.Database) {
    this.db.exec(MIGRATIONS);
  }

  async createWorkflowRun(row: Omit<WorkflowRunRow, 'created_at' | 'updated_at'>): Promise<WorkflowRunRow> {
    const now = Date.now();
    this.db.prepare('INSERT INTO butler_workflow_runs(id, spec_id, status, input_json, current_stage, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(row.id, row.spec_id, row.status, row.input_json, row.current_stage, now, now);
    return { ...row, created_at: now, updated_at: now };
  }

  async getWorkflowRun(id: string): Promise<WorkflowRunRow | null> {
    return (this.db.prepare('SELECT * FROM butler_workflow_runs WHERE id = ?').get(id) as WorkflowRunRow | undefined) ?? null;
  }

  async updateWorkflowRun(id: string, patch: Partial<Pick<WorkflowRunRow, 'status' | 'current_stage' | 'updated_at'>>): Promise<void> {
    const sets: string[] = ['updated_at = ?'];
    const args: unknown[] = [patch.updated_at ?? Date.now()];
    if (patch.status !== undefined) { sets.push('status = ?'); args.push(patch.status); }
    if (patch.current_stage !== undefined) { sets.push('current_stage = ?'); args.push(patch.current_stage); }
    args.push(id);
    this.db.prepare(`UPDATE butler_workflow_runs SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  async upsertWorkflowStage(row: WorkflowStageRow): Promise<void> {
    this.db.prepare(`INSERT INTO butler_workflow_stages(run_id, stage_id, status, attempt, payload_json, output_json, question_json, started_at, ended_at)
                     VALUES (?,?,?,?,?,?,?,?,?)
                     ON CONFLICT(run_id, stage_id) DO UPDATE SET status=excluded.status, attempt=excluded.attempt,
                       payload_json=excluded.payload_json, output_json=excluded.output_json, question_json=excluded.question_json,
                       started_at=excluded.started_at, ended_at=excluded.ended_at`)
      .run(row.run_id, row.stage_id, row.status, row.attempt, row.payload_json, row.output_json, row.question_json, row.started_at, row.ended_at);
  }

  async workflowStages(runId: string): Promise<WorkflowStageRow[]> {
    return this.db.prepare('SELECT * FROM butler_workflow_stages WHERE run_id = ? ORDER BY rowid').all(runId) as WorkflowStageRow[];
  }
}
