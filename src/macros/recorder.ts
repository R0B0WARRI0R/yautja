/**
 * Workflows grabables → macros (T13 — RE de Claude in Chrome, shortcuts).
 *
 * Durante la grabación, las tool calls MCP (act, observe, smartType...) se
 * registran como pasos `{tool, args, ok}` con args sanitizados (redacción
 * de valores sensibles y truncado a 200 chars, misma sanitizer que el
 * session recorder). En `stop` se genera el fuente JS de una macro
 * compatible con el sistema de src/macros/ (export default { name,
 * description, run }) y se registra vía MacroRunner.registerUserMacro.
 *
 * Seguridad: gateGrant/gateRevoke/plan_propose/plan_approve NUNCA se
 * graban — los grants no se replay-automatizan (requieren al humano).
 */

import type { MacroRunner } from './runner.js';
import type { RegisterResult } from './types.js';
import { sanitizeRecordedValue } from '../intel/session-recorder.js';

/**
 * Tools excluidas de la grabación: gates y planes (nunca se automatiza un
 * grant) y las propias tools de macros/grabación (evitan recursión al
 * grabar o al rejecutar).
 */
export const MACRO_RECORD_EXCLUDED_TOOLS = new Set([
  'gateGrant',
  'gateRevoke',
  'plan_propose',
  'plan_approve',
  'macro_record',
  'macro_run',
  'macro_register',
  'macro_delete',
  'session_record',
]);

export interface RecordedStep {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
}

/**
 * Genera el fuente JS (ESM) de una macro grabada: un array de pasos +
 * bucle que los re-ejecuta secuencialmente invocando las mismas tools por
 * la vía interna (ctx.callTool → Helmet.handleToolCall).
 */
export function generateMacroSource(name: string, description: string, steps: RecordedStep[]): string {
  return [
    `// Recorded by Yautja macro_record — ${steps.length} step(s).`,
    `// Security: gate/plan tools are never recorded — grants are not replay-automatable.`,
    `const steps = ${JSON.stringify(steps, null, 2)};`,
    ``,
    `export default {`,
    `  name: ${JSON.stringify(name)},`,
    `  description: ${JSON.stringify(description)},`,
    `  async run(_args, ctx) {`,
    `    const results = [];`,
    `    for (const step of steps) {`,
    `      ctx.log('▶ ' + step.tool);`,
    `      const result = await ctx.callTool(step.tool, step.args);`,
    `      results.push({ tool: step.tool, result });`,
    `    }`,
    `    return results;`,
    `  },`,
    `};`,
    ``,
  ].join('\n');
}

export class MacroRecorder {
  private recording: { startedAt: number; steps: RecordedStep[] } | null = null;

  constructor(private readonly runner: MacroRunner) {}

  get active(): boolean {
    return this.recording !== null;
  }

  get stepCount(): number {
    return this.recording?.steps.length ?? 0;
  }

  start(): void {
    this.recording = { startedAt: Date.now(), steps: [] };
  }

  /** Registra un paso. No-op si no hay grabación activa o la tool está excluida. */
  recordStep(tool: string, args: unknown, ok: boolean): void {
    if (!this.recording) return;
    if (MACRO_RECORD_EXCLUDED_TOOLS.has(tool)) return;
    this.recording.steps.push({
      tool,
      args: (sanitizeRecordedValue(args ?? {}) ?? {}) as Record<string, unknown>,
      ok,
    });
  }

  cancel(): void {
    this.recording = null;
  }

  /**
   * Detiene la grabación, genera el fuente de la macro y la registra con
   * el MacroRunner (overwrite explícito). La grabación solo se descarta si
   * el registro tiene éxito (o si no hay pasos).
   */
  async stop(opts: { name: string; description?: string; overwrite?: boolean }): Promise<RegisterResult> {
    const rec = this.recording;
    if (!rec) {
      return { success: false, error: 'no active macro recording (call macro_record start first)', stage: 'validation' };
    }
    if (rec.steps.length === 0) {
      this.recording = null;
      return { success: false, error: 'recording has no steps — nothing to compile', stage: 'validation' };
    }
    const source = generateMacroSource(
      opts.name,
      opts.description ?? `Recorded flow (${rec.steps.length} steps)`,
      rec.steps,
    );
    const result = await this.runner.registerUserMacro(opts.name, source, opts.overwrite === true);
    if (result.success) this.recording = null;
    return result;
  }
}
