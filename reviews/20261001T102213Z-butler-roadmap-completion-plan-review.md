# Review — Butler roadmap-completion plan

- Plan reviewed: `plans/20261001T102213Z-butler-roadmap-completion-plan.md` (Ready, 2026-10-01, single version)
- Evidence sources: the plan; source brainstorm `../lionidas/brainstorm/20261001T102213Z-butler-roadmap-completion.md` (all answers verified present); Butler repo state verified 2026-10-01 — `src/transport/conversation.ts` (routes: POST sessions, GET /:id, POST messages ONLY; zero abort handling), `src/loop.ts` (onEvent emits hop-level events; NO token streaming deltas), `src/memory/sqlite.ts:129` (listSessions exists, unexposed), `demo/app.ts` (no static serving); live probe: z.ai MAINLAND `open.bigmodel.cn/api/paas/v4/embeddings` with the same key → `1211 模型不存在` (dead for Q-embeddings option (a)); `docs/use-case-qa-spec.md` (the user-facing walkthrough whose claims the UI must honor).
- Verdict: **Needs revision** — 2 High (both about plan-vs-reality gaps that will bite mid-build), 3 Medium, 2 Low. All corrections are plan edits; no operator decisions strictly required (Q1/Q2 already handled as open items).

## Traceability

R1–R6 each trace to verified operator answers in the brainstorm. Conditions 1–8 map to stages A–H (C1→A, C2→B, C3→C, C4→D, C5→E, C6→F, C7→G, C8→H). Sequencing (R6) is honored. Out-of-scope is consistent with R1. The D16 "evals first" deal is correctly embedded as Stage D.0. Two completeness gaps found (F1, F2 below) — both are missing-work items rather than wrong work.

## Findings

### F1 — HIGH — Stage B (Vue UI) requires API surfaces that do not exist and the plan never schedules building them
- **Location:** Stage B; condition 2; `docs/use-case-qa-spec.md` Steps 3–5.
- **Evidence:** `src/transport/conversation.ts` exposes exactly three routes (POST /sessions :37, GET /sessions/:id :45, POST /:id/messages :52). The UI plan and the shipped use-case doc require: **abort** a running turn (doc Step 5 "hit Abort"; grep shows zero abort handling — the loop takes a signal but nothing wires an HTTP/WS abort to it), **list sessions** for the Sessions browser (`listSessions` exists at sqlite.ts:129 but no route), **list documents/notes** for the browsers (no routes at all), and **static serving** of the built UI at `/` (demo/app.ts has none). The plan's condition 2 says the UI uses "ONLY public API/WS/MCP surfaces" — correct principle, but those surfaces are four routes short of the UI it describes.
- **Consequence:** Stage B starts and immediately stalls on missing endpoints — or worse, the UI quietly reaches into internals, violating the very boundary condition (2) it must prove.
- **Correction:** add an explicit **Stage B.0: consumer API completion** — `POST /api/agent/sessions/:id/abort` (wires an AbortController per active session turn; loop already accepts `signal`), `GET /api/agent/sessions` (list, backs the browser), `GET /api/agent/documents` + `GET /api/agent/notes` (read-only lists for the browsers), and `@fastify/static` mount at `/` for the built UI. All four are consumer-facing additions to the CORE transport, with contract tests — the boundary holds because they're API, not internals.
- **Verify:** plan Stage B contains B.0 with these five items; condition 2 unchanged (it then passes honestly).

### F2 — HIGH — The UI/eval promise "watch the agent stream" overclaims: no token-level streaming exists
- **Location:** Stage B ("watch tool calls stream in real time"), condition 2, use-case doc Step 2.
- **Evidence:** `src/loop.ts` events are hop-level (`turn.start`, `provider.response` AFTER a full completion, `tool.call`/`tool.result`). There is no incremental answer delta — the OpenAI adapter doesn't request streaming at all. What the UI can show live TODAY is the sequence of tool calls and verdicts; the final ANSWER text arrives whole at `turn.end`.
- **Consequence:** the built UI will not match the doc's language; a reviewer testing "streaming" sees nothing stream for the long final-answer wait (10-hop drill: ~60 s with visible gaps), and condition 2's acceptance becomes ambiguous.
- **Correction (choose one, both legitimate):** (a) scope honestly — Stage B says "live tool-call/verdict feed; answer arrives at turn end" and the use-case doc is amended to match; or (b) add SSE-free delta streaming as explicit Stage B work (provider `stream: true`, `onDelta` through loop → WS `butler.delta` events). Recommendation: **(a) for this plan, (b) as a ROADMAP entry** — streaming is a provider+loop change worth its own eval'd stage, not a rider on the UI.
- **Verify:** plan text and use-case doc agree on what streams; if (b) chosen, it appears as separate staged work.

