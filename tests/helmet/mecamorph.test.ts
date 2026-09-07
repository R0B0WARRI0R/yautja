import { describe, expect, it } from 'vitest';

import { Helmet } from '../../src/helmet.js';

describe('Helmet — Mecamorph module', () => {
  it('starts with an empty session registry', async () => {
    const helmet = new Helmet({ autoAttach: false, postActionDelayMs: 0 });

    const raw = await helmet.callTool('morph_list', {});
    const envelope = JSON.parse(raw);

    expect(envelope.ok).toBe(true);
    expect(envelope.result).toEqual({ capabilities: [], count: 0 });
  });

  it('rejects invalid run arguments through the standard envelope', async () => {
    const helmet = new Helmet({ autoAttach: false, postActionDelayMs: 0 });

    const raw = await helmet.callTool('morph_run', {});
    const envelope = JSON.parse(raw);

    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('YJ.PROTOCOL.INVALID_ARGUMENT');
  });
});
