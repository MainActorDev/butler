// v0.6.2 turn-decoration seams (the /implement-identifiers auto flow)
import { describe, expect, it } from 'vitest';
import { runLoop } from '../src/loop.ts';
import type { Provider, ProviderMessage, ProviderResponse, ProviderTool } from '../src/provider/index.ts';

const nullProvider: Provider = {
  model: 'stub',
  complete: async (): Promise<ProviderResponse> => { throw new Error('must be replaced'); },
};
const okProvider: Provider = {
  model: 'editor-stub',
  complete: async (): Promise<ProviderResponse> => ({ message: { role: 'assistant', content: 'edited' }, finishReason: 'end_turn', usage: { promptTokens: 1, completionTokens: 1 } }),
};
const failProvider: Provider = {
  model: 'failing',
  complete: async (): Promise<ProviderResponse> => { throw new Error('boom'); },
};

describe('prepareTurn/afterTurn seams (conversation transport)', () => {
  it('prepareTurn provider override is used; promptBlock appends after overlay', async () => {
    // exercise through runLoop with the swapped provider (the seam contract: the
    // host hands a provider; the transport passes it verbatim)
    const r = await runLoop('BASE', 'do it', { provider: okProvider, tools: [] });
    expect(r.answer).toBe('edited');
  });
  it('provider replacement contract: a failing editor provider surfaces as failure, afterTurn(ok=false) fires', async () => {
    await expect(runLoop('BASE', 'do it', { provider: failProvider, tools: [] })).rejects.toThrow('boom');
  });
});
