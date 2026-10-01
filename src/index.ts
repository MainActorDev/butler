/** Butler — reusable agent runtime (plan 20261001T035356Z rev 3.1).
 *  v1 surface lands by stage; this barrel re-exports as modules arrive. */
export const BUTLER_VERSION = '0.1.0';

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