### F3 — MEDIUM — Notes-injection claim: the use case promises cross-session knowledge; the core never injects notes into context
- **Location:** Use-case doc Step 4 ("ask in a NEW session — the note is injected by scope key"); related Stage B browsers.
- **Evidence:** `src/transport/conversation.ts` builds the system prompt as a constant; nothing calls `activeNotes()`. Notes are stored and retrievable via the tool, but automatic injection is unbuilt (the brainstorm's memory design intended it: "notes are injected into the system prompt by (app, screen, flow) keys").
- **Consequence:** the doc's demo moment silently fails — a new session won't know the note unless the agent happens to call `docs.search`, which ranks notes only if registered.
- **Correction:** Stage B.0 (per F1) or Stage A adds core-side **context injection**: conversation API fetches top-N active notes matching the session's scope (or all, corpus is small) and appends them to the system prompt, marked as notes with provenance; unit + contract test; doc unchanged thereafter.
- **Verify:** a test: note saved in session 1 → new session's first provider call includes the note content in the system prompt.

### F4 — MEDIUM — Stage D wall-time assertion invites CI flakiness
- **Location:** Stage D.0 ("wall time < serial time (bounded, deterministic mocks)").
- **Evidence:** timing assertions under CI load are classically flaky even with mocks (scheduler jitter). The budget design itself (child wall = parent deadline − elapsed) is sound; it's the *comparison* assertion that's fragile.
- **Consequence:** intermittent red CI erodes trust in the eval suite — worse than no assertion.
- **Correction:** assert concurrency STRUCTURALLY, not by wall clock: with deterministic mocks, a 4-child fan-out over a fake clock (inject `now()` into budgets) or by asserting interleaving evidence (≥2 children had an in-flight provider call simultaneously — recordable via event ordering), plus a generous wall bound (fan-out ≤ serial×0.8 with wide margin, or dropped entirely in CI and kept as a local-only logged metric).
- **Verify:** Stage D.0 text names the structural assertion; no bare `<` wall comparison remains in CI.

### F5 — MEDIUM — Q-embeddings option (a) is dead; the plan still lists it
- **Location:** Open items Q-embeddings.
- **Evidence:** probed 2026-10-01 — mainland `open.bigmodel.cn/api/paas/v4/embeddings` with the SAME key returns `1211 模型不存在` (model does not exist). Cross-platform keys don't carry; option (a) requires a separate mainland account, not just the current key.
- **Consequence:** minor — a build-time chase after a dead option.
- **Correction:** reword Q-embeddings options to: (a) mainland platform WITH a separate mainland account/key, (b) any other OpenAI-compatible embeddings endpoint, (c) mock-only hybrid for this plan, live comparison deferred. Default (c) if unanswered.
- **Verify:** plan Q-embeddings text matches.

### F6 — LOW — Stage B boundary rule needs precise phrasing
- **Location:** Stage B boundary-test claim ("demo/ui/src imports no ../../src internals").
- **Evidence:** the UI will legitimately import TYPES from the barrel in some setups; the rule should forbid value-imports of internals, not the public barrel.
- **Correction:** phrase as: `demo/ui/**` may import nothing from the package except via the public barrel AND must not import `../src/**` directly (Vite alias `@butler` → barrel or none at all; fetch/WS only is the cleanest).
- **Verify:** Stage B boundary bullet updated.

### F7 — LOW — Condition 8 lacks a UI-build gate expression
- **Location:** Condition 8 ("all gates green … build for the Vue app").
- **Evidence:** `pnpm check` currently = tsc + vitest; the UI brings a second tsconfig + vite build that needs an explicit script and CI inclusion.
- **Correction:** name it: `demo/ui` gets `check` = `vue-tsc --noEmit && vite build`; root check chains it.
- **Verify:** Stage B/H text names the script.

## Human questions

None blocking — F2's (a)/(b) choice is the only judgment call; recommendation (a) stands unless the operator wants delta streaming in this plan.

## Required plan edits (to reach Ready)

1. F1: insert Stage B.0 (abort route, sessions list, documents/notes lists, static mount — with contract tests).
2. F2: honest streaming language in Stage B + condition 2; delta streaming → ROADMAP entry (or explicit staged work if operator overrides).
3. F3: core-side note injection with test (Stage B.0 or A).
4. F4: structural concurrency assertion replacing the bare wall-clock comparison.
5. F5: Q-embeddings options corrected; default (c).
6. F6/F7: boundary phrasing + UI check script named.

## What remains to validate during implementation

Paper review only. Execution must prove: the abort graph end-to-end (UI button → WS → controller → child provider calls cancelled, rows consistent); note injection improving (or at least not degrading) authoring evals; hybrid vs BM25 measured on the synthetic corpus; pg parameterized leg actually running somewhere once; tree-sitter wasm loading without runtime network; the Vue UI against the live provider holding a full session without regressions to internals.
