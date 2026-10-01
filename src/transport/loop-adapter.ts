/** Registry→loop adapter: wraps ToolRegistry entries as LoopTools. The policy
 *  is passed explicitly — no module-global state. */
import type { LoopTool, TurnEvent, LoopResult } from '../loop.ts';
import type { ToolRegistry, Policy, ToolContext } from '../tools.ts';

export function toolFromRegistry(name: string, registry: ToolRegistry, policy: Policy, ctxBase: { sessionId: string }): LoopTool {
  const def = registry.get(name);
  if (!def) throw new Error(`tool "${name}" not registered`);
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    execute: (args, ctx) => registry.execute(name, args, { signal: ctx.signal, sessionId: ctxBase.sessionId } satisfies ToolContext, policy),
  };
}

export type { LoopTool, TurnEvent, LoopResult } from '../loop.ts';
export type { Provider } from '../provider/index.ts';
