# Butler

A reusable agent runtime: OpenAI-compatible provider, bounded tool-calling loop,
permission-gated tool registry, layered memory (sessions, provenance-stamped
notes, content-addressed documents), source ingestion, and conversation-API +
MCP transports. Consumers bring their own tools, sources, and policy — Butler
is the butler, not the household.

> The generic demo consumer (`demo/`) exercises every subsystem and doubles
> as the executable quickstart:
>
> ```bash
> pnpm install
> npx tsx demo/app.ts        # mock provider; set BUTLER_PROVIDER_BASE_URL for live
> # POST /api/agent/sessions · WS /ws (butler.* events) · POST /mcp (MCP)
> ```

## Status

- [x] Stage 0 — repo skeleton, boundary guard, ROADMAP
- [x] Stage 1 — provider + loop (mock-driven)
- [x] Stage 2 — tools + policy + sqlite memory
- [x] Stage 3 — source ingestion + chunking + retrieval
- [x] Stage 4 — generic demo consumer (conversation API + WS + MCP)
- [x] Stage 5 — eval harness + docs

Docs: `docs/api.md` (package surface) · `docs/consumers.md` (adoption
contract) · `docs/drills.md` (live verification log — condition 3 proven
against glm-5.3-flash). See `ROADMAP.md` for deferred machinery
(orchestration L2 etc.) and the plan artifacts in the Lionidas repo
(`plans/20261001T035356Z-agentic-infrastructure-core-plan.md`).

## Development

```bash
pnpm install
pnpm check     # tsc --noEmit + vitest (hermetic: mock provider)
```

Node ≥ 24.12 (better-sqlite3 ABI).
