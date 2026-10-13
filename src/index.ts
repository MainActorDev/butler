/** Butler — reusable agent runtime (plan 20261001T035356Z rev 3.1).
 *  v1 surface lands by stage; this barrel re-exports as modules arrive. */
export const BUTLER_VERSION = '0.3.0';

// Stage 1 — provider + loop
export * from './provider/index.ts';
export { runLoop, LoopError, DEFAULT_BUDGET } from './loop.ts';
export type { LoopBudget, LoopTool, LoopDeps, LoopResult, TurnEvent } from './loop.ts';

// Stage 2 — tools + policy + memory
export { ToolRegistry, PolicyRefusal, READ_ONLY, DRAFT, ACT, permits } from './tools.ts';
export type { Permission, Policy, ToolDef, ToolContext } from './tools.ts';
export type { Storage, SessionRow, MessageRow, NoteRow, NoteKind, SourceRow, DocumentRow, ChunkRow, NewSession } from './memory/contract.ts';
export { SqliteStorage } from './memory/sqlite.ts';
export { StorageRetriever, bm25Rank } from './memory/retrieval.ts';
export type { Retriever, RetrievedChunk } from './memory/retrieval.ts';

// Stage 3 — source ingestion + chunking
export { structuralChunks } from './chunk.ts';
export type { StructuralChunk } from './chunk.ts';
export { ingest, sha256Hex, estimateTokens, MAX_TEXT_BYTES, MAX_CHUNKS_PER_SOURCE } from './sources/connector.ts';
export type { SourceConnector, NormalizedDocument, IngestResult } from './sources/connector.ts';
export { fileConnector } from './sources/file.ts';
export { jiraConnector, githubConnector } from './sources/jira-github.ts';
export type { JiraSourceConfig, GithubSourceConfig } from './sources/jira-github.ts';
export { repoConnector } from './sources/repo.ts';
export type { RepoSourceConfig } from './sources/repo.ts';

// Stage 4 — transports (conversation API + MCP; consumers mount these)
export { registerConversationApi } from './transport/conversation.ts';
export type { ConversationDeps, TurnOutcome } from './transport/conversation.ts';
export { mountMcp } from './transport/mcp.ts';
export type { McpMountOpts } from './transport/mcp.ts';

// Roadmap stage G — symbol chunks (repo sources opt-in)
export { extractSymbols, symbolChunks } from './sources/tree-sitter.ts';
export type { SymbolInfo, SymbolChunk } from './sources/tree-sitter.ts';

// Roadmap stage F — postgres storage driver
export { PostgresStorage } from './memory/postgres.ts';

// Roadmap stage E — embeddings + hybrid retrieval
export { HashEmbedding, OpenAICompatEmbedding, TokenEmbedding, cosine } from './embeddings/index.ts';
export type { EmbeddingProvider } from './embeddings/index.ts';

// Roadmap stage D — orchestration L2
export { fanOut, spawnTool, childBudgets } from './orchestrate/supervisor.ts';
export type { ChildSpec, ChildReport, SupervisorDeps } from './orchestrate/supervisor.ts';

// Stage 5 — eval harness
export { evalRetrieval, evalBudget, evalAuthoring } from './eval.ts';
export type { EvalResult, EvalCase, RetrievalEvalInput, BudgetEvalInput, AuthoringEvalInput } from './eval.ts';

// ── P1 agent core: profiles, workflows, artifacts, claude-cli executor ──
export { ProfileError, resolveProfile, providerFromConfig, notesBlockFor, scopeMatches } from './profile/profile.ts';
export type { AgentProfile, ExecutorConfig, ExecutorKind, ResolvedProfile } from './profile/profile.ts';
export { runWorkflow, answerWorkflow, WorkflowError, SqliteWorkflowStorage , advanceWorkflow } from './workflow/run.ts';
export type { WorkflowDeps, RunOutcome } from './workflow/run.ts';
export type { WorkflowSpec, StageSpec, StageResult, QuestionPayload, WorkflowRunRow, WorkflowStageRow, WorkflowStorage, Validator } from './workflow/spec.ts';
export { isQuestionPayload } from './workflow/spec.ts';
export type { ArtifactRow } from './memory/contract.ts';
export { claudeCliProvider, ClaudeCliProvider } from './provider/claude-cli.ts';
export type { ClaudeCliEvent } from './provider/claude-cli.ts';

export { decide, fold, initialState, TURN_EVENT_SCHEMA_VERSION } from './orchestrate/turn-engine.ts';
export type { TurnCommand, TurnEvent as DurableTurnEvent, TurnEventKind as DurableTurnEventKind, OrchestratorState, QueueState, UsageMeters } from './orchestrate/turn-engine.ts';
export { EventSink } from './orchestrate/event-sink.ts';
export type { Effect, EventRow, OutboxRow } from './orchestrate/event-sink.ts';
