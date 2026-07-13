// src/macros/page-summary.ts
import type { MacroDef } from './types.js';

export default {
  name: 'page-summary',
  description: 'Combine observe("summary") with techScan() for a quick page overview.',
  timeoutMs: 15_000,
  async run(_args, ctx) {
    ctx.log('gathering observation');
    const observation = await ctx.observe('summary');
    ctx.log('scanning tech stack');
    const tech = await ctx.techScan();
    return { observation, tech };
  },
} satisfies MacroDef;
