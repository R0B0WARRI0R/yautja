import type { BrowserState } from '../../memory/browser-state.js';

export function overviewAttention(state: BrowserState): string {
  const lines: string[] = ['--- OVERVIEW ---'];
  lines.push(`${state.dom.semantic.pageType} | ${state.url}`);
  lines.push(`Network: ${state.network.total} req (${state.network.failed} failed) | Console: ${state.console.errors.length} err | Heap: ${state.performance.jsHeapUsedMB}MB | Security: ${state.security.state}`);
  lines.push(`Interactive: ${state.dom.interactive.total} elements (${state.dom.interactive.buttons.length} buttons)`);
  return lines.join('\n');
}
