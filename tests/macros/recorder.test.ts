import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';
import { MacroRunner } from '../../src/macros/runner.js';
import { MacroRecorder, generateMacroSource, MACRO_RECORD_EXCLUDED_TOOLS } from '../../src/macros/recorder.js';
import { REDACTED_VALUE } from '../../src/vision/redaction.js';
import {
  isFeatureEnabled,
  clearKillSwitchCache,
  MACRO_RECORD_KILL_SWITCH_KEY,
} from '../../src/arsenal/kill-switch.js';

function makeMockHost() {
  return {
    observe: vi.fn(async () => '{}'),
    act: vi.fn(async () => '{}'),
    inspect: vi.fn(async () => '{}'),
    diff: vi.fn(async () => '{}'),
    reattach: vi.fn(async () => {}),
    callTool: vi.fn(async (name: string) => JSON.stringify({ ok: true, tool: name })),
  };
}

describe('MacroRecorder recording', () => {
  let runner: MacroRunner;
  let recorder: MacroRecorder;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yautja-macrorec-'));
    process.env.YAUTJA_USER_DIR = dir;
    runner = new MacroRunner(makeMockHost());
    recorder = new MacroRecorder(runner);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.YAUTJA_USER_DIR;
  });

  it('records steps with sanitized args while active', () => {
    recorder.start();
    recorder.recordStep('act', { action: { type: 'navigate', url: 'https://x.dev' } }, true);
    recorder.recordStep('smartType', { query: 'user', text: 'y'.repeat(300), password: 's3cr3t' }, true);
    expect(recorder.stepCount).toBe(2);
    expect(recorder.active).toBe(true);
  });

  it('is a no-op when not recording', () => {
    recorder.recordStep('act', {}, true);
    expect(recorder.stepCount).toBe(0);
  });

  it('never records gate/plan tools nor the recorder tools themselves', () => {
    recorder.start();
    for (const tool of ['gateGrant', 'gateRevoke', 'plan_propose', 'plan_approve', 'macro_record', 'macro_run', 'macro_register', 'macro_delete', 'session_record']) {
      recorder.recordStep(tool, {}, true);
    }
    expect(recorder.stepCount).toBe(0);
    recorder.recordStep('act', { action: { type: 'click', selector: '#a' } }, true);
    expect(recorder.stepCount).toBe(1);
  });

  it('cancel discards the recording', () => {
    recorder.start();
    recorder.recordStep('act', {}, true);
    recorder.cancel();
    expect(recorder.active).toBe(false);
    expect(recorder.stepCount).toBe(0);
  });

  it('stop without recording or without steps fails at validation', async () => {
    const noRec = await recorder.stop({ name: 'demo' });
    expect(noRec.success).toBe(false);
    if (!noRec.success) expect(noRec.stage).toBe('validation');

    recorder.start();
    const noSteps = await recorder.stop({ name: 'demo' });
    expect(noSteps.success).toBe(false);
    if (!noSteps.success) expect(noSteps.stage).toBe('validation');
    expect(recorder.active).toBe(false); // la grabación vacía se descarta
  });

  it('stop generates a valid macro, registers it and clears the recording', async () => {
    recorder.start();
    recorder.recordStep('act', { action: { type: 'navigate', url: 'https://x.dev' } }, true);
    recorder.recordStep('act', { action: { type: 'type', selector: 'input[name=password]', text: 's3cr3t' } }, true);
    const r = await recorder.stop({ name: 'login-flow', description: 'login grabado' });
    expect(r.success).toBe(true);
    expect(recorder.active).toBe(false);
    if (r.success) {
      const source = fs.readFileSync(r.file, 'utf8');
      expect(source).toContain('const steps =');
      expect(source).toContain('ctx.callTool(step.tool, step.args)');
      // pasos sanitizados: password redactado en el fuente
      expect(source).not.toContain('s3cr3t');
      expect(source).toContain(REDACTED_VALUE);
    }
    const entry = runner.get('login-flow');
    expect(entry?.def.description).toBe('login grabado');
  });

  it('respects the overwrite flag against existing macros', async () => {
    recorder.start();
    recorder.recordStep('act', { action: { type: 'reload' } }, true);
    const first = await recorder.stop({ name: 'demo-flow' });
    expect(first.success).toBe(true);

    recorder.start();
    recorder.recordStep('act', { action: { type: 'reload' } }, true);
    const dup = await recorder.stop({ name: 'demo-flow' });
    expect(dup.success).toBe(false);

    recorder.start();
    recorder.recordStep('act', { action: { type: 'reload' } }, true);
    const ow = await recorder.stop({ name: 'demo-flow', overwrite: true });
    expect(ow.success).toBe(true);
  });

  it('rejects names that are not filename-safe', async () => {
    recorder.start();
    recorder.recordStep('act', { action: { type: 'reload' } }, true);
    const r = await recorder.stop({ name: 'Bad Name!' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.stage).toBe('validation');
  });

  it('the recorded macro replays its steps through ctx.callTool in order', async () => {
    const host = makeMockHost();
    runner = new MacroRunner(host);
    recorder = new MacroRecorder(runner);

    recorder.start();
    recorder.recordStep('act', { action: { type: 'navigate', url: 'https://x.dev' } }, true);
    recorder.recordStep('smartType', { query: 'q', text: 'hello' }, true);
    recorder.recordStep('act', { action: { type: 'click', selector: '#go' } }, false);
    const reg = await recorder.stop({ name: 'replay-me' });
    expect(reg.success).toBe(true);

    const run = await runner.run('replay-me');
    expect(run.success).toBe(true);
    expect(host.callTool).toHaveBeenCalledTimes(3);
    expect(host.callTool.mock.calls.map((c) => c[0])).toEqual(['act', 'smartType', 'act']);
    // los pasos fallidos también se rejecutan (el ok queda como dato del paso)
    const results = (run as any).result as Array<{ tool: string; result: string }>;
    expect(results).toHaveLength(3);
    expect(JSON.parse(results[0].result)).toMatchObject({ ok: true, tool: 'act' });
  });
});

