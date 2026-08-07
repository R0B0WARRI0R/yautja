import { mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises';
import path, { join } from 'node:path';

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
    // Pass-2 hardening: the traceId and every rest segment become parts
    // of an absolute filesystem path via path.join. path.join DOES
    // normalize `..` segments, so a URI like
    //   resource://yautja/traces/../network
    // resolved to <rootDir>/../network.json — outside the trace root,
    // where the MCP server then reads arbitrary JSON/PNG. The LLM
    // (via MCP resources/read) controls `uri` and therefore controls
    // the filesystem path.
    //
    // The fix validates each segment is a safe identifier (alphanum +
    // dash/underscore/dot) and re-verifies the resolved path is inside
    // rootDir via path.relative — defense in depth even if the regex
    // ever loosens.
    if (!SAFE_SEGMENT.test(traceId)) return null;
    if (rest === 'network') {
      const p = join(this.config.rootDir, traceId, 'network.json');
      return isInsideRoot(this.config.rootDir, p) ? p : null;
    }
    const parts = rest.split('/');
    if (parts.length !== 2 || !parts.every(SAFE_SEGMENT.test.bind(SAFE_SEGMENT))) return null;
    const subdir = parts[0];
    const fileName = subdir === 'dom' ? `${parts[1]}.json` : `${parts[1]}.png`;
    const p = join(this.config.rootDir, traceId, subdir, fileName);
    return isInsideRoot(this.config.rootDir, p) ? p : null;
  }
}

/** Allow only safe identifiers — alphanumeric, dash, underscore, dot. */
const SAFE_SEGMENT = /^[a-zA-Z0-9_.-]+$/;

/**
 * Defense in depth: even after segment validation, re-verify the
 * resolved path is inside rootDir. path.relative returns a path
 * starting with '..' if p is outside rootDir; on Windows it can
 * also return an absolute path — both are "outside" for our purposes.
 */
function isInsideRoot(rootDir: string, p: string): boolean {
  const rel = path.relative(rootDir, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}