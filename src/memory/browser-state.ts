import type { NetworkSummary } from '../vision/thermal.js';
import type { DOMSummary } from '../vision/em.js';
import type { ConsoleSummary } from '../vision/audio.js';
import type { PerformanceSummary } from '../vision/motion.js';
import type { SecuritySummary } from '../vision/threat.js';
import { RollingBuffer } from './rolling-buffer.js';

export interface BrowserState {
  url: string;
  title: string;
  readyState: 'loading' | 'interactive' | 'complete';
  timestamp: number;
  network: NetworkSummary;
  dom: DOMSummary;
  console: ConsoleSummary;
  performance: PerformanceSummary;
  security: SecuritySummary;
}

export interface StateDiff {
  fields: string[];
  network: {
    requestsDelta: number;
    completedDelta: number;
    failedDelta: number;
    newSlow: number;
    newFailed: number;
  };
  console: {
    errorsDelta: number;
    warningsDelta: number;
  };
  performance: {
    heapDeltaMB: number;
    domNodesDelta: number;
  };
  security: {
    threatsDelta: number;
    stateChanged: boolean;
    oldState?: string;
    newState?: string;
  };
  dom: {
    pageTypeChanged: boolean;
    oldPageType?: string;
    newPageType?: string;
    interactiveElementsDelta: number;
  };
}

export class WorkingMemory {
  private current: BrowserState | null = null;
  private history: RollingBuffer<BrowserState>;

  constructor(maxSnapshots = 10) {
    this.history = new RollingBuffer(maxSnapshots);
  }

  update(state: BrowserState): void {
    if (this.current) {
      this.history.push(this.current);
    }
    this.current = state;
  }

  snapshot(): BrowserState | null {
    return this.current;
  }

  getHistory(): BrowserState[] {
    return this.history.toArray();
  }

  diff(before?: BrowserState, after?: BrowserState): StateDiff | null {
    const a = before ?? this.history.last() ?? null;
    const b = after ?? this.current;
    if (!a || !b) return null;
    return computeDiff(a, b);
  }

  clear(): void {
    this.current = null;
    this.history.clear();
  }

  get size(): number {
    return (this.current ? 1 : 0) + this.history.length;
  }
}

export function computeDiff(before: BrowserState, after: BrowserState): StateDiff {
  const fields: string[] = [];

  if (before.url !== after.url) fields.push('url');
  if (before.title !== after.title) fields.push('title');
  if (before.readyState !== after.readyState) fields.push('readyState');

  const requestsDelta = after.network.total - before.network.total;
  const completedDelta = after.network.completed - before.network.completed;
  const failedDelta = after.network.failed - before.network.failed;
  const newSlow = Math.max(0, after.network.slow.length - before.network.slow.length);
  const newFailed = Math.max(
    0,
    after.network.failedRequests.length - before.network.failedRequests.length,
  );

  if (requestsDelta !== 0) fields.push('network.total');
  if (completedDelta !== 0) fields.push('network.completed');
  if (failedDelta !== 0) fields.push('network.failed');

  const errorsDelta = after.console.errors.length - before.console.errors.length;
  const warningsDelta = after.console.warnings.length - before.console.warnings.length;
  if (errorsDelta !== 0) fields.push('console.errors');
  if (warningsDelta !== 0) fields.push('console.warnings');

  const heapDeltaMB =
    Math.round((after.performance.jsHeapUsedMB - before.performance.jsHeapUsedMB) * 10) / 10;
  const domNodesDelta = after.performance.domNodes - before.performance.domNodes;
  if (heapDeltaMB !== 0) fields.push('performance.heap');
  if (domNodesDelta !== 0) fields.push('performance.domNodes');

  const threatsDelta = after.security.totalThreats - before.security.totalThreats;
  const stateChanged = before.security.state !== after.security.state;
  if (threatsDelta !== 0) fields.push('security.threats');
  if (stateChanged) fields.push('security.state');

  const pageTypeChanged = before.dom.semantic.pageType !== after.dom.semantic.pageType;
  const interactiveElementsDelta = after.dom.interactive.total - before.dom.interactive.total;
  if (pageTypeChanged) fields.push('dom.pageType');
  if (interactiveElementsDelta !== 0) fields.push('dom.interactive');

  return {
    fields,
    network: { requestsDelta, completedDelta, failedDelta, newSlow, newFailed },
    console: { errorsDelta, warningsDelta },
    performance: { heapDeltaMB, domNodesDelta },
    security: {
      threatsDelta,
      stateChanged,
      oldState: stateChanged ? before.security.state : undefined,
      newState: stateChanged ? after.security.state : undefined,
    },
    dom: {
      pageTypeChanged,
      oldPageType: pageTypeChanged ? before.dom.semantic.pageType : undefined,
      newPageType: pageTypeChanged ? after.dom.semantic.pageType : undefined,
      interactiveElementsDelta,
    },
  };
}
