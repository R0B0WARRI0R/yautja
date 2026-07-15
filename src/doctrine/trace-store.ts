import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
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

  findExpired(_ttlDays?: number): string[] {
    return [];
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