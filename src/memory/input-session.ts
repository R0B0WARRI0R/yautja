/**
 * InputSessionMemory — per-tab record of the last input failure per selector.
 *
 * Anti blind-retry rule (P11): if the same (tabId, selector) failed with
 * TYPE_PARTIAL within the block window (default 30s), smartType must not
 * retry directly — it must go through ensureEmpty (or a tab reload) first.
 *
 * Also stores residual text backups captured by ensureEmpty so nothing the
 * user (or a previous failed type) had in the box is silently lost.
 */

import { ulid } from 'ulid';

export interface InputFailure {
  code: string;
  at: number;
}

export interface ResidualBackup {
  id: string;
  tabId: number;
  selector: string;
  text: string;
  at: number;
}

export const DEFAULT_BLOCK_WINDOW_MS = 30_000;

export class InputSessionMemory {
  private failures = new Map<string, InputFailure>();
  private backups: ResidualBackup[] = [];

  private key(tabId: number, selector: string): string {
    return `${tabId}:${selector}`;
  }

  recordFailure(tabId: number, selector: string, code: string, now = Date.now()): void {
    this.failures.set(this.key(tabId, selector), { code, at: now });
  }

  lastFailure(tabId: number, selector: string): InputFailure | null {
    return this.failures.get(this.key(tabId, selector)) ?? null;
  }

  isBlocked(tabId: number, selector: string, windowMs = DEFAULT_BLOCK_WINDOW_MS, now = Date.now()): boolean {
    const f = this.failures.get(this.key(tabId, selector));
    if (!f) return false;
    if (now - f.at > windowMs) {
      this.failures.delete(this.key(tabId, selector));
      return false;
    }
    return true;
  }

  clear(tabId: number, selector: string): void {
    this.failures.delete(this.key(tabId, selector));
  }

  recordBackup(tabId: number, selector: string, text: string, now = Date.now()): string {
    const id = `rb_${ulid()}`;
    this.backups.push({ id, tabId, selector, text, at: now });
    if (this.backups.length > 100) this.backups = this.backups.slice(-100);
    return id;
  }

  getBackup(id: string): ResidualBackup | null {
    return this.backups.find((b) => b.id === id) ?? null;
  }

  clearAll(): void {
    this.failures.clear();
    this.backups = [];
  }
}
