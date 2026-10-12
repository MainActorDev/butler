/** P1 C2 — workflow runtime: sequential stage execution with pause-points,
 *  checkpoint/resume, capped re-planning, and the distillation seam.
 *
 *  How a stage runs: the stage's profile is resolved (filtered tools, policy,
 *  provider, scope-notes prompt), then ONE loop turn executes with the stage
 *  payload as the user message. The stage's output is whatever the loop's
 *  final assistant message carries; a question payload pauses the run.
 *
 *  Crash safety: every stage transition is persisted BEFORE acting on it
 *  (status flip first, work second) — resumeWorkflow() rebuilds from rows. */

import { randomUUID } from 'node:crypto';
import { runLoop } from '../loop.ts';
import type { LoopTool } from '../loop.ts';
import type { ProviderMessage } from '../provider/types.ts';
import { resolveProfile } from '../profile/profile.ts';
import type { AgentProfile } from '../profile/profile.ts';
import type { ToolRegistry } from '../tools.ts';
import type { Storage } from '../memory/contract.ts';
import type { WorkflowSpec, WorkflowStorage, WorkflowRunRow, StageSpec, QuestionPayload } from './spec.ts';
import { isQuestionPayload } from './spec.ts';

export interface WorkflowDeps {
  storage: Storage;
  workflow: WorkflowStorage;
  registry: ToolRegistry;
  profiles: Record<string, AgentProfile>;
  /** event sink for stage transitions (consumers bridge to their bus) */
  emit?: (event: { type: string; runId: string; stageId?: string; detail?: unknown }) => void;
  /** R2-F3: note embedder for retrieval-based memory injection */
  embedder?: import('../embeddings/index.ts').EmbeddingProvider;
}

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowError';
  }
}

/** sqlite-backed workflow storage — tables live beside butler's own (guarded). */
export { SqliteWorkflowStorage } from './storage-sqlite.ts';

export interface RunOutcome {
  runId: string;
  status: WorkflowRunRow['status'];
  stages: Array<{ id: string; status: string; output: unknown }>;
  finalOutput: unknown;
}

/** internal: persist a stage row (upsert semantics) */
async function persistStage(ws: WorkflowStorage, row: Parameters<WorkflowStorage['upsertWorkflowStage']>[0]): Promise<void> {
  await ws.upsertWorkflowStage(row);
}

/** Run (or continue) a workflow. Creates the run row when input is given;
 *  resumes from rows when only runId is given. */
