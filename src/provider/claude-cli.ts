/** P1 C4 — claude-cli executor adapter: runs `claude -p --bare` as a Butler
 *  Provider. Butler's permission gate stays UPSTREAM (registry + policy);
 *  the subprocess runs with --permission-prompts none so nothing waits on a
 *  human, and --allowedTools derived from the policy class as defense in
 *  depth. Session continuity via --resume (Claude Code session ids).
 *
 *  Flags (verified against code.claude.com headless docs, 2026-10-10):
 *    -p --bare              one-shot, no host context (hooks/skills/CLAUDE.md)
 *    --output-format stream-json  newline-delimited JSON events on stdout
 *    --resume <sessionId>   continue a prior session (empty here = fresh)
 *    --allowedTools …       tool allowlist
 *    --permission-prompts none   never block on permission
 *  Shutdown discipline: SIGINT ends the in-flight turn cleanly; SIGTERM is
 *  the hard fallback after a grace period (a SIGTERM'd turn is LOST). */

import { spawn, type ChildProcess } from 'node:child_process';
import { ProviderError } from './types.ts';
import type { Provider, ProviderConfig, ProviderMessage, ProviderResponse, ProviderTool } from './types.ts';
import type { ExecutorConfig } from '../profile/profile.ts';

export interface ClaudeCliEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  tool_use_id?: string;
  message?: { content?: Array<{ type: string; text?: string }> };
  error?: string;
}

export class ClaudeCliProvider implements Provider {
  readonly model: string;
  private sessionId: string | null = null;
  private child: ChildProcess | null = null;

  constructor(private cfg: ProviderConfig & { binPath?: string; policyClass?: 'read' | 'draft' | 'act' }) {
    this.model = cfg.model || 'claude-cli';
  }

  /** map policy → claude tool allowlist (defense in depth; the registry is the real gate) */
  private allowedTools(): string[] {
    switch (this.cfg.policyClass ?? 'read') {
      case 'read': return ['Read', 'Grep', 'Glob', 'LS'];
      case 'draft': return ['Read', 'Grep', 'Glob', 'LS', 'Edit', 'Write', 'NotebookEdit'];
      case 'act': return ['Read', 'Grep', 'Glob', 'LS', 'Edit', 'Write', 'NotebookEdit', 'Bash'];
      default: return ['Read'];
    }
  }

  async complete(
    messages: ProviderMessage[],
    _tools: ProviderTool[],
    opts: { remainingMs: number; signal?: AbortSignal | undefined },
  ): Promise<ProviderResponse> {
    const bin = (this.cfg as { binPath?: string }).binPath ?? 'claude';
    const args: string[] = ['-p', '--bare',
      '--output-format', 'stream-json',
      '--permission-prompts', 'none',
      '--allowedTools', ...this.allowedTools(),
    ];
    if (this.sessionId) args.push('--resume', this.sessionId);

    // conversation → a single prompt (claude -p is turn-based; the system
    // role rides --append-system-prompt to keep it out of the user turn)
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content ?? '').join('\n');
    if (system) args.push('--append-system-prompt', system);
    const userTurn = [...messages].reverse().find((m) => m.role === 'user');
    const prompt = userTurn?.content ?? '';

    return new Promise<ProviderResponse>((resolve, reject) => {
      const child = spawn(bin, [...args, prompt], { stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      let stdout = '';
      let stderr = '';
      const events: ClaudeCliEvent[] = [];
      let settled = false;

      const shutdown = (why: string): void => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGINT');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 2_000);
        void why;
      };
      const timer = setTimeout(() => shutdown('timeout'), Math.min(this.cfg.timeoutMs ?? 120_000, Math.max(1, opts.remainingMs)));

      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', (err) => {
        if (settled) return; settled = true;
        clearTimeout(timer);
        reject(new ProviderError(`claude-cli spawn failed: ${err.message}`, 'PROVIDER_UNAVAILABLE'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (settled) return; settled = true;
        for (const line of stdout.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          try { events.push(JSON.parse(t) as ClaudeCliEvent); } catch { /* partial line at kill */ }
        }
        const init = events.find((e) => e.type === 'system' && e.session_id);
        if (init?.session_id) this.sessionId = init.session_id;
        const result = events.find((e) => e.type === 'result');
        if (code !== 0 && !result) {
          reject(new ProviderError(`claude-cli exited ${code}: ${stderr.slice(0, 300)}`, 'PROVIDER_UNAVAILABLE', code ?? undefined, true));
          return;
        }
        if (!result) {
          reject(new ProviderError(`claude-cli produced no result event (exit ${code})`, 'PROVIDER_UNAVAILABLE', code ?? undefined, false));
          return;
        }
        if (result.error?.includes('session')) {
          this.sessionId = null;
          reject(new ProviderError(`claude-cli session lost: ${result.error}`, 'PROVIDER_BAD_REQUEST', undefined, true));
          return;
        }
        const text = result.result ?? '';
        resolve({
          message: { role: 'assistant', content: text || null },
          usage: null,
          finishReason: 'stop',
        });
      });

      opts.signal?.addEventListener('abort', () => shutdown('abort'), { once: true });
    });
  }

  /** last claude session id (for --resume continuity) */
  get claudeSessionId(): string | null { return this.sessionId; }

  async close(): Promise<void> {
    if (this.child && this.child.exitCode === null) {
      this.child.kill('SIGINT');
      await new Promise((r) => setTimeout(r, 100));
      try { this.child.kill('SIGKILL'); } catch { /* gone */ }
    }
  }
}

export function claudeCliProvider(cfg: ExecutorConfig & { binPath?: string; policyClass?: 'read' | 'draft' | 'act' }): Provider {
  return new ClaudeCliProvider(cfg);
}
