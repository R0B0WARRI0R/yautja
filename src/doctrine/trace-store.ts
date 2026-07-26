import { mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface TraceStoreConfig {
  rootDir: string;
  ttlDays: number;
}

export class TraceStore {
  private config: TraceStoreConfig;

  constructor(config: TraceStoreConfig) {
    this.config = config;
  }

  async saveDomSnapshot(traceId: string, snapshotId: number, content: string): Promise<string> {
    const dir = join(this.config.rootDir, traceId, 'dom');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${snapshotId}.json`);
    await writeFile(filePath, content, 'utf-8');
    return `resource://yautja/traces/${traceId}/dom/${snapshotId}`;
  }

  async saveNetworkWindow(traceId: string, content: string): Promise<string> {
    const dir = join(this.config.rootDir, traceId);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'network.json');
    await writeFile(filePath, content, 'utf-8');
    return `resource://yautja/traces/${traceId}/network`;
  }

  async saveScreenshot(traceId: string, snapshotId: number, base64Png: string): Promise<string> {
    const dir = join(this.config.rootDir, traceId, 'screenshot');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${snapshotId}.png`);
    await writeFile(filePath, Buffer.from(base64Png, 'base64'));
    return `resource://yautja/traces/${traceId}/screenshot/${snapshotId}`;
  }

  async readResource(uri: string): Promise<string | null> {
    const path = this.uriToPath(uri);
    if (!path) return null;
    try {
      return await readFile(path, 'utf-8');
    } catch {
      return null;
    }
  }

  /** Trace ids whose directory mtime is older than the TTL. */
  async findExpired(ttlDays?: number): Promise<string[]> {
    const ttl = (ttlDays ?? this.config.ttlDays) * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - ttl;
    const expired: string[] = [];
    try {
      const entries = await readdir(this.config.rootDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const st = await stat(join(this.config.rootDir, entry.name));
          if (st.mtimeMs < cutoff) expired.push(entry.name);
        } catch { /* skip unreadable */ }
      }
    } catch { /* rootDir missing → nothing to expire */ }
    return expired;
  }

  /** GC: purge every expired trace. Returns the purged ids. */
  async purgeExpired(ttlDays?: number): Promise<string[]> {
    const expired = await this.findExpired(ttlDays);
    for (const traceId of expired) {
      await this.purgeTrace(traceId);
    }
    return expired;
  }

  /** List trace ids present in the store (for MCP resources/list). */
  async listTraces(): Promise<string[]> {
    try {
      const entries = await readdir(this.config.rootDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  async purgeTrace(traceId: string): Promise<void> {
    const dir = join(this.config.rootDir, traceId);
    await rm(dir, { recursive: true, force: true });
  }

  private uriToPath(uri: string): string | null {
    const match = uri.match(/^resource:\/\/yautja\/traces\/([^/]+)\/(.+)$/);
    if (!match) return null;
    const [, traceId, rest] = match;
    if (rest === 'network') {
      return join(this.config.rootDir, traceId, 'network.json');
    }
    const parts = rest.split('/');
    const fileName = parts[0] === 'dom' ? `${parts[1]}.json` : `${parts[1]}.png`;
    return join(this.config.rootDir, traceId, parts[0], fileName);
  }
}