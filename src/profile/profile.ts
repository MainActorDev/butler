/** P1 C1 — Agent profiles: named, deployable agent units.
 *  A profile bundles everything a stage/agent needs: system prompt, tool
 *  subset, permission policy, provider (executor kind + config), budgets,
 *  and memory scopes (which note scopes ride the system prompt).
 *  Consumers (Lionidas) define profiles; resolveProfile wires the runtime. */

import type { Provider, ProviderConfig } from '../provider/types.ts';
import type { LoopBudget } from '../loop.ts';
import type { Permission, ToolRegistry } from '../tools.ts';
import type { Storage, NoteRow } from '../memory/contract.ts';
import { OpenAICompatProvider } from '../provider/openai-compat.ts';
import { MockProvider, type ScriptedTurn } from '../provider/mock.ts';

/** executor kind — claude-cli rides the P1 C4 adapter; openai-compat and mock exist today */
export type ExecutorKind = 'openai-compat' | 'claude-cli' | 'mock';

export interface ExecutorConfig extends ProviderConfig {
  kind: ExecutorKind;
  /** mock executor: the scripted turns to replay (hermetic tests) */
  mockScript?: ScriptedTurn[];
  /** claude-cli executor: path to the binary (default: 'claude' on PATH) */
  binPath?: string;
  /** claude-cli executor: policy class → --allowedTools mapping */
  policyClass?: 'read' | 'draft' | 'act';
}

export interface AgentProfile {
  id: string;
  systemPrompt: string;
  /** tool names allowed for this agent — '*' = everything the registry permits */
  tools: string[] | '*';
  policy: Permission;
  provider: ExecutorConfig;
  budgets?: Partial<LoopBudget>;
  /** D6a: note scope prefixes injected into the system prompt ('app:com.foo/*') */
  memoryScopes?: string[];
}

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

/** The runtime a resolved profile produces — what a stage actually runs with. */
export interface ResolvedProfile {
  systemPrompt: string;        // base prompt + scope-filtered notes block
  tools: string[];             // concrete tool names (subset of registry)
  policy: Permission;
  provider: Provider;
  budgets?: Partial<LoopBudget>;
  profile: AgentProfile;
}

/** scope-prefix match: 'app:a/*' matches 'app:a/x' but not 'app:b/x'; exact match also allowed */
export function scopeMatches(scopeKey: string, pattern: string): boolean {
  if (pattern.endsWith('/*')) {
    const base = pattern.slice(0, -2);
    return scopeKey === base || scopeKey.startsWith(`${base}/`);
  }
  return scopeKey === pattern;
}

/** D6a: assemble the notes block for the profile's declared scopes ONLY.
 *  Unscoped profiles (undefined) get NO notes block — knowledge must be
 *  declared, never ambient. */
export function notesBlockFor(notes: NoteRow[], scopes: string[] | undefined): string {
  if (!scopes || scopes.length === 0) return '';
  const inScope = notes.filter((n) => scopes.some((p) => scopeMatches(n.scope_key, p)));
  if (!inScope.length) return '';
  const lines = inScope.slice(0, 20).map((n) => {
    const reason = n.superseded_reason ? ` (superseded: ${n.superseded_reason})` : '';
    return `- [${n.kind} ${n.scope_key}] ${n.content} (source: ${n.source_ref}${reason})`;
  });
  return `\n\n## Known notes (provenance-stamped memory)\n${lines.join('\n')}`;
}

/** Build a Provider from an executor config. claude-cli is loaded lazily so
 *  consumers that never use it never import the adapter (and its binary). */
export async function providerFromConfig(cfg: ExecutorConfig): Promise<Provider> {
  switch (cfg.kind) {
    case 'openai-compat': return new OpenAICompatProvider(cfg);
    case 'mock': return new MockProvider(cfg.mockScript ?? [{ kind: 'assistant', content: '(mock executor: no script)' }]);
    case 'claude-cli': {
      const { claudeCliProvider } = await import('../provider/claude-cli.ts');
      return claudeCliProvider(cfg);
    }
    default: throw new ProfileError(`unknown executor kind: ${(cfg as { kind: string }).kind}`);
  }
}

/** Resolve a profile against a registry + storage: filtered tools, pinned
 *  policy, constructed provider, system prompt with scope-filtered notes. */
export async function resolveProfile(
  profile: AgentProfile,
  deps: { registry: ToolRegistry; storage: Storage },
): Promise<ResolvedProfile> {
  // tool subset must exist in the registry (typo guard — fail at resolve, not mid-run)
  if (profile.tools !== '*') {
    const known = new Set(deps.registry.list().map((t) => t.name));
    const unknown = profile.tools.filter((t) => !known.has(t));
    if (unknown.length) throw new ProfileError(`profile '${profile.id}' references unknown tools: ${unknown.join(', ')}`);
  }
  // policy must be a real permission class
  if (!['read', 'draft', 'act'].includes(profile.policy)) {
    throw new ProfileError(`profile '${profile.id}' has invalid policy '${profile.policy}'`);
  }
  const tools = profile.tools === '*'
    ? deps.registry.list().map((t) => t.name)
    : [...profile.tools];
  const provider = await providerFromConfig(profile.provider);
  const notes = await deps.storage.activeNotes();
  const notesBlock = notesBlockFor(notes, profile.memoryScopes);
  return {
    systemPrompt: profile.systemPrompt + notesBlock,
    tools,
    policy: profile.policy,
    provider,
    ...(profile.budgets ? { budgets: profile.budgets } : {}),
    profile,
  };
}
