# Butler demo — try it yourself: the "QA spec from a ticket" use case

*This is a guided, end-to-end scenario you can run in the demo UI. It exercises
every Butler capability in one sitting: multi-source memory, tool calling, the
validator-as-ground-truth loop, policy refusal, provenance, and session
persistence.*

## The setup (one command)

```bash
cd /Volumes/berkakyo/Users/berkamain/Developer/w0rk/lionparcel/ai/butler
pnpm install
# live chat provider (already configured in .env): z.ai coding endpoint, glm-5.3-flash
npx tsx demo/app.ts
# → butler demo on http://127.0.0.1:8790  (provider: live)
```

Open **http://127.0.0.1:8790** in your browser.

## The scenario: you're a QA lead who just got two tickets

The demo ships with two fixture "tickets" already ingested from
`demo/fixtures/`:

- **DEMO-101** — login regression (dashboard must appear within 3s; settle-wait
  pitfall before tapping submit)
- **DEMO-102** — logout confirmation (sheet, then logged-out home)

Your job: get specs drafted for them — and watch exactly HOW the agent works,
including where it fails and self-corrects.

### Step 1 — Create a session

Click **New session** (title it anything, e.g. `qa specs`). The session row
lands in sqlite — you'll be able to resume it later from rows alone.

### Step 2 — The core ask

Type into the chat:

> Draft a spec for DEMO-101 (login regression). Search the docs first, draft
> the spec, validate it with spec.validate, and tell me which document sha256
> you used.

**What to watch in the live activity feed** (each card streams in over the
WebSocket as it happens):

1. `docs.search` — the agent searches; you'll see the BM25 hits (chunks with
   their sha256 refs)
2. `docs.get` — it pulls the full ticket by sha256 prefix
3. `spec.draft` — first draft recorded
4. `spec.validate` — **watch this one closely.** (Tool calls and verdicts stream in live; the final answer text arrives at once when the turn ends.) In the live drill the model
   got the spec shape wrong TWICE (`INVALID: steps required`, then
   `INVALID: steps[N]: {action: string} required`) and repaired itself each
   time before the validator said **VALID**. The verdict badge in the UI
   comes from the validator tool — never the model's own opinion.
5. The final answer cites the document sha256 — you can verify it in the
   Documents browser (step 4 below); it matches `ticket-login-spec.md`.

### Step 3 — Test the gate (the satisfying one)

Now ask:

> Publish the spec.

The `spec.publish` tool is **act-class**; your session runs under the **draft**
policy. Expect a typed refusal naming the tool and the policy — visible right
in the chat. That refusal is Butler's core safety story: the agent can draft
all day; a human publishes.

### Step 4 — Poke the memory

Open the **Documents** browser: the two fixture tickets with their sha256s,
chunk counts, and sources. Open **Sessions**: your session with real token
accounting per turn. Ask the agent:

> Save a note that the login form needs a settle-wait before submit.

It calls `note.save` — note the note REQUIRES a provenance reference (where
this belief came from). Then ask "what do you know about the login screen?"
in a NEW session — the note is injected by scope key, so the knowledge
crosses sessions.

### Step 5 — Kill it mid-thought (optional, but revealing)

Send another draft request and hit **Abort** while the tool calls are
streaming. The loop stops cleanly; the partial transcript persists; reload
the page and resume the session — everything up to the abort is still there.
That's the resumable-from-rows guarantee.

## What you've proven by the end

| Capability | Where you saw it |
|---|---|
| Multi-source ingestion + BM25 retrieval | docs.search hits over ingested fixtures |
| Tool-calling loop with live events | the streaming activity feed |
| Validator as ground truth | INVALID → repair → INVALID → repair → VALID |
| Policy refusal (autonomy gate) | "Publish" refused under draft policy |
| Provenance-stamped memory | note.save demanding a source ref |
| Session persistence/resume | reload after abort; new session recalls the note |
| Token accounting | per-turn in/out in the session browser |

## CLI-only variant (no UI)

```bash
SID=$(curl -s -X POST localhost:8790/api/agent/sessions -H 'content-type: application/json' -d '{}' | python3 -c "import sys,json;print(json.load(sys.stdin)['session']['id'])")
curl -s -X POST localhost:8790/api/agent/sessions/$SID/messages \
  -H 'content-type: application/json' \
  -d '{"content":"Draft a spec for DEMO-101, validate it, and cite the sha256 you used."}' | python3 -m json.tool
```

And the scripted version of this whole scenario (mock provider, no key needed)
is `npx tsx demo/tour.ts` — same beats, deterministic, runs in CI.
