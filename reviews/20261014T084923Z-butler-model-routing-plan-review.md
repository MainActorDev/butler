# Review: butler model routing plan

- Plan reviewed: `plans/20261014T084923Z-butler-model-routing-plan.md` @ Ready
- Evidence: src/provider/{types,openai-compat,claude-cli,mock}.ts, loop.ts provider call, Lionidas context.ts provider construction, conversation.ts complete opts, Portkey requestBody.ts routing types, liorouter accounts/catalog schema.

## Verdict

**Approve with corrections** — architecture is right (embedded router, two protocols, combos-as-fallback, env-referenced secrets), references are faithfully adapted, and all three user decisions are honored. Three findings must be folded in; one changes a data shape.

## Findings

### PR1 (High) — `opts.model` cannot reach the Provider seam as designed

The `Provider.complete` interface signature is fixed across four implementations (openai-compat, claude-cli, mock, router). The plan says `complete(..., opts & { model? })` — but callers below the router (loop.ts) don't know which provider instance is a router; adding a field to `Provider` opts leaks routing into every adapter contract.

**Effect**: implementer either breaks the interface for all adapters or special-cases the router — both messy.
**Correction**: routing selection belongs on the ROUTER's constructor/config or a distinct method: `router.complete(messages, tools, opts, { model?: string })` — the extra arg is router-local; `Provider` stays untouched. Lionidas plumbs its `model` param into the router via a factory seam (`createProviderFromRegistry(env)` returns `{ provider, route(model?) }`), and the conversation transport passes `deps.routeModel?.(b.model)` down. Update the plan's design section accordingly.

### PR2 (Medium) — conversation transport must thread the model choice; plan only says "plumbed"

The chat route lives in butler's conversation.ts (`registerConversationApi`). Lionidas passing `model` on POST body is useless unless butler's transport forwards it to `complete`. Today's transport constructs the call internally with no per-request knobs.

**Effect**: silent no-op feature — picker sends `model`, nothing changes.
**Correction**: add an explicit step/acceptance item: `registerConversationApi` accepts `resolveModel?: (body) => string | undefined`; when present, the transport calls the router's route-aware complete. Include a test asserting the served model changes when body.model changes.

### PR3 (Medium) — JSON-file CRUD races the running router

Lionidas `PUT /api/agent/models` writes the file; the router built at boot holds a parsed registry. Without a reload seam, edits require a server restart (silent staleness — the exact lie-class this project keeps killing).

**Effect**: UI edits appear saved but routing ignores them.
**Correction**: registry load returns a versioned handle; routes call `router.reload()` after write (re-read file, swap maps atomically, keep in-flight turns on the old chain — they already resolved). Acceptance: PUT then immediate chat uses the new registry without restart (test).

### PR4 (Low) — claude-cli kind inside combos needs its env pinning

claude-cli models take `binPath/env` from construction, not `apiKeyEnv`. A combo mixing claude-cli + openai members is legitimate (liorouter does exactly this), but the plan's ModelDef doesn't say how claude-cli members carry their config.

**Correction**: ModelDef gains optional `claude?: { binPath?, mcpConfigPath? }`; the factory reuses the existing claudeCliProvider construction per member.

### PR5 (Low) — health in-memory only survives per-process

Fine for v1 (status page already treats process-lifetime data as truth), but say it explicitly in the plan so the reviewer of the status integration doesn't expect persistence.

## Questions

None blocking.

## Result

Fold PR1 (router-local selection arg), PR2 (transport threading + test), PR3 (reload seam + test), PR4 (claude member config), PR5 (note). No re-review needed — mechanical edits to an otherwise sound plan.
