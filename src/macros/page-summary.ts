// src/macros/page-summary.ts
import type { MacroDef } from './types.js';

export default {
  name: 'page-summary',
  description: 'Capture a focused page summary via observe("summary").',
  timeoutMs: 15_000,
  async run(_args, ctx) {
    ctx.log('gathering observation');
    const observation = await ctx.observe('summary');
    return { observation };
  },
} satisfies MacroDef;