export async function runWorkflow(
  spec: WorkflowSpec,
  deps: WorkflowDeps,
  init: { input?: unknown; runId?: string },
): Promise<RunOutcome> {
  let run: WorkflowRunRow;
  if (init.runId) {
    const existing = await deps.workflow.getWorkflowRun(init.runId);
    if (!existing) throw new WorkflowError(`run ${init.runId} not found`);
    if (existing.spec_id !== spec.id) throw new WorkflowError(`run ${init.runId} belongs to spec '${existing.spec_id}', not '${spec.id}'`);
    if (existing.status === 'done' || existing.status === 'failed') throw new WorkflowError(`run ${init.runId} is ${existing.status} — nothing to continue`);
    run = existing;
  } else {
    const validated = spec.input(init.input);
    if (!validated.ok) throw new WorkflowError(`workflow input invalid: ${validated.error}`);
    run = await deps.workflow.createWorkflowRun({
      id: `wfr_${randomUUID().slice(0, 12)}`,
      spec_id: spec.id,
      status: 'running',
      input_json: JSON.stringify(validated.value),
      current_stage: null,
    });
  }
  deps.emit?.({ type: 'workflow.started', runId: run.id });

  // stage inputs: first stage gets the run input; later stages get handoff outputs
  const stageRows = await deps.workflow.workflowStages(run.id);
  const doneOutputs = new Map<string, unknown>();
  for (const row of stageRows) {
    if (row.status === 'done' && row.output_json) doneOutputs.set(row.stage_id, JSON.parse(row.output_json));
  }

  const parsedInput = JSON.parse(run.input_json);
  let carry: unknown = parsedInput;

  for (const stage of spec.stages) {
    const existing = stageRows.find((r) => r.stage_id === stage.id);
    // skip stages already done (checkpoint resume)
    if (existing?.status === 'done' && doneOutputs.has(stage.id)) {
      // restore THROUGH the handoff — the next stage expects the transformed payload
      const doneOut = doneOutputs.get(stage.id);
      carry = stage.handoff ? stage.handoff(doneOut) : doneOut;
      continue;
    }

    // paused stage: answerWorkflow folded the human answer into payload_json
    // and reset status to 'pending' — that payload IS the carry for this retry
    if (existing?.status === 'pending' && existing.question_json) {
      // answered stage: keep the merged payload (input + answers)
      if (existing.payload_json) carry = JSON.parse(existing.payload_json);
    } else if (existing?.status === 'paused') {
      const resumed = await deps.workflow.workflowStages(run.id);
      const row = resumed.find((r) => r.stage_id === stage.id);
      if (row?.payload_json) carry = JSON.parse(row.payload_json);
    }

    const attempt = (existing?.attempt ?? 0) + 1;
    const limit = stage.replanLimit ?? 2;
    if (attempt > limit) {
      await persistStage(deps.workflow, { run_id: run.id, stage_id: stage.id, status: 'failed', attempt: attempt - 1, payload_json: JSON.stringify(carry), output_json: null, question_json: null, started_at: existing?.started_at ?? null, ended_at: Date.now() });
      await deps.workflow.updateWorkflowRun(run.id, { status: 'failed', current_stage: stage.id });
      deps.emit?.({ type: 'workflow.stage_failed', runId: run.id, stageId: stage.id, detail: 'replan limit' });
      return finish(deps, run.id, spec.id, 'failed');
    }

    // validate the handoff payload for THIS stage
    const vin = stage.input(carry);
    if (!vin.ok) {
      await persistStage(deps.workflow, { run_id: run.id, stage_id: stage.id, status: 'failed', attempt, payload_json: JSON.stringify(carry), output_json: null, question_json: null, started_at: null, ended_at: Date.now() });
      await deps.workflow.updateWorkflowRun(run.id, { status: 'failed', current_stage: stage.id });
      deps.emit?.({ type: 'workflow.stage_failed', runId: run.id, stageId: stage.id, detail: vin.error });
      throw new WorkflowError(`stage '${stage.id}' input invalid: ${vin.error}`);
    }

    // checkpoint: mark running BEFORE work
    await persistStage(deps.workflow, { run_id: run.id, stage_id: stage.id, status: 'running', attempt, payload_json: JSON.stringify(vin.value), output_json: null, question_json: null, started_at: Date.now(), ended_at: null });
    await deps.workflow.updateWorkflowRun(run.id, { status: 'running', current_stage: stage.id });
    deps.emit?.({ type: 'workflow.stage_started', runId: run.id, stageId: stage.id });

    // resolve the stage's profile and run one loop turn
    const profile = deps.profiles[stage.profileId];
    if (!profile) throw new WorkflowError(`profile '${stage.profileId}' (stage '${stage.id}') not found`);
    // R2-F3: retrieval ranking rides the stage input's ask as the query
    const stageAsk = typeof vin.value === 'object' && vin.value !== null && 'ask' in (vin.value as Record<string, unknown>)
      ? String((vin.value as Record<string, unknown>)['ask'] ?? '')
      : '';
    const resolved = await resolveProfile(profile, { registry: deps.registry, storage: deps.storage, ...(deps.embedder && stageAsk ? { embedder: deps.embedder, query: stageAsk } : {}) });
    void resolved;

    const events: ProviderMessage[] = [];
    const result = await runLoop(resolved.systemPrompt, JSON.stringify(vin.value), {
      sessionKey: run.id, // R2-F4: each workflow run is its own claude session
      provider: resolved.provider,
      tools: resolved.tools.map((name) => toolFromRegistry(name, deps.registry, resolved.policy, { sessionId: run.id })),
      ...(resolved.budgets ? { budget: resolved.budgets } : {}),
      onMessage: (msg) => { events.push(msg); },
      // stream the stage turn: forward loop events (turn.delta/turn.tool) as workflow events
      onEvent: (e) => { deps.emit?.({ type: `workflow.${e.type}` as 'workflow.turn.delta', runId: run.id, stageId: stage.id, detail: e.detail }); },
    });
    void events;

    const answer = result.answer ?? '';
    let output: unknown = answer;

    // pause-point: the stage answered with a question payload
    if (stage.pauseOnQuestion) {
      let parsed: unknown = null;
      try { parsed = JSON.parse(answer); } catch { /* plain text answer — not a question */ }
      if (isQuestionPayload(parsed)) {
        const q = parsed as QuestionPayload;
        await persistStage(deps.workflow, { run_id: run.id, stage_id: stage.id, status: 'paused', attempt, payload_json: JSON.stringify(vin.value), output_json: null, question_json: JSON.stringify(q), started_at: null, ended_at: null });
        await deps.workflow.updateWorkflowRun(run.id, { status: 'awaiting_answer', current_stage: stage.id });
        deps.emit?.({ type: 'workflow.paused', runId: run.id, stageId: stage.id, detail: q });
        return finish(deps, run.id, spec.id, 'awaiting_answer');
      }
    }

    // done: persist output, distill, checkpoint forward
    await persistStage(deps.workflow, { run_id: run.id, stage_id: stage.id, status: 'done', attempt, payload_json: JSON.stringify(vin.value), output_json: JSON.stringify(output), question_json: null, started_at: null, ended_at: Date.now() });
    deps.emit?.({ type: 'workflow.stage_done', runId: run.id, stageId: stage.id });

    await stage.onStageComplete?.({ stageId: stage.id, runId: run.id, ok: true, output, tokens: { in: result.tokens.in, out: result.tokens.out } });

    carry = stage.handoff ? stage.handoff(output) : output;

    // manual handoff: a gated stage (not the last) parks the run for approval
    const isLast = spec.stages[spec.stages.length - 1]?.id === stage.id;
    if (stage.gated && !isLast) {
      await deps.workflow.updateWorkflowRun(run.id, { status: 'awaiting_gate', current_stage: stage.id });
      deps.emit?.({ type: 'workflow.stage_gate', runId: run.id, stageId: stage.id, detail: { nextStage: spec.stages[spec.stages.indexOf(stage) + 1]?.id ?? null } });
      return finish(deps, run.id, spec.id, 'awaiting_gate');
    }
  }

  await deps.workflow.updateWorkflowRun(run.id, { status: 'done', current_stage: null });
  deps.emit?.({ type: 'workflow.done', runId: run.id });
  return finish(deps, run.id, spec.id, 'done');
}

