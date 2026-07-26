/**
 * Evidence store (P15) — content-addressed, redacted-by-default evidence.
 *
 * Layout (canonical, per r2 — under ~/.yautja, not a fourth orphan dir):
 *
 *   <root>/<runId>/res-<hash>.json|txt
 *   <root>/<runId>/meta-<hash>.json
 *   <root>/index.jsonl
 *
 * Rules:
 *   - bodies are scrubbed of secrets at rest (default), so evidenceGet
 *     never returns secrets in the clear unless includeRaw AND the caller
 *     passed raw storage (analyst mode — enforced in helmet, not here)
 *   - ids are content-addressed: ev_<sha256[:16]>
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { scrubSecrets } from './browser-fetch.js';

export type EvidenceKind = 'browserFetch' | 'intercept' | 'manual';

export interface EvidenceRecord {
  id: string;
  runId: string;
  host: string;
  url?: string;
  method?: string;
  kind: EvidenceKind;
  createdAt: string;
  redacted: boolean;
  resPath: string;
  bytes: number;
}

export interface EvidencePutInput {
  runId?: string;
  host: string;
  url?: string;
  method?: string;
  kind?: EvidenceKind;
  body: string;
  /** Store the raw body too (analyst mode). Default: only scrubbed. */
  storeRaw?: boolean;
}

export class EvidenceStore {
  private root: string;

  constructor(root: string) {
    this.root = root;
    try { fs.mkdirSync(root, { recursive: true }); } catch {}
  }

  private hash(body: string): string {
    return crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
  }

  put(input: EvidencePutInput): EvidenceRecord {
    const runId = input.runId ?? 'default';
    const kind = input.kind ?? 'manual';
    const scrubbed = scrubSecrets(input.body);
    const storeBody = input.storeRaw ? input.body : scrubbed;
    const h = this.hash(storeBody);
    const id = `ev_${h}`;
    const isJson = storeBody.trim().startsWith('{') || storeBody.trim().startsWith('[');
    const relDir = runId;
    const relPath = path.join(relDir, `res-${h}.${isJson ? 'json' : 'txt'}`);

    const dir = path.join(this.root, relDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(this.root, relPath), storeBody);

    const record: EvidenceRecord = {
      id,
      runId,
      host: input.host,
      url: input.url,
      method: input.method,
      kind,
      createdAt: new Date().toISOString(),
      redacted: !input.storeRaw,
      resPath: relPath,
      bytes: Buffer.byteLength(storeBody),
    };
    fs.writeFileSync(path.join(dir, `meta-${h}.json`), JSON.stringify(record, null, 2));
    fs.appendFileSync(path.join(this.root, 'index.jsonl'), JSON.stringify(record) + '\n');
    return record;
  }

  get(id: string): { record: EvidenceRecord; body: string } | null {
    const meta = this.findMeta(id);
    if (!meta) return null;
    try {
      const body = fs.readFileSync(path.join(this.root, meta.resPath), 'utf8');
      return { record: meta, body };
    } catch {
      return null;
    }
  }

  private findMeta(id: string): EvidenceRecord | null {
    const h = id.replace(/^ev_/, '');
    try {
      const runDirs = fs.readdirSync(this.root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      for (const runDir of runDirs) {
        const metaPath = path.join(this.root, runDir, `meta-${h}.json`);
        if (fs.existsSync(metaPath)) {
          return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        }
      }
    } catch {}
    return null;
  }

  list(filter?: { host?: string; runId?: string }): EvidenceRecord[] {
    const out: EvidenceRecord[] = [];
    try {
      const indexPath = path.join(this.root, 'index.jsonl');
      if (!fs.existsSync(indexPath)) return [];
      for (const line of fs.readFileSync(indexPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as EvidenceRecord;
          if (filter?.host && rec.host !== filter.host) continue;
          if (filter?.runId && rec.runId !== filter.runId) continue;
          out.push(rec);
        } catch { /* skip corrupt line */ }
      }
    } catch {}
    return out;
  }

  export(format: 'jsonl', destPath: string): { path: string; entries: number; bytes: number } {
    if (format !== 'jsonl') throw new Error(`Unsupported export format: ${format}`);
    const records = this.list();
    const lines = records.map((r) => {
      const body = this.get(r.id)?.body ?? '';
      return JSON.stringify({ ...r, body });
    });
    const content = lines.join('\n') + (lines.length ? '\n' : '');
    fs.writeFileSync(destPath, content);
    return { path: destPath, entries: records.length, bytes: Buffer.byteLength(content) };
  }

  /**
   * GC (P17): drop evidence older than ttlDays (default 7) — meta files,
   * body files and index entries. Returns the number of records dropped.
   */
  gc(ttlDays = 7): number {
    const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
    const records = this.list();
    const keep: EvidenceRecord[] = [];
    let dropped = 0;
    for (const rec of records) {
      if (Date.parse(rec.createdAt) < cutoff) {
        dropped++;
        try {
          fs.rmSync(path.join(this.root, rec.resPath), { force: true });
          const metaPath = path.join(this.root, rec.runId, `meta-${rec.id.slice(3)}.json`);
          fs.rmSync(metaPath, { force: true });
        } catch {}
      } else {
        keep.push(rec);
      }
    }
    if (dropped > 0) {
      try {
        fs.writeFileSync(
          path.join(this.root, 'index.jsonl'),
          keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''),
        );
      } catch {}
    }
    return dropped;
  }
}
