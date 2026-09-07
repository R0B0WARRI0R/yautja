export interface WorkspaceTab { tabId: number; groupId?: number; windowId: number; index: number; }
export interface WorkspaceServer {
  listTabs(): Promise<WorkspaceTab[]>;
  closeTab(tabId: number, expectedGroupId?: number): Promise<void>;
  groupTab(tabId: number, groupId: number): Promise<void>;
  restoreTab(tabId: number, original: WorkspaceTab, expectedGroupId: number): Promise<void>;
}

/** Tracks provenance. Group membership alone never grants permission to delete a tab. */
export class SessionWorkspace {
  private created = new Map<number, number>();
  private borrowed = new Map<number, { original: WorkspaceTab; groupId: number }>();
  trackCreated(tabId: number, groupId: number): void { this.created.set(tabId, groupId); }
  async adopt(server: WorkspaceServer, tabId: number, groupId: number): Promise<void> {
    const tab = (await server.listTabs()).find(tab => tab.tabId === tabId);
    if (!tab) throw new Error(`Tab ${tabId} does not exist`);
    if (this.created.has(tabId) || this.borrowed.has(tabId)) return;
    if (tab.groupId === groupId) throw new Error('Tab already in the group has unknown provenance; it will be preserved');
    // Keep recovery information even if grouping has an unknown outcome.
    this.borrowed.set(tabId, { original: { ...tab }, groupId });
    await server.groupTab(tabId, groupId);
  }
  async finish(server: WorkspaceServer, groupId: number) {
    const closed: number[] = [], restored: number[] = [], preserved: number[] = [];
    const failed: Array<{ tabId: number; error: string }> = [];
    for (const [tabId, expectedGroup] of [...this.created]) {
      if (expectedGroup !== groupId) continue;
      try {
        const current = (await server.listTabs()).find(tab => tab.tabId === tabId);
        if (!current) { this.created.delete(tabId); continue; }
        if (current.groupId !== expectedGroup) { preserved.push(tabId); this.created.delete(tabId); continue; }
        await server.closeTab(tabId, expectedGroup);
        closed.push(tabId); this.created.delete(tabId);
      } catch (error) { failed.push({ tabId, error: error instanceof Error ? error.message : String(error) }); }
    }
    for (const [tabId, borrowed] of [...this.borrowed]) {
      if (borrowed.groupId !== groupId) continue;
      try {
        const current = (await server.listTabs()).find(tab => tab.tabId === tabId);
        if (!current) { this.borrowed.delete(tabId); continue; }
        if (current.groupId !== groupId) { preserved.push(tabId); this.borrowed.delete(tabId); continue; }
        await server.restoreTab(tabId, borrowed.original, groupId);
        restored.push(tabId); this.borrowed.delete(tabId);
      } catch (error) { failed.push({ tabId, error: error instanceof Error ? error.message : String(error) }); }
    }
    const remaining = (await server.listTabs()).filter(tab => tab.groupId === groupId).map(tab => tab.tabId);
    return { groupId, closed, restored, preserved, failed, remaining, groupClosed: remaining.length === 0 };
  }
}
