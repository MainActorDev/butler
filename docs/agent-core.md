# Agent core (P1) — profiles, workflows, artifacts, claude-cli

Butler v0.3 adds the core infrastructure a multi-agent consumer needs.
Nothing here knows about any specific consumer — Lionidas brings the tools,
prompts, and policy; Butler brings the machinery.

## Agent profiles (`resolveProfile`)

A **profile** is a named, deployable agent unit:

```ts
const planner: AgentProfile = {
  id: 'planner',
  systemPrompt: 'You plan test scopes…',
  tools: ['cases.list', 'sources.search', 'notes.read'],  // or '*'
  policy: 'read',                                        // read | draft | act
  provider: { kind: 'openai-compat', baseUrl, apiKey, model },  // or 'claude-cli' | 'mock'
  budgets: { maxHops: 8 },
  memoryScopes: ['app:com.foo/*'],                       // note scopes injected into the prompt
};
```

`resolveProfile(profile, { registry, storage })` produces the runtime: tools
filtered to the declared subset (unknown names fail at resolve time), policy
pinned, provider constructed per `kind`, and the system prompt extended with a
notes block **filtered to `memoryScopes`**. Unscoped profiles get no notes —
knowledge is declared, never ambient. Executors are **configuration**, not
code: switch a profile from glm to claude-cli by changing its `provider.kind`.

## Workflows (`runWorkflow` / `answerWorkflow`)

A **workflow** is ordered stages over profiles — sequential with gates, NOT
parallel orchestration (`fanOut` remains available separately).

```ts
const spec: WorkflowSpec = {
  id: 'author',
  input: (x) => …,                       // plain-TS validator
  stages: [
    { id: 'plan', profileId: 'planner', pauseOnQuestion: true,
      input: (x) => …, handoff: (o) => ({ plan: o }),
      replanLimit: 2,
      onStageComplete: async (r) => { /* distill notes here */ } },
    { id: 'author', profileId: 'author', input: (x) => … },
  ],
};
const out = await runWorkflow(spec, deps, { input: { refs: […] } });
```

- **Pause-points**: a stage configured `pauseOnQuestion` whose final answer
  parses as `{ type:'question', questions:[…] }` parks the run in
  `awaiting_answer` (question JSON persisted on the stage row).
  `answerWorkflow(deps, runId, stageId, { qId: answer })` folds the answers
  into the stage payload; re-calling `runWorkflow({ runId })` resumes the
  SAME stage with them.
- **Checkpoint/resume**: every transition persists before acting. A crashed
  run resumes from the last done stage — done outputs are restored THROUGH
  each stage's `handoff` (the next stage sees the transformed payload, never
  raw output). Attempt counters enforce `replanLimit` per stage.
- **Distillation seam**: `onStageComplete(result)` fires with the typed
  stage result — write durable notes here (provenance: run id + stage id).
- **Events**: `workflow.started / stage_started / stage_done / paused /
  answered / stage_failed / done` flow to your `emit` sink for bus bridging.

Storage: `butler_workflow_runs` + `butler_workflow_stages` via
`SqliteWorkflowStorage(db)` (guarded CREATE IF NOT EXISTS).

## Artifacts (`storage.saveArtifact`)

Durable pipeline outputs — versioned per `(kind, name)`, append-only, with
provenance JSON and a supersession pointer like notes. The LLM-wiki pattern:
a per-entity knowledge PAGE (`kind:'knowledge', name:'app:com.foo'`) is
re-`saveArtifact`-ed each run — the new version supersedes the old, the old
stays readable. `latestArtifact(kind, name)` reads the chain head.

## Notes: contradiction-state supersession

`supersedeNote(id, byId, at, reason?)` — reason is
`'refuted' | 'refined' | 'superseded'`. The injected notes block renders the
reason (`superseded: refuted`), so contradictions discovered by later runs
are VISIBLE, never silently dropped.

## claude-cli executor

`provider: { kind: 'claude-cli', binPath?, policyClass?, timeoutMs?, model? }`
spawns `claude -p --bare --output-format stream-json --permission-prompts
none --allowedTools …` (mapped from `policyClass`). The conversation's system
messages ride `--append-system-prompt`; the last user message is the prompt.
Session ids from the `system/init` event are reused via `--resume`.
Shutdown is SIGINT-first (clean turn end), SIGKILL after 2s grace. Butler's
registry remains the permission gate; the CLI allowlist is defense in depth.
Hermetic tests run a fake `claude` binary — no real CLI, no keys.

## Migration from raw sessions

Conversation-API sessions are unchanged. Profiles/workflows layer ON TOP:
mount the same registry; a workflow stage is one loop turn under a profile.
Lionidas pins this via `@mainactordev/butler#v0.3.0`.