/** release a stage gate: the human approved the handoff to the next stage */
export async function advanceWorkflow(deps: WorkflowDeps, runId: string): Promise<void> {
  const run = await deps.workflow.getWorkflowRun(runId);
  if (!run) throw new WorkflowError(`run ${runId} not found`);
  if (run.status !== 'awaiting_gate') throw new WorkflowError(`run ${runId} is '${run.status}', not awaiting a gate`);
  await deps.workflow.updateWorkflowRun(runId, { status: 'running' });
  deps.emit?.({ type: 'workflow.gate_released', runId: runId });
}

/** record a human answer against a paused run; folds it into the stage payload */
export async function answerWorkflow(deps: WorkflowDeps, runId: string, stageId: string, answer: Record<string, string>): Promise<void> {
  const run = await deps.workflow.getWorkflowRun(runId);
  if (!run) throw new WorkflowError(`run ${runId} not found`);
  if (run.status !== 'awaiting_answer') throw new WorkflowError(`run ${runId} is '${run.status}', not awaiting an answer`);
  const rows = await deps.workflow.workflowStages(runId);
  const row = rows.find((r) => r.stage_id === stageId);
  if (!row || row.status !== 'paused') throw new WorkflowError(`stage '${stageId}' is not paused on run ${runId}`);
  const payload = row.payload_json ? JSON.parse(row.payload_json) : {};
  const merged = { ...payload, answers: answer };
  await persistStage(deps.workflow, { ...row, status: 'pending', payload_json: JSON.stringify(merged) });
  await deps.workflow.updateWorkflowRun(runId, { status: 'running' });
  deps.emit?.({ type: 'workflow.answered', runId, stageId });
}

async function finish(deps: WorkflowDeps, runId: string, specId: string, status: string): Promise<RunOutcome> {
  const rows = await deps.workflow.workflowStages(runId);
  return {
    runId,
    status: status as RunOutcome['status'],
    stages: rows.map((r) => ({ id: r.stage_id, status: r.status, output: r.output_json ? JSON.parse(r.output_json) : null })),
    finalOutput: status === 'done'
      ? (rows.length && rows[rows.length - 1]!.output_json ? JSON.parse(rows[rows.length - 1]!.output_json!) : null)
      : null,
  };
  void specId;
}

/** registry tool adapter (same shape the conversation transport uses) */
function toolFromRegistry(name: string, registry: ToolRegistry, policy: 'read' | 'draft' | 'act', ctx: { sessionId: string }): LoopTool {
  void policy;
  const def = registry.list().find((t) => t.name === name);
  if (!def) throw new WorkflowError(`tool '${name}' not in registry`);
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    async execute(args: Record<string, unknown>) {
      return def.execute(args, { sessionId: ctx.sessionId, signal: undefined });
    },
  };
}
