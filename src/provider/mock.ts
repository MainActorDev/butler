/** Deterministic mock provider — hermetic tests + demo drills without a live
 *  endpoint (plan Stage 1: scripted turns; supports hang simulation for the
 *  PROVIDER_TIMEOUT case). */
import type { Provider, ProviderMessage, ProviderResponse, ProviderTool } from './types.ts';
import { ProviderError } from './types.ts';

export type ScriptedTurn =
  | { kind: 'assistant'; content: string | null; toolCalls?: ProviderMessage['tool_calls']; usage?: { promptTokens: number; completionTokens: number } }
  | { kind: 'error'; error: ProviderError }
  | { kind: 'hang'; ms?: number };

export class MockProvider implements Provider {
  readonly model = 'mock-model';
  private calls = 0;
  constructor(private script: ScriptedTurn[]) {}

  get callCount(): number { return this.calls; }

  async complete(
    _messages: ProviderMessage[],
    _tools: ProviderTool[],
    opts: { remainingMs: number; signal?: AbortSignal },
  ): Promise<ProviderResponse> {
    this.calls += 1;
    const turn = this.script[Math.min(this.calls - 1, this.script.length - 1)] ?? { kind: 'assistant' as const, content: '' };
    if (turn.kind === 'error') throw turn.error;
    if (turn.kind === 'hang') {
      // simulate a hung socket: sleep past every deadline; respect abort
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, turn.ms ?? 60_000);
        opts.signal?.addEventListener('abort', () => { clearTimeout(t); reject(opts.signal!.reason); }, { once: true });
      });
      throw new ProviderError('mock hang completed unexpectedly', 'PROVIDER_TIMEOUT');
    }
    return {
      message: { role: 'assistant', content: turn.content, ...(turn.toolCalls ? { tool_calls: turn.toolCalls } : {}) },
      finishReason: turn.toolCalls ? 'tool_calls' : 'stop',
      usage: turn.usage ?? { promptTokens: 10, completionTokens: 5 },
    };
  }
}
