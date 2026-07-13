import type { StateDiff } from '../../memory/browser-state.js';

export function diffAttention(diff: StateDiff): { text: string; hasChanges: boolean } {
  if (diff.fields.length === 0) return { text: '', hasChanges: false };
  const lines: string[] = ['--- CHANGES ---'];
  if (diff.network.requestsDelta !== 0) lines.push(`Network requests: ${diff.network.requestsDelta > 0 ? '+' : ''}${diff.network.requestsDelta}`);
  if (diff.network.newFailed > 0) lines.push(`New failures: ${diff.network.newFailed}`);
  if (diff.console.errorsDelta > 0) lines.push(`New errors: +${diff.console.errorsDelta}`);
  if (diff.performance.heapDeltaMB !== 0) lines.push(`Heap: ${diff.performance.heapDeltaMB > 0 ? '+' : ''}${diff.performance.heapDeltaMB}MB`);
  if (diff.security.stateChanged) lines.push(`Security: ${diff.security.oldState} → ${diff.security.newState}`);
  if (diff.dom.pageTypeChanged) lines.push(`Page changed: ${diff.dom.oldPageType} → ${diff.dom.newPageType}`);
  return { text: lines.join('\n'), hasChanges: true };
}
