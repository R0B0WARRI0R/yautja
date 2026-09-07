import { describe, it, expect } from 'vitest';
import { SessionWorkspace } from '../../src/connection/session-workspace.js';

function fixture() {
  let tabs = [{ tabId: 1, groupId: -1, windowId: 1, index: 0 }, { tabId: 2, groupId: 10, windowId: 1, index: 1 }];
  const closed: number[] = [];
  return {
    closed, listTabs: async () => tabs.map(t => ({ ...t })),
    closeTab: async (tabId: number) => { closed.push(tabId); tabs = tabs.filter(t => t.tabId !== tabId); },
    groupTab: async (tabId: number, groupId: number) => { tabs.find(t => t.tabId === tabId)!.groupId = groupId; },
    restoreTab: async (tabId: number, original: any) => { Object.assign(tabs.find(t => t.tabId === tabId)!, original); },
  };
}
describe('session workspace cleanup', () => {
  it('closes created tabs and restores borrowed tabs; repeat is harmless', async () => {
    const s = fixture(); const w = new SessionWorkspace();
    w.trackCreated(2, 10); await w.adopt(s, 1, 10);
    const result = await w.finish(s, 10);
    expect(result).toMatchObject({ closed: [2], restored: [1], groupClosed: true });
    expect(s.closed).toEqual([2]);
    expect((await s.listTabs())[0]).toMatchObject({ tabId: 1, groupId: -1 });
    expect((await w.finish(s, 10)).closed).toEqual([]);
  });
  it('preserves tabs moved manually to another group', async () => {
    const s = fixture(); const w = new SessionWorkspace(); w.trackCreated(2, 10);
    await s.groupTab(2, 20);
    expect((await w.finish(s, 10)).preserved).toEqual([2]);
    expect(s.closed).toEqual([]);
  });
  it('retains failed cleanup for a later retry', async () => {
    const s = fixture(); const w = new SessionWorkspace(); w.trackCreated(2, 10);
    const close = s.closeTab;
    s.closeTab = async () => { throw new Error('disconnected'); };
    expect((await w.finish(s, 10)).failed).toHaveLength(1);
    s.closeTab = close;
    expect((await w.finish(s, 10)).closed).toEqual([2]);
  });
});
