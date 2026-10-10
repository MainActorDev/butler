/** P1 C2 — Workflow spec types: ordered stages over agent profiles.
 *  Sequential with gates; NOT parallel orchestration (D8 — fanOut stays
 *  available, workflows don't consume it). */

/** Plain-TS validator: return an error string or null. (No zod dep — butler
 *  is dependency-light by design; validators close over the shape they check.) */
export type Validator<T> = (input: unknown) => { ok: true; value: T } | { ok: false; error: string };

export interface StageSpec<I, O> {
  id: string;
  profileId: string;
  /** validates the incoming handoff payload for this stage */
  input: Validator<I>;
  /** builds the next stage's payload from this stage's output */
  handoff?: (output: O) => unknown;
  /** re-plan cap: attempts beyond this fail the stage (default 2) */
  replanLimit?: number;
  /** stages that may pause on a question emit them via the question tool contract */
  pauseOnQuestion?: boolean;
  /** D6b distillation seam: fires after the stage completes with its typed result */
  onStageComplete?: (result: StageResult<O>) => Promise<void>;
}

/** A stage's terminal result, passed to handoff/onStageComplete. */
export interface StageResult<O> {
  stageId: string;
  runId: string;
  ok: boolean;
  output: O | null;
  /** the pause payload when ok=false && paused */
  questions?: QuestionPayload;
  tokens: { in: number; out: number };
}

/** the typed pause payload a stage emits to ask the human */
export interface QuestionPayload {
  type: 'question';
  questions: Array<{ id: string; text: string; context?: string }>;
}

export function isQuestionPayload(x: unknown): x is QuestionPayload {
  if (typeof x !== 'object' || x === null) return false;
  const q = (x as { type?: unknown; questions?: unknown });
  return q.type === 'question' && Array.isArray(q.questions)
    && q.questions.every((it) => typeof it === 'object' && it !== null && 'id' in it && 'text' in it);
}

export interface WorkflowSpec<In = unknown> {
  id: string;
  stages: StageSpec<unknown, unknown>[];
  /** validates the pipeline's initial input */
  input: Validator<In>;
}

export type WorkflowStatus = 'running' | 'awaiting_answer' | 'done' | 'failed';
export type StageStatus = 'pending' | 'running' | 'paused' | 'done' | 'failed';

export interface WorkflowRunRow {
  id: string;
  spec_id: string;
  status: WorkflowStatus;
  input_json: string;
  current_stage: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkflowStageRow {
  run_id: string;
  stage_id: string;
  status: StageStatus;
  attempt: number;
  payload_json: string | null;
  output_json: string | null;
  question_json: string | null;
  started_at: number | null;
  ended_at: number | null;
}

/** workflow storage seam — rides the consumer's Storage instance. */
export interface WorkflowStorage {
  createWorkflowRun(row: Omit<WorkflowRunRow, 'created_at' | 'updated_at'>): Promise<WorkflowRunRow>;
  getWorkflowRun(id: string): Promise<WorkflowRunRow | null>;
  updateWorkflowRun(id: string, patch: Partial<Pick<WorkflowRunRow, 'status' | 'current_stage' | 'updated_at'>>): Promise<void>;
  upsertWorkflowStage(row: WorkflowStageRow): Promise<void>;
  workflowStages(runId: string): Promise<WorkflowStageRow[]>;
}
