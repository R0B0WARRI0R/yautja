import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  SessionRecorder,
  summarizeToolEvent,
  summarizeRecording,
  sanitizeRecordedValue,
  RECORDER_EXCLUDED_TOOLS,
  RECORDED_STRING_MAX_CHARS,
} from '../../src/intel/session-recorder.js';
import { EvidenceStore } from '../../src/intel/evidence-store.js';
import { REDACTED_VALUE } from '../../src/vision/redaction.js';
import {
  isFeatureEnabled,
  clearKillSwitchCache,
  SESSION_RECORDER_KILL_SWITCH_KEY,
} from '../../src/arsenal/kill-switch.js';

describe('SessionRecorder lifecycle', () => {
  it('capture is a no-op while inactive', () => {
    const r = new SessionRecorder();
    expect(r.active).toBe(false);
    expect(r.capture('click', { tool: 'act' })).toBeNull();
    expect(r.status().events).toBe(0);
  });

  it('start → capture → stop returns the recording and deactivates', () => {
    let t = 1_000;
    const r = new SessionRecorder({ now: () => t });
    r.start();
    expect(r.active).toBe(true);
    t += 50;
    r.capture('navigate', { tool: 'act', ok: true, url: 'https://example.com' });
    t += 50;
    r.capture('click', { tool: 'act', ok: false, selector: '#btn' });
    const rec = r.stop();
    expect(r.active).toBe(false);
    expect(rec).not.toBeNull();
    expect(rec!.events).toHaveLength(2);
    expect(rec!.events[0]).toMatchObject({ event: 'navigate', ts: 1050, url: 'https://example.com', ok: true });
    expect(rec!.events[1]).toMatchObject({ event: 'click', ts: 1100, ok: false });
    expect(rec!.startedAt).toBe(1000);
    expect(rec!.stoppedAt).toBe(1100);
  });

  it('stop without a recording returns null', () => {
    expect(new SessionRecorder().stop()).toBeNull();
  });

  it('start discards previous events', () => {
    const r = new SessionRecorder();
    r.start();
    r.capture('click');
    r.start();
    expect(r.status().events).toBe(0);
  });

  it('clear empties the log but keeps the active state', () => {
    const r = new SessionRecorder();
    r.start();
    r.capture('click');
    r.clear();
    expect(r.status().events).toBe(0);
    expect(r.active).toBe(true);
  });

  it('status reports active, event count and elapsed time', () => {
    let t = 500;
    const r = new SessionRecorder({ now: () => t });
    expect(r.status()).toMatchObject({ active: false, events: 0, startedAt: null, elapsedMs: null });
    r.start();
    t += 200;
    r.capture('type');
    expect(r.status()).toMatchObject({ active: true, events: 1, elapsedMs: 200 });
    expect(r.status().startedAt).toBe(new Date(500).toISOString());
  });
});

describe('sanitizeRecordedValue', () => {
  it('redacts sensitive keys at any depth', () => {
    const out = sanitizeRecordedValue({
      user: 'bob',
      password: 'hunter2',
      nested: { token: 'abc', oneTimeCode: '123456', 'one-time-code': '654321' },
    }) as any;
    expect(out.user).toBe('bob');
    expect(out.password).toBe(REDACTED_VALUE);
    expect(out.nested.token).toBe(REDACTED_VALUE);
    expect(out.nested['one-time-code']).toBe(REDACTED_VALUE);
  });

  it('redacts the value of sensitive element shapes (redaction.ts semantics)', () => {
    const out = sanitizeRecordedValue({ type: 'password', value: 'secret', name: 'pwd' }) as any;
    expect(out.value).toBe(REDACTED_VALUE);
    expect(out.name).toBe('pwd');
    // type/action objects are not sensitive shapes
    const act = sanitizeRecordedValue({ type: 'type', text: 'hello' }) as any;
    expect(act.text).toBe('hello');
  });

  it('truncates strings longer than 200 chars', () => {
    const long = 'x'.repeat(RECORDED_STRING_MAX_CHARS + 30);
    const out = sanitizeRecordedValue({ text: long }) as any;
    expect(out.text).toBe(`${'x'.repeat(RECORDED_STRING_MAX_CHARS)}…[+30 chars]`);
  });

  it('caps recursion depth and passes primitives through', () => {
    const deep = { a: { b: { c: { d: { e: 'too deep' } } } } };
    const out = sanitizeRecordedValue(deep) as any;
    expect(out.a.b.c.d).toBe('[max depth]');
    expect(sanitizeRecordedValue(42)).toBe(42);
    expect(sanitizeRecordedValue(null)).toBeNull();
  });
});

