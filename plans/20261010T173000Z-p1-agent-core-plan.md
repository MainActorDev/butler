# Butler core — profiles, workflows, artifacts, claude-cli adapter (P1)

- Source brainstorm: Lionidas `brainstorm/20261010T172000Z-agentic-feature-scaffold.md` (Q1–Q3 answered 2026-10-10)
- Status: **Ready** (all blocking questions answered; evidence classified below)
- Plan date: 2026-10-10
- Repo: **Butler** (this plan's work lands here; Lionidas consumes via the pinned git dep)
- Branch: `feat/p1-agent-core` from `main`

## Decision log

| # | Decision | Source |
|---|---|---|
| D1 | Executor is CONFIGURABLE per agent profile — `openai-compat` \| `claude-cli` \| `mock`; no fixed vendor | operator 2026-10-10: "make this configurable" (brainstorm Q1 answer) |
| D2 | Chat UI ships AFTER the API-only pipeline (P3 in Lionidas) — this plan is UI-free | operator 2026-10-10 (brainstorm Q2 answer) |
| D3 | a11y inspector: branch + PR, human merges; reuses Lionidas builds — LIONIDAS-side (P4), enabled by this plan's ACT-policy path but not built here | operator 2026-10-10 (brainstorm Q3 answer) |
| D4 | Butler stays agnostic: claude-cli sits BEHIND the provider seam as one executor; Butler never requires it | brainstorm correction #2, accepted by proceeding |
| D5 | Planner questions = first-class workflow PAUSE-POINTS, not errors | brainstorm correction #3, accepted by proceeding |
| D6 | **Memory upgrades (operator "fold that" 2026-10-10)**: (a) `memoryScopes` gets real semantics — profile-declared note-scope READ filtering at resolveProfile time; (b) a workflow-level distillation seam (`onStageComplete` + `distillNotes`) so consumers write durable notes from stage results; (c) note supersession gains CONTRADICTION state (supersede-with-reason), per the LLM-wiki pattern (Karpathy gist 442a6bf…, reviewed 2026-10-10) — knowledge must compound and flag conflicts, not silently overwrite | this round |
| D7 | **Knowledge is persistent per-entity, not per-run** (same LLM-wiki grounding as D6c): the compile step integrates INTO maintained per-entity pages; run artifacts remain as snapshots/provenance | this round; Lionidas side lives in the P2 plan |
| D8 | **Orchestration NOT in scope** — fanOut exists and stays in the toolbox; P2's pipeline is sequential (workflow), nothing through P5 needs parallel fan-out | operator question "do we need that now?" → no |

## Evidence ledger

- **Confirmed**: Butler `main` exports (verified today, `src/index.ts`): `Provider` seam (`openai-compat`, `mock`), `runLoop` + budgets, `ToolRegistry`/`READ_ONLY|DRAFT|ACT` policies, `Storage` contract (sqlite + pg), retrieval BM25, sources (file/jira-github/repo + symbols), `registerConversationApi`, `mountMcp`, `fanOut`/`spawnTool` (L2 supervisor, session-tree, budget roll-up). 96 tests green at `f271535`; later commits `3c17edc` (mcp instructions), `7db8fcd`.
- **Confirmed (researched 2026-10-10, code.claude.com docs)**: claude-cli headless = `claude -p --bare --output-format stream-json` (+ `--resume <sid>`, `--allowedTools`, `--permission-prompts none`, `--mcp-config`); one subprocess per session; subagent depth/concurrency/spend caps env-set; SIGTERM = hard kill (143) vs SIGINT = clean turn end. Agent SDK exists but the CLI subprocess IS the seam — Butler spawns it directly, no SDK dependency needed.
- **Confirmed (pattern wisdom, 2026 research)**: typed handoffs between stages; summaries-not-transcripts at boundaries; capped re-plan counters; checkpoint/resume; per-agent budgets; pause-points for human gates.
- **Proposed→accepted by this plan being approved for write**: profiles/workflows/artifacts shapes below are my design, traceable to the brainstorm's accepted direction.

## Objective

Butler gains the core infrastructure a multi-agent consumer needs: **named agent profiles, typed sequential workflows with pause-points + checkpoint/resume, a durable artifact store, and claude-cli as a configurable executor** — each with contract tests, no Lionidas-specific knowledge inside Butler.

## Completion conditions (measurable)

1. **C1 Profiles.** `AgentProfile` record: `{ id, systemPrompt, tools: string[] | '*', policy: Permission class, provider: ProviderConfig & { kind: 'openai-compat' | 'claude-cli' | 'mock' }, budgets?: Partial<LoopBudget>, memoryScopes?: string[] }`. `resolveProfile(profile, deps)` returns a fully-wired `LoopDeps` (registry filtered to the tool subset, policy set, provider constructed per kind). **memoryScopes semantics (D6a):** the note block injected into the system prompt is FILTERED to the declared scope prefixes — a planner reading `app:<bundle>/*` conventions never sees another app's notes. Contract tests: tool filtering, policy pinning, **scope-filtered note injection**, mock-provider round-trip, unknown-tool-name error.
2. **C2 Workflows.** `WorkflowSpec` = ordered stages; each stage: `{ id, profileId, input: zod-like schema via plain TS validator, handoff: (prev) => payload, replanLimit?: number, pause?: 'on-question', onStageComplete?: (result) => Promise<void> }`. Runtime `runWorkflow(spec, input, deps)`: runs stages sequentially, persists a `workflow_run` row + per-stage `workflow_stage` rows (status: pending/running/paused/done/failed, attempt counter), **pauses** when a stage emits `{ type: 'question', questions }` (run state = `awaiting_answer`, answer resumes from the SAME stage), **checkpoints** after every stage (a crashed run `resumeWorkflow(runId)` continues from the last done stage), re-plan counter refuses after N retries. **Distillation seam (D6b):** `onStageComplete` fires after each stage with the typed result — the consumer decides what becomes a durable note (`distillNotes()` helper wraps note writes with provenance = run id + stage id). Contract tests: happy 3-stage path; pause→answer→resume; crash→resume skips done stages; replan cap; typed-handoff validation failure named; **distillation writes provenance-carrying notes**.
2b. **C2b Note supersession gains contradiction state (D6c).** `supersedeNote(id, byId, at, reason?: 'refuted' | 'refined' | 'superseded')` — append-only chain unchanged, but the supersession row records WHY; `activeNotes()` output includes `superseded_reason` on the chain head when present. The LLM-wiki lesson: contradictions get FLAGGED (run 3 said no identifier; run 7's code read found one), never silently dropped. Contract tests: supersede-with-reason round-trip; unreasoned supersession still valid (back-compat).
3. **C3 Artifacts.** `ArtifactStore` on the Storage contract: `saveArtifact({ runId?, sessionId?, kind, name, body, provenance }) → { id, version }`, `getArtifact(id, version?)`, `listArtifacts({ kind, runId })`, versions append-only (supersession pointer like notes). Contract tests ride the existing storage-contract suite (both drivers).
4. **C4 claude-cli adapter.** `claudeCliProvider(config)` implementing `Provider` over `claude -p --bare --output-format stream-json --resume <sid>` subprocess: maps Butler `ProviderMessage`→claude input, parses stream-json events→`ProviderResponse`, maps policy class→`--allowedTools` allowlist, `--permission-prompts none` (Butler's permission gate stays upstream in the registry), session-id continuity via `--resume`, SIGINT-first shutdown (clean turn end; SIGTERM fallback after grace), timeoutMs enforced. Tests use a **fake `claude` binary** (fixture script emitting stream-json) — no real CLI, no keys; hermetic.
5. **C5 Provider-kind resolution.** `providerFromConfig(cfg)` factory: `'openai-compat' | 'mock' | 'claude-cli'` → Provider. Registered in the barrel export. Mock stays the CI default.
6. **C6 Docs.** `docs/agent-core.md`: profiles (consumer's view), workflow spec + pause/resume semantics, artifacts, executor config matrix (incl. claude-cli flags used + why `--bare`), migration note from raw-session usage. README badges/tests updated.
7. All existing tests stay green (96+ baseline); new suites ~35+ tests; `pnpm check` (tsc + vitest) green.

## Out of scope (this plan)

- Lionidas-side anything (P2/P3/P4 — separate plans in that repo)
- Real claude-cli live drill (P5; adapter ships fixture-proven here)
- Cross-process fleets / durable supervision (L3, unchanged deferral); **parallel fan-out orchestration (D8 — sequential workflows only; fanOut stays exported and tested, just not consumed by these plans)**
- Embeddings/hybrid default (BM25 stays)
- Any UI

## Architecture

```
src/profile/profile.ts        AgentProfile + resolveProfile (C1)
src/workflow/spec.ts          WorkflowSpec/stage types + validators (C2)
src/workflow/run.ts           runWorkflow / resumeWorkflow / answerQuestion (C2)
src/workflow/storage.ts       workflow_run / workflow_stage tables via Storage (C2)
src/memory/artifacts.ts       ArtifactStore on the Storage contract (C3)
src/provider/claude-cli.ts    claudeCliProvider (C4) — subprocess, stream-json
src/provider/factory.ts       providerFromConfig (C5)
src/index.ts                  barrel exports
docs/agent-core.md            consumer docs (C6)
```

Storage additions (both sqlite + postgres drivers, guarded migrations):
`workflow_runs(id, spec_id, status, input_json, current_stage, created_at, updated_at)`,
`workflow_stages(run_id, stage_id, status, attempt, payload_json, question_json, started_at, ended_at)`,
`artifacts(id, run_id, session_id, kind, name, version, body, provenance_json, superseded_by, created_at)`.

## Stage order

1. **S1 C3 artifacts** (storage-level, no deps on the rest; unblocks everything that persists)
2. **S2 C1 profiles** (registry filtering + policy + provider wiring)
3. **S3 C2 workflows** (uses S2; pause/resume/checkpoint on S1 tables)
4. **S4 C4 claude-cli adapter + C5 factory** (independent of S2/S3; fixture-proven)
5. **S5 C6 docs + barrel + full gates**

## Edge cases & failure cases (planned tests)

- Stage emits question → run pauses; answer with wrong stage id → typed error
- Resume after crash mid-stage: partial stage row resets to pending, attempt+1, replan cap enforced
- claude-cli subprocess dies (fake exits nonzero) → ProviderError with exit code + last event; retry per DEFAULT_RETRY for retryable shapes
- `--resume` session lost (fake reports unknown session) → fresh session fallback + event noting the reset
- Artifact version chain: save twice → v2 supersedes v1, get(v1) still returns (append-only)
- **Note supersession with reason**: refuted note's chain head carries `superseded_reason: 'refuted'`; old unreasoned rows still list (back-compat)
- **Scope filter**: profile scoped `app:a/*` never receives `app:b/…` notes in its injected block (asserted on the assembled system prompt)
- Profile with `tools: ['nope']` → resolve-time error naming the unknown tool
- Workflow handoff validator failure → stage fails with the validator message, no silent coercion

## Validation & acceptance

- Contract tests per completion condition (above counts); full suite green; tsc strict.
- **Drill (mock-provider, hermetic)**: a 3-stage demo workflow (scope→breakdown→author shapes with mock providers) pauses on a question, is resumed, crashes (simulated) mid-stage-2, resumes from the last checkpoint, and saves 2 artifacts — asserted against DB rows, not console output. Recorded in `docs/drills.md`.

## Handoff

- Tag `v0.3.0` after merge; Lionidas P2 pins it. Butler's `docs/consumers.md` gains a P1 section pointing at `docs/agent-core.md`.
