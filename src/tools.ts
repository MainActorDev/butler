/** Tool registry + permission policy (plan Stage 2).
 *  Tools declare a permission class; the Policy decides allow/refuse.
 *  Refusal is a typed error naming the tool and the policy — never silent. */

export type Permission = 'read' | 'draft' | 'act';

export class PolicyRefusal extends Error {
  constructor(message: string, readonly tool: string, readonly permission: Permission, readonly policy: string) {
    super(message);
    this.name = 'PolicyRefusal';
  }
}

export interface ToolContext {
  signal: AbortSignal | undefined;
  /** which session invoked (persistence/provenance in Stage 4 wiring) */
  sessionId: string;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON schema for arguments */
  parameters: Record<string, unknown>;
  permission: Permission;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

/** A policy = the max permission the session may exercise. */
export interface Policy {
  readonly name: string;
  readonly allows: Permission;
}

export const READ_ONLY: Policy = { name: 'read-only', allows: 'read' };
export const DRAFT: Policy = { name: 'draft', allows: 'draft' };
export const ACT: Policy = { name: 'act', allows: 'act' };

const RANK: Record<Permission, number> = { read: 0, draft: 1, act: 2 };

export function permits(policy: Policy, permission: Permission): boolean {
  return RANK[permission] <= RANK[policy.allows];
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  register(tool: ToolDef): this {
    if (this.tools.has(tool.name)) throw new Error(`tool "${tool.name}" already registered`);
    if (!/^[a-z][a-z0-9_.-]*$/.test(tool.name)) throw new Error(`tool name "${tool.name}" must match [a-z][a-z0-9_.-]*`);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): ToolDef | undefined { return this.tools.get(name); }
  list(): ToolDef[] { return [...this.tools.values()]; }

  /** Execute under a policy — refusal is typed, names tool + policy. */
  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext, policy: Policy): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new PolicyRefusal(`unknown tool "${name}" — available: ${[...this.tools.keys()].join(', ')}`, name, 'read', policy.name);
    }
    if (!permits(policy, tool.permission)) {
      throw new PolicyRefusal(
        `tool "${name}" requires ${tool.permission} permission; session policy is "${policy.name}" (allows ${policy.allows})`,
        name, tool.permission, policy.name,
      );
    }
    return tool.execute(args, ctx);
  }

  /** Provider-facing tool definitions (JSON schemas) filtered by policy. */
  providerTools(policy: Policy): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown>; permission?: Permission } }> {
    return this.list().filter((t) => permits(policy, t.permission)).map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: `${t.description} [${t.permission}]`, parameters: t.parameters },
    }));
  }

  /** Orchestration extension point (D16 — machinery NOT built; see ROADMAP):
   *  a future `spawn` tool constructs a child loop with its own budget. The
   *  signature below is the intended shape; do not implement ahead of the
   *  ROADMAP trigger. */
  // registerSpawnTool(def: { childSystemPrompt: (goal: string) => string; childBudget: Partial<LoopBudget> }): void
}