describe('summarizeToolEvent', () => {
  it('maps act actions to their action type with url/selector', () => {
    const nav = summarizeToolEvent('act', { action: { type: 'navigate', url: 'https://x.dev' } }, true);
    expect(nav).toMatchObject({ event: 'navigate', tool: 'act', ok: true, url: 'https://x.dev' });
    const click = summarizeToolEvent('act', { action: { type: 'click', selector: '#go' } }, false);
    expect(click).toMatchObject({ event: 'click', ok: false, selector: '#go' });
  });

  it('uses the tool name as event for non-act tools and extracts coords', () => {
    const ev = summarizeToolEvent('trustedClick', { selector: '#a', coords: { x: 10, y: 20 } }, true);
    expect(ev).toMatchObject({ event: 'trustedClick', tool: 'trustedClick', coords: { x: 10, y: 20 } });
  });

  it('sanitizes event data (redaction + truncation)', () => {
    const ev = summarizeToolEvent('smartType', { query: 'password', text: 's3cr3t', password: 's3cr3t' }, true);
    expect(ev.data!.password).toBe(REDACTED_VALUE);
    const long = summarizeToolEvent('act', { action: { type: 'type', selector: '#q', text: 'y'.repeat(300) } }, true);
    expect((long.data!.text as string).length).toBeLessThan(300);
  });

  it('redacts text typed into a password-looking selector', () => {
    const ev = summarizeToolEvent('act', { action: { type: 'type', selector: 'input[name=password]', text: 's3cr3t' } }, true);
    expect(ev.data!.text).toBe(REDACTED_VALUE);
  });
});

describe('summarizeRecording', () => {
  it('aggregates counts by event type and duration', () => {
    const summary = summarizeRecording({
      startedAt: 1000,
      stoppedAt: 1600,
      events: [
        { ts: 1000, event: 'navigate', tool: 'act', ok: true },
        { ts: 1100, event: 'click', tool: 'act', ok: true },
        { ts: 1200, event: 'click', tool: 'act', ok: false },
      ],
    });
    expect(summary).toEqual({ events: 3, durationMs: 600, byType: { navigate: 1, click: 2 } });
  });
});

describe('SessionRecorder.exportToEvidence', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yautja-sessrec-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('dumps the JSON log to the evidence store and returns id + summary', () => {
    const store = new EvidenceStore(dir);
    const r = new SessionRecorder();
    r.start();
    r.capture('navigate', { tool: 'act', ok: true, url: 'https://x.dev' });
    r.capture('screenshot', { tool: 'act', ok: true, evidenceId: 'ev_abc123' });
    r.stop();

    const out = r.exportToEvidence(store, { runId: 'sess_test' });
    expect(out).not.toBeNull();
    expect(out!.record.id).toMatch(/^ev_[0-9a-f]{16}$/);
    expect(out!.record.kind).toBe('session-recording');
    expect(out!.record.runId).toBe('sess_test');
    expect(out!.summary).toMatchObject({ events: 2, byType: { navigate: 1, screenshot: 1 } });

    const stored = store.get(out!.record.id);
    expect(stored).not.toBeNull();
    const doc = JSON.parse(stored!.body);
    expect(doc.kind).toBe('session-recording');
    expect(doc.events).toHaveLength(2);
    expect(doc.events[1].evidenceId).toBe('ev_abc123');
    // screenshots link the evidence id, never the base64
    expect(stored!.body).not.toContain('base64');
  });

  it('returns null when there is nothing to export', () => {
    const store = new EvidenceStore(dir);
    expect(new SessionRecorder().exportToEvidence(store)).toBeNull();
  });
});

describe('yjSessionRecorder kill switch', () => {
  beforeEach(() => clearKillSwitchCache());

  it('is enabled by default and disabled by an explicit false', async () => {
    expect(await isFeatureEnabled({ storageGet: async () => undefined }, SESSION_RECORDER_KILL_SWITCH_KEY)).toBe(true);
    clearKillSwitchCache();
    expect(await isFeatureEnabled({ storageGet: async () => false }, SESSION_RECORDER_KILL_SWITCH_KEY)).toBe(false);
  });

  it('recorder management tools are excluded from recording', () => {
    expect(RECORDER_EXCLUDED_TOOLS.has('session_record')).toBe(true);
    expect(RECORDER_EXCLUDED_TOOLS.has('macro_record')).toBe(true);
    expect(RECORDER_EXCLUDED_TOOLS.has('act')).toBe(false);
  });
});
