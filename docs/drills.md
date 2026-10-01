# Butler drills — live verification log

## 2026-10-01 — Condition 3 (live authoring loop), glm-5.3-flash via z.ai coding endpoint

- Endpoint: `https://api.z.ai/api/coding/paas/v4` (GLM Coding Plan; the general
  `paas/v4` endpoint returned 1113 no-balance for this key)
- Session `sess_d7e06f2a-493`, budget defaults; 10 hops, 62.9s wall,
  13,721 prompt / 1,979 completion tokens (per-turn accounting rows verified in
  `butler_messages`)
- Prompt: "Draft a spec for DEMO-101 … Search the docs first, draft the spec
  with spec.draft, validate it with spec.validate, and tell me which document
  sha256 you used."
- Observed loop (from persisted rows):
  1. `docs.search` → found DEMO-101 chunk by sha
  2. `docs.get` → read the full ticket fixture
  3. `spec.draft` #1 → validator: INVALID (steps missing)
  4. `spec.draft` #2 → validator: INVALID (steps shape wrong)
  5. `spec.draft` #3 → **VALID**
  6. Final answer cited sha256 `5f8f5f7c…32c33` — matches
     `butler_documents` row for `file://ticket-login-spec.md` exactly
- Two self-repairs against validator feedback (Self-Refine discipline — the
  model never judged its own draft valid; the schema did). Provenance citation
  verified against the DB, not taken from the answer text.

## 2026-10-01 — Stage 4 boot drill (mock provider, labeled)

Clean boot on :8791; session created; message turn ran; answer honestly
labeled "(mock provider — set BUTLER_PROVIDER_BASE_URL for live)"; hops=2.