describe('generateMacroSource', () => {
  it('produces an evaluable ESM module exporting name/description/run', async () => {
    const source = generateMacroSource('gen-test', 'generated', [
      { tool: 'act', args: { action: { type: 'reload' } }, ok: true },
    ]);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yautja-gensrc-')), 'gen-test.js');
    fs.writeFileSync(file, source, 'utf8');
    const mod = await import(`${pathToFileURL(file).href}?v=${Date.now()}`);
    expect(mod.default.name).toBe('gen-test');
    expect(mod.default.description).toBe('generated');
    expect(typeof mod.default.run).toBe('function');
  });

  it('documents that grants are never replay-automated', () => {
    const source = generateMacroSource('doc-check', 'd', []);
    expect(source).toContain('grants are not replay-automatable');
  });
});

describe('yjMacroRecord kill switch', () => {
  beforeEach(() => clearKillSwitchCache());

  it('is enabled by default and disabled by an explicit false', async () => {
    expect(await isFeatureEnabled({ storageGet: async () => undefined }, MACRO_RECORD_KILL_SWITCH_KEY)).toBe(true);
    clearKillSwitchCache();
    expect(await isFeatureEnabled({ storageGet: async () => false }, MACRO_RECORD_KILL_SWITCH_KEY)).toBe(false);
  });

  it('exclusion set covers gates and plan tools', () => {
    expect(MACRO_RECORD_EXCLUDED_TOOLS.has('gateGrant')).toBe(true);
    expect(MACRO_RECORD_EXCLUDED_TOOLS.has('plan_approve')).toBe(true);
    expect(MACRO_RECORD_EXCLUDED_TOOLS.has('act')).toBe(false);
  });
});
