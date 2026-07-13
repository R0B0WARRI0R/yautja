import type { BrowserState, StateDiff } from '../memory/browser-state.js';
import type { SensorDomain } from './relevance.js';
import { selectDomains, scoreDomain } from './relevance.js';
import type { Anomaly } from '../vision/base-sensor.js';

export type ObservationKind = 'overview' | 'domain_focused' | 'diff' | 'anomaly' | 'composite';

export interface Observation {
  kind: ObservationKind;
  domains: SensorDomain[];
  text: string;
  tokenEstimate: number;
  timestamp: number;
}

export interface ObservationSpec {
  question: string;
  state: BrowserState;
  diff?: StateDiff | null;
  anomalies?: Anomaly[];
  maxTokens?: number;
}

const CHARS_PER_TOKEN = 4;
const RESERVE_FOR_ACTIONS = 500;
const MIN_SECTION_TOKENS = 100;

export function buildObservation(spec: ObservationSpec): Observation {
  const maxTokens = spec.maxTokens ?? 8000;
  const lines: string[] = [];
  let usedTokens = 0;

  const header = `[BROWSER STATE @ ${new Date(spec.state.timestamp).toISOString()}]\n`;
  lines.push(header);
  usedTokens += estimateTokens(header);

  if (spec.anomalies && spec.anomalies.length > 0) {
    const anomalyText = formatAnomalies(spec.anomalies);
    const cost = estimateTokens(anomalyText);
    lines.push(anomalyText);
    usedTokens += cost;
  }

  const domains = selectDomains(spec.question);
  const isOverview = domains.length === 0 || (domains.length === 5 && scoreDomain(spec.question, 'network') < 0.5);

  if (isOverview) {
    const remaining = maxTokens - usedTokens - RESERVE_FOR_ACTIONS;
    const overviewText = formatOverview(spec.state, remaining);
    lines.push(overviewText);
    usedTokens += estimateTokens(overviewText);
    return {
      kind: 'overview',
      domains: ['network', 'dom', 'console', 'performance', 'security'],
      text: lines.join('\n'),
      tokenEstimate: usedTokens,
      timestamp: Date.now(),
    };
  }

  for (const domain of domains) {
    const remaining = maxTokens - usedTokens - RESERVE_FOR_ACTIONS;
    if (remaining < MIN_SECTION_TOKENS) {
      lines.push(`  (... more data available, use inspect('${domain}') for detail)`);
      break;
    }
    const domainText = formatDomain(domain, spec.state, remaining);
    const cost = estimateTokens(domainText);
    lines.push(domainText);
    usedTokens += cost;
  }

  if (spec.diff && usedTokens < maxTokens * 0.8 && spec.diff.fields.length > 0) {
    const diffText = formatDiff(spec.diff);
    lines.push(diffText);
    usedTokens += estimateTokens(diffText);
  }

  return {
    kind: spec.anomalies && spec.anomalies.length > 0 && domains.length > 0 ? 'composite' : 'domain_focused',
    domains,
    text: lines.join('\n'),
    tokenEstimate: usedTokens,
    timestamp: Date.now(),
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function formatAnomalies(anomalies: Anomaly[]): string {
  const lines: string[] = ['⚠ ANOMALIES:'];
  for (const a of anomalies.slice(0, 10)) {
    const icon = a.severity === 'critical' ? '[!]' : a.severity === 'warning' ? '[~]' : '[i]';
    lines.push(`${icon} ${a.domain}: ${a.message}`);
  }
  return lines.join('\n') + '\n';
}

function formatOverview(state: BrowserState, _budget: number): string {
  const lines: string[] = [];
  lines.push(`URL: ${state.url}`);
  lines.push(`Title: ${state.title}`);
  lines.push(`Page type: ${state.dom.semantic.pageType}`);
  lines.push('');
  lines.push(`Network: ${state.network.total} requests (${state.network.completed} ok, ${state.network.failed} failed)`);
  if (state.network.slow.length > 0) lines.push(`  Slow: ${state.network.slow.length} requests`);
  lines.push(`Console: ${state.console.errors.length} errors, ${state.console.warnings.length} warnings`);
  lines.push(`Performance: ${state.performance.jsHeapUsedMB}MB heap, ${state.performance.domNodes} DOM nodes`);
  lines.push(`Security: ${state.security.state} (${state.security.totalThreats} threats)`);
  lines.push(`Interactive: ${state.dom.interactive.total} elements (${state.dom.interactive.buttons.length} buttons)`);
  return lines.join('\n');
}

export function formatDomain(domain: SensorDomain, state: BrowserState, _budget: number): string {
  const lines: string[] = [];
  const header = `\n--- ${domain.toUpperCase()} ---`;
  lines.push(header);

  switch (domain) {
    case 'network': {
      const n = state.network;
      lines.push(`Total: ${n.total} | Completed: ${n.completed} | Failed: ${n.failed} | Pending: ${n.pending}`);
      if (n.slow.length > 0) {
        lines.push('Slow:');
        for (const t of n.slow.slice(0, 5)) {
          lines.push(`  ${(t.durationMs + 'ms').padEnd(8)} ${t.request.method} ${t.request.url.substring(0, 60)}`);
        }
      }
      if (n.failedRequests.length > 0) {
        lines.push('Failed:');
        for (const t of n.failedRequests.slice(0, 5)) {
          lines.push(`  ${t.error?.errorText || '??'}  ${t.request.url.substring(0, 60)}`);
        }
      }
      break;
    }
    case 'dom': {
      const d = state.dom;
      lines.push(`Type: ${d.semantic.pageType} | Title: ${d.semantic.title}`);
      lines.push(`Interactive: ${d.interactive.total} (${d.interactive.buttons.length} buttons, ${d.interactive.links.length} links, ${d.interactive.inputs.length} inputs)`);
      if (d.interactive.buttons.length > 0) {
        lines.push('Buttons:');
        for (const b of d.interactive.buttons.slice(0, 8)) {
          if (b.visible) lines.push(`  [${b.tag}] "${b.text}" → ${b.selector.substring(0, 50)}`);
        }
      }
      break;
    }
    case 'console': {
      const c = state.console;
      lines.push(`Total: ${c.total} | Errors: ${c.errors.length} | Warnings: ${c.warnings.length}`);
      if (c.errors.length > 0) {
        lines.push('Errors:');
        for (const e of c.errors.slice(0, 5)) {
          lines.push(`  ${e.text.substring(0, 80)}${e.count > 1 ? ' (x' + e.count + ')' : ''}`);
        }
      }
      break;
    }
    case 'performance': {
      const p = state.performance;
      lines.push(`Heap: ${p.jsHeapUsedMB}MB / ${p.jsHeapTotalMB}MB (${p.jsHeapTrend})`);
      lines.push(`DOM nodes: ${p.domNodes} | Layouts: ${p.layoutCount} | Style recalc: ${p.recalcStyleCount}`);
      lines.push(`Script: ${p.scriptDurationMs}ms | Task: ${p.taskDurationMs}ms`);
      break;
    }
    case 'security': {
      const s = state.security;
      lines.push(`State: ${s.state} | Scheme: ${s.schemeIsCryptographic ? 'HTTPS' : 'HTTP'}`);
      lines.push(`Threats: ${s.totalThreats} | Mixed content: ${s.mixedContentRequests} | CSP: ${s.cspViolations} | Cert errors: ${s.certificateErrors}`);
      if (s.explanations.length > 0) {
        for (const e of s.explanations.slice(0, 3)) {
          lines.push(`  ${e.title}: ${e.summary}`);
        }
      }
      break;
    }
  }

  return lines.join('\n');
}

function formatDiff(diff: StateDiff): string {
  const lines: string[] = ['\n--- CHANGES SINCE LAST ACTION ---'];
  if (diff.network.requestsDelta !== 0) lines.push(`  Requests: ${diff.network.requestsDelta > 0 ? '+' : ''}${diff.network.requestsDelta}`);
  if (diff.network.failedDelta !== 0) lines.push(`  Failed: ${diff.network.failedDelta > 0 ? '+' : ''}${diff.network.failedDelta}`);
  if (diff.console.errorsDelta !== 0) lines.push(`  Console errors: ${diff.console.errorsDelta > 0 ? '+' : ''}${diff.console.errorsDelta}`);
  if (diff.performance.heapDeltaMB !== 0) lines.push(`  Heap: ${diff.performance.heapDeltaMB > 0 ? '+' : ''}${diff.performance.heapDeltaMB}MB`);
  if (diff.security.stateChanged) lines.push(`  Security: ${diff.security.oldState} → ${diff.security.newState}`);
  if (diff.dom.pageTypeChanged) lines.push(`  Page type: ${diff.dom.oldPageType} → ${diff.dom.newPageType}`);
  return lines.join('\n');
}
