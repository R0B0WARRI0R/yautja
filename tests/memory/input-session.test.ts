import { describe, it, expect, beforeEach } from 'vitest';
import { InputSessionMemory, DEFAULT_BLOCK_WINDOW_MS } from '../../src/memory/input-session.js';

describe('InputSessionMemory', () => {
  let mem: InputSessionMemory;

  beforeEach(() => {
    mem = new InputSessionMemory();
  });

  it('records and returns the last failure per tab+selector', () => {
    mem.recordFailure(1, '#a', 'YJ.ACT.TYPE_PARTIAL', 1000);
    expect(mem.lastFailure(1, '#a')).toEqual({ code: 'YJ.ACT.TYPE_PARTIAL', at: 1000 });
    expect(mem.lastFailure(1, '#b')).toBeNull();
    expect(mem.lastFailure(2, '#a')).toBeNull();
  });

  it('isBlocked is true within the window and false after it', () => {
    mem.recordFailure(1, '#a', 'YJ.ACT.TYPE_PARTIAL', 10_000);
    expect(mem.isBlocked(1, '#a', DEFAULT_BLOCK_WINDOW_MS, 10_000)).toBe(true);
    expect(mem.isBlocked(1, '#a', DEFAULT_BLOCK_WINDOW_MS, 10_000 + 29_999)).toBe(true);
    expect(mem.isBlocked(1, '#a', DEFAULT_BLOCK_WINDOW_MS, 10_000 + 30_001)).toBe(false);
  });

  it('expired entries are evicted on isBlocked check', () => {
    mem.recordFailure(1, '#a', 'YJ.ACT.TYPE_PARTIAL', 10_000);
    expect(mem.isBlocked(1, '#a', 30_000, 50_000)).toBe(false);
    expect(mem.lastFailure(1, '#a')).toBeNull();
  });

  it('scopes blocks to tab and selector independently', () => {
    mem.recordFailure(1, '#a', 'YJ.ACT.TYPE_PARTIAL', 1000);
    expect(mem.isBlocked(2, '#a', 30_000, 1000)).toBe(false);
    expect(mem.isBlocked(1, '#b', 30_000, 1000)).toBe(false);
  });

  it('clear lifts the block', () => {
    mem.recordFailure(1, '#a', 'YJ.ACT.TYPE_PARTIAL', 1000);
    mem.clear(1, '#a');
    expect(mem.isBlocked(1, '#a', 30_000, 1000)).toBe(false);
    expect(mem.lastFailure(1, '#a')).toBeNull();
  });

  it('recordBackup stores residual text retrievable by id', () => {
    const id = mem.recordBackup(1, '#a', 'residual prompt text', 1000);
    expect(id).toMatch(/^rb_/);
    const b = mem.getBackup(id);
    expect(b).toMatchObject({ tabId: 1, selector: '#a', text: 'residual prompt text', at: 1000 });
    expect(mem.getBackup('rb_nonexistent')).toBeNull();
  });

  it('trims backups to the last 100', () => {
    const firstId = mem.recordBackup(1, '#a', 't0', 0);
    for (let i = 1; i < 110; i++) mem.recordBackup(1, '#a', `t${i}`, i);
    const lastId = mem.recordBackup(1, '#a', 't110', 110);
    expect(mem.getBackup(firstId)).toBeNull();
    expect(mem.getBackup(lastId)).not.toBeNull();
  });

  it('clearAll wipes failures and backups', () => {
    mem.recordFailure(1, '#a', 'YJ.ACT.TYPE_PARTIAL', 1000);
    const id = mem.recordBackup(1, '#a', 'x', 1000);
    mem.clearAll();
    expect(mem.lastFailure(1, '#a')).toBeNull();
    expect(mem.getBackup(id)).toBeNull();
  });
});
