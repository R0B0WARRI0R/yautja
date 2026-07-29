import { describe, it, expect } from 'vitest';
import { createRefMap, buildResolveRefScript } from '../../src/vision/element-map.js';

describe('createRefMap', () => {
  const connected = new Set<object>();
  const isConnected = (el: object) => connected.has(el);

  it('assigns sequential refs (e1, e2, …) to new elements', () => {
    const map = createRefMap({ isConnected });
    const a = {};
    const b = {};
    expect(map.assign(a)).toBe('e1');
    expect(map.assign(b)).toBe('e2');
    expect(map.size).toBe(2);
  });

  it('reuses the same ref for an already-mapped element', () => {
    const map = createRefMap({ isConnected });
    const a = {};
    const first = map.assign(a);
    expect(map.assign(a)).toBe(first);
    expect(map.size).toBe(1);
  });

  it('resolve returns the element for a live ref and null for unknown refs', () => {
    const map = createRefMap({ isConnected });
    const a = {};
    const ref = map.assign(a);
    expect(map.resolve(ref)).toBe(a);
    expect(map.resolve('e999')).toBeNull();
  });

  it('purge removes refs whose element left the document', () => {
    const map = createRefMap({ isConnected });
    const a = {};
    const b = {};
    connected.add(a);
    connected.add(b);
    const refA = map.assign(a);
    const refB = map.assign(b);
    connected.delete(b);
    expect(map.purge()).toBe(1);
    expect(map.size).toBe(1);
    expect(map.resolve(refA)).toBe(a);
    expect(map.resolve(refB)).toBeNull();
  });

  it('re-assigns a fresh ref if the element is re-added after its ref was purged', () => {
    const map = createRefMap({ isConnected });
    const a = {};
    connected.add(a);
    const stale = map.assign(a);
    connected.delete(a);
    map.purge();
    connected.add(a);
    const fresh = map.assign(a);
    expect(fresh).not.toBe(stale);
    expect(map.resolve(fresh)).toBe(a);
  });

  it('evict removes a single ref', () => {
    const map = createRefMap({ isConnected });
    const a = {};
    connected.add(a);
    const ref = map.assign(a);
    map.evict(ref);
    expect(map.resolve(ref)).toBeNull();
    expect(map.size).toBe(0);
  });
});

describe('buildResolveRefScript', () => {
  it('embeds the ref and derefs the WeakRef with a document.contains check', () => {
    const js = buildResolveRefScript('e7');
    expect(js).toContain('__yjElementMap');
    expect(js).toContain('"e7"');
    expect(js).toContain('.deref()');
    expect(js).toContain('document.contains(el)');
    expect(js).toContain("delete map[\"e7\"]");
  });

  it('scrolls into view and returns the center of the bounding rect', () => {
    const js = buildResolveRefScript('e1');
    expect(js).toContain("scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' })");
    expect(js).toContain('r.left + r.width / 2');
    expect(js).toContain('r.top + r.height / 2');
  });

  it('includes focus/clear blocks only when requested', () => {
    const plain = buildResolveRefScript('e1');
    expect(plain).not.toContain('el.focus()');
    expect(plain).not.toContain("el.value = ''");
    const withFocus = buildResolveRefScript('e1', { focus: true, clear: true });
    expect(withFocus).toContain('el.focus()');
    expect(withFocus).toContain("el.value = ''");
    expect(withFocus).toContain("new Event('input', { bubbles: true })");
  });
});
