import { describe, it, expect } from 'vitest';
import { trustedFileChooser, buildIsFileInputScript } from '../../src/arsenal/file-chooser.js';

function makeDeps(opts: {
  element?: any;
  nodeId?: number;
  chooserEvent?: any;
  interceptFails?: boolean;
  setFilesFails?: boolean;
}) {
  const calls: { method: string; params: any }[] = [];
  const handlers = new Map<string, (p: any) => void>();
  const deps = {
    calls,
    async send(method: string, params?: any): Promise<any> {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        const expr: string = params?.expression ?? '';
        if (expr.includes('getBoundingClientRect')) return { result: { value: { x: 10, y: 10 } } };
        return { result: { value: opts.element ?? null } };
      }
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: opts.nodeId ?? 7 };
      if (method === 'DOM.setFileInputFiles') {
        if (opts.setFilesFails) throw new Error('unsupported');
        return {};
      }
      if (method === 'Page.setInterceptFileChooserDialog') {
        if (opts.interceptFails) throw new Error('not supported in this backend');
        return {};
      }
      if (method === 'Page.enable') return {};
      if (method === 'Input.dispatchMouseEvent') {
        // Simulate: trusted click opens the chooser
        if (opts.chooserEvent) {
          const h = handlers.get('Page.fileChooserOpened');
          if (h) setTimeout(() => h(opts.chooserEvent), 0);
        }
        return {};
      }
      return {};
    },
    on(event: string, handler: (p: any) => void) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  };
  return deps;
}

const FILES = ['D:/tmp/report.pdf'];

describe('trustedFileChooser', () => {
  it('path A: direct input[type=file] → DOM.setFileInputFiles with nodeId', async () => {
    const deps = makeDeps({ element: { tag: 'INPUT', type: 'file' }, nodeId: 7 });
    const r = await trustedFileChooser(deps as any, { selector: '#upload', files: FILES });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path).toBe('direct');
      expect(r.filesAttached).toBe(1);
    }
    const setFiles = deps.calls.find((c) => c.method === 'DOM.setFileInputFiles');
    expect(setFiles!.params).toEqual({ nodeId: 7, files: FILES });
  });

  it('path A degrades to CAPABILITY_MISSING when setFileInputFiles unsupported', async () => {
    const deps = makeDeps({ element: { tag: 'INPUT', type: 'file' }, setFilesFails: true });
    const r = await trustedFileChooser(deps as any, { selector: '#upload', files: FILES });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('YJ.PROTOCOL.CAPABILITY_MISSING');
  });

  it('path B: trigger button → intercept + trusted click + backendNodeId files', async () => {
    const deps = makeDeps({
      element: { tag: 'BUTTON', type: '' },
      chooserEvent: { backendNodeId: 42 },
    });
    const r = await trustedFileChooser(deps as any, { selector: '#attach-btn', files: FILES });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe('chooser');
    const setFiles = deps.calls.find((c) => c.method === 'DOM.setFileInputFiles');
    expect(setFiles!.params).toEqual({ backendNodeId: 42, files: FILES });
    // intercept disabled afterwards
    const disables = deps.calls.filter((c) => c.method === 'Page.setInterceptFileChooserDialog');
    expect(disables[disables.length - 1]!.params.enabled).toBe(false);
  });

  it('path B without chooser event → CAPABILITY_MISSING timeout (no fake success)', async () => {
    const deps = makeDeps({ element: { tag: 'BUTTON', type: '' }, chooserEvent: null });
    const r = await trustedFileChooser(deps as any, { selector: '#attach-btn', files: FILES, timeoutMs: 50 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('YJ.PROTOCOL.CAPABILITY_MISSING');
      expect(r.detail).toContain('fileChooserOpened');
    }
  });

  it('path B without intercept support → CAPABILITY_MISSING', async () => {
    const deps = makeDeps({ element: { tag: 'BUTTON', type: '' }, interceptFails: true });
    const r = await trustedFileChooser(deps as any, { selector: '#attach-btn', files: FILES });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('YJ.PROTOCOL.CAPABILITY_MISSING');
  });

  it('missing element → DOM_TARGET_NOT_FOUND', async () => {
    const deps = makeDeps({ element: null });
    const r = await trustedFileChooser(deps as any, { selector: '#ghost', files: FILES });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('YJ.ACT.DOM_TARGET_NOT_FOUND');
  });
});

describe('buildIsFileInputScript', () => {
  it('reads tag and type in a fake DOM', () => {
    const el = { tagName: 'INPUT', getAttribute: (a: string) => (a === 'type' ? 'file' : null) };
    const document = { querySelector: () => el };
    const out = new Function('document', `return (${buildIsFileInputScript('#u')});`)(document);
    expect(out).toEqual({ tag: 'INPUT', type: 'file' });
  });
});
