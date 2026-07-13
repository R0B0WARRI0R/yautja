import type { Anomaly } from '../../vision/base-sensor.js';

export function anomalyAttention(anomalies: Anomaly[]): { text: string; count: number } {
  if (anomalies.length === 0) return { text: '', count: 0 };
  const lines: string[] = ['⚠ ANOMALIES DETECTED:'];
  const critical = anomalies.filter((a) => a.severity === 'critical');
  const warnings = anomalies.filter((a) => a.severity === 'warning');
  for (const a of critical.slice(0, 5)) lines.push(`[!] ${a.domain}: ${a.message}`);
  for (const a of warnings.slice(0, 5)) lines.push(`[~] ${a.domain}: ${a.message}`);
  return { text: lines.join('\n'), count: anomalies.length };
}
