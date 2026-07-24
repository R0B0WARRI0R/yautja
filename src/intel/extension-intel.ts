/**
 * ExtensionIntel — disk + management backend for inspecting Chrome extensions.
 *
 * Three transport tiers:
 *   1. Disk (no Chrome changes): readManifest, readSource, readStorage
 *   2. Management API (needs permission): listExtensions, setEnabled
 *   3. CDP remote (needs --remote-debugging-port): via CdpRemoteClient in helmet
 *
 * The disk backend reads directly from the Chrome profile on disk:
 *   Source:   {profile}/Extensions/{extId}/{version}/
 *   Storage:  {profile}/Local Extension Settings/{extId}/  (LevelDB)
 *
 * Chrome holds a LOCK on the live LevelDB, so we copy files to a temp dir
 * before opening read-only.
 */

import { readFile, readdir, copyFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// classic-level is CJS; use createRequire for ESM interop.
const { ClassicLevel } = require('classic-level') as { ClassicLevel: any };

export interface DiskExtensionInfo {
  extId: string;
  profile: string;
  versionDir: string;
  version: string;
}

export class ExtensionIntel {
  private userDataDir: string | null = null;

  // ─── Profile detection ──────────────────────────────────────

  /**
   * Auto-detect the Chrome User Data directory.
   * Override with YAUTJA_CHROME_USER_DATA env var.
   */
  private async getUserDataDir(): Promise<string> {
    if (this.userDataDir) return this.userDataDir;

    const env = process.env.YAUTJA_CHROME_USER_DATA;
    if (env) {
      this.userDataDir = env;
      return env;
    }

    const localAppData =
      process.env.LOCALAPPDATA ||
      join(process.env.USERPROFILE || process.env.HOME || '', 'AppData', 'Local');

    const candidates = [
      join(localAppData, 'Google', 'Chrome', 'User Data'),
    ];

    for (const dir of candidates) {
      try {
        await readdir(dir);
        this.userDataDir = dir;
        return dir;
      } catch {
        // not found, try next
      }
    }
    throw new Error(
      'Chrome User Data directory not found. Set YAUTJA_CHROME_USER_DATA env var.'
    );
  }

  /**
   * List profile directory names from Local State, falling back to ['Default'].
   */
  private async getProfiles(userDataDir: string): Promise<string[]> {
    try {
      const raw = await readFile(join(userDataDir, 'Local State'), 'utf-8');
      const localState = JSON.parse(raw);
      const profiles = Object.keys(localState.profile?.info_cache || {});
      return profiles.length > 0 ? profiles : ['Default'];
    } catch {
      return ['Default'];
    }
  }

  /**
   * Find the on-disk version directory for an extension across all profiles.
   */
  async findExt(extId: string): Promise<DiskExtensionInfo | null> {
    const userDataDir = await this.getUserDataDir();
    const profiles = await this.getProfiles(userDataDir);

    for (const profile of profiles) {
      const extBase = join(userDataDir, profile, 'Extensions', extId);
      try {
        const versions = (await readdir(extBase)).filter((v) => !v.startsWith('.'));
        if (versions.length > 0) {
          versions.sort();
          const latest = versions[versions.length - 1];
          return { extId, profile, versionDir: join(extBase, latest), version: latest };
        }
      } catch {
        // extension not in this profile
      }
    }
    return null;
  }

  // ─── Source / Manifest ──────────────────────────────────────

  async readManifest(extId: string): Promise<Record<string, any>> {
    const found = await this.findExt(extId);
    if (!found) throw notFound(extId);
    const raw = await readFile(join(found.versionDir, 'manifest.json'), 'utf-8');
    return JSON.parse(raw);
  }

  async readSource(extId: string, filePath: string): Promise<string> {
    const found = await this.findExt(extId);
    if (!found) throw notFound(extId);
    return readFile(join(found.versionDir, filePath), 'utf-8');
  }

  async listSourceFiles(extId: string): Promise<string[]> {
    const found = await this.findExt(extId);
    if (!found) throw notFound(extId);
    const entries = await readdir(found.versionDir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  }

  // ─── Storage (LevelDB) ──────────────────────────────────────

  /**
   * Read chrome.storage.local from disk.
   * Chrome holds a LOCK on the live DB, so we copy to temp first.
   *
   * Returns a key→value map. Chrome wraps values as {origin, value};
   * we unwrap to the inner value. Keys with the `!extdb.` prefix are cleaned.
   */
  async readStorage(extId: string, key?: string): Promise<Record<string, any>> {
    const found = await this.findExt(extId);
    if (!found) throw notFound(extId);

    const ldbSrc = join(
      // Storage is in the same profile as the extension
      await this.userDataDirFor(found.profile),
      'Local Extension Settings',
      extId,
    );

    let tmpDir: string | null = null;
    try {
      // Copy DB files to temp
      tmpDir = join(tmpdir(), `yautja-ext-${extId}-${Date.now()}`);
      await mkdir(tmpDir, { recursive: true });
      const files = await readdir(ldbSrc);
      for (const f of files) {
        if (
          f.endsWith('.ldb') ||
          f.endsWith('.log') ||
          f === 'CURRENT' ||
          f.startsWith('MANIFEST')
        ) {
          await copyFile(join(ldbSrc, f), join(tmpDir, f));
        }
      }

      const db = new ClassicLevel(tmpDir, {
        readOnly: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });
      await db.open();

      const result: Record<string, any> = {};
      for await (const [rawKey, rawValue] of db.iterator()) {
        const cleanKey = rawKey.replace(/^!extdb\./, '');
        // If a specific key was requested, filter
        if (key && cleanKey !== key && rawKey !== key) continue;

        let value: any = rawValue;
        try {
          const parsed = JSON.parse(rawValue);
          // Chrome wraps: { "origin": "normal", "value": <actual> }
          value = parsed.value !== undefined ? parsed.value : parsed;
        } catch {
          // not JSON, keep raw string
        }
        result[cleanKey] = value;
      }

      await db.close();
      return result;
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        throw new Error(`Extension ${extId} has no local storage on disk`);
      }
      throw e;
    } finally {
      if (tmpDir) {
        try {
          await rm(tmpDir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
  }

  private async userDataDirFor(profile: string): Promise<string> {
    const base = await this.getUserDataDir();
    return join(base, profile);
  }
}

function notFound(extId: string): Error {
  return new Error(
    `Extension ${extId} not found on disk. It may be installed in a profile Yautja cannot detect. ` +
      'Set YAUTJA_CHROME_USER_DATA to the correct Chrome User Data directory.'
  );
}
