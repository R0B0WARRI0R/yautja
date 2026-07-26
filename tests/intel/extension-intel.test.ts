import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import { ExtensionIntel } from '../../src/intel/extension-intel.js';

const require = createRequire(import.meta.url);
const { ClassicLevel } = require('classic-level') as { ClassicLevel: any };

const EXT_ID = 'abcdefghijklmnopqrstuvwxyzabcdef'; // 32-char, like a real extension id

describe('ExtensionIntel', () => {
  let workDir: string; // root temp dir for this test
  let userDataDir: string; // fake "User Data" dir
  let intel: ExtensionIntel;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    savedEnv = {
      YAUTJA_CHROME_USER_DATA: process.env.YAUTJA_CHROME_USER_DATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
    };
    workDir = await mkdtemp(join(tmpdir(), 'yautja-test-'));
    userDataDir = join(workDir, 'User Data');
    await mkdir(userDataDir, { recursive: true });
    process.env.YAUTJA_CHROME_USER_DATA = userDataDir;
    intel = new ExtensionIntel();
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(workDir, { recursive: true, force: true });
  });

  // ─── Helpers ───────────────────────────────────────────────

  async function writeLocalState(profiles: string[]): Promise<void> {
    const infoCache = Object.fromEntries(profiles.map((p) => [p, { name: p }]));
    await writeFile(
      join(userDataDir, 'Local State'),
      JSON.stringify({ profile: { info_cache: infoCache } }),
    );
  }

  async function installExt(
    profile: string,
    extId: string,
    version: string,
    files: Record<string, string>,
  ): Promise<string> {
    const versionDir = join(userDataDir, profile, 'Extensions', extId, version);
    for (const [name, content] of Object.entries(files)) {
      const p = join(versionDir, name);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, content);
    }
    return versionDir;
  }

  async function createStorageDb(
    profile: string,
    extId: string,
    entries: [string, string][],
  ): Promise<void> {
    const dbPath = join(userDataDir, profile, 'Local Extension Settings', extId);
    await mkdir(dbPath, { recursive: true });
    const db = new ClassicLevel(dbPath, { keyEncoding: 'utf8', valueEncoding: 'utf8' });
    await db.open();
    for (const [k, v] of entries) await db.put(k, v);
    await db.close();
  }

  // ─── findExt / profile detection ───────────────────────────

  describe('findExt', () => {
    it('finds an extension installed in the Default profile', async () => {
      await installExt('Default', EXT_ID, '1.0.0', { 'manifest.json': '{}' });
      const found = await intel.findExt(EXT_ID);
      expect(found).not.toBeNull();
      expect(found!.extId).toBe(EXT_ID);
      expect(found!.profile).toBe('Default');
      expect(found!.version).toBe('1.0.0');
      expect(found!.versionDir).toBe(
        join(userDataDir, 'Default', 'Extensions', EXT_ID, '1.0.0'),
      );
    });

    it('picks the lexicographically latest version directory', async () => {
      await installExt('Default', EXT_ID, '1.0.0', { 'manifest.json': '{}' });
      await installExt('Default', EXT_ID, '2.0.0', { 'manifest.json': '{}' });
      const found = await intel.findExt(EXT_ID);
      expect(found!.version).toBe('2.0.0');
    });

    it('sorts versions numerically, so 10.0 beats 9.0', async () => {
      await installExt('Default', EXT_ID, '9.0', { 'manifest.json': '{}' });
      await installExt('Default', EXT_ID, '10.0', { 'manifest.json': '{}' });
      const found = await intel.findExt(EXT_ID);
      expect(found!.version).toBe('10.0');
    });

    it('ignores hidden version directories (dot-prefixed)', async () => {
      await installExt('Default', EXT_ID, '.hidden', { 'manifest.json': '{}' });
      await installExt('Default', EXT_ID, '1.0.0', { 'manifest.json': '{}' });
      const found = await intel.findExt(EXT_ID);
      expect(found!.version).toBe('1.0.0');
    });

    it('returns null when only hidden version directories exist', async () => {
      await installExt('Default', EXT_ID, '.hidden', { 'manifest.json': '{}' });
      expect(await intel.findExt(EXT_ID)).toBeNull();
    });

    it('returns null when the extension is not installed in any profile', async () => {
      await mkdir(join(userDataDir, 'Default', 'Extensions'), { recursive: true });
      expect(await intel.findExt(EXT_ID)).toBeNull();
    });

    it('searches across all profiles listed in Local State', async () => {
      await writeLocalState(['Default', 'Profile 1']);
      await installExt('Profile 1', EXT_ID, '3.1.4', { 'manifest.json': '{}' });
      const found = await intel.findExt(EXT_ID);
      expect(found).not.toBeNull();
      expect(found!.profile).toBe('Profile 1');
      expect(found!.version).toBe('3.1.4');
    });

    it('prefers the first profile in Local State order when installed in both', async () => {
      await writeLocalState(['Default', 'Profile 1']);
      await installExt('Default', EXT_ID, '1.0.0', { 'manifest.json': '{}' });
      await installExt('Profile 1', EXT_ID, '2.0.0', { 'manifest.json': '{}' });
      const found = await intel.findExt(EXT_ID);
      expect(found!.profile).toBe('Default');
      expect(found!.version).toBe('1.0.0');
    });

    it('falls back to the Default profile when Local State is missing', async () => {
      await installExt('Default', EXT_ID, '1.0.0', { 'manifest.json': '{}' });
      const found = await intel.findExt(EXT_ID);
      expect(found!.profile).toBe('Default');
    });

    it('falls back to the Default profile when Local State is malformed JSON', async () => {
      await writeFile(join(userDataDir, 'Local State'), 'not json {{{');
      await installExt('Default', EXT_ID, '1.0.0', { 'manifest.json': '{}' });
      const found = await intel.findExt(EXT_ID);
      expect(found!.profile).toBe('Default');
    });

    it('falls back to Default when Local State has an empty info_cache', async () => {
      await writeLocalState([]);
      await installExt('Default', EXT_ID, '1.0.0', { 'manifest.json': '{}' });
      const found = await intel.findExt(EXT_ID);
      expect(found!.profile).toBe('Default');
    });

    it('throws a helpful error when no Chromium User Data dir can be detected', async () => {
      delete process.env.YAUTJA_CHROME_USER_DATA;
      process.env.LOCALAPPDATA = join(workDir, 'empty-local-appdata');
      const fresh = new ExtensionIntel();
      await expect(fresh.findExt(EXT_ID)).rejects.toThrow(
        /User Data directory not found.*YAUTJA_CHROME_USER_DATA/s,
      );
    });
  });

  // ─── readManifest ──────────────────────────────────────────

  describe('readManifest', () => {
    it('reads and parses manifest.json', async () => {
      const manifest = { manifest_version: 3, name: 'Test Ext', permissions: ['storage'] };
      await installExt('Default', EXT_ID, '1.0.0', {
        'manifest.json': JSON.stringify(manifest),
      });
      expect(await intel.readManifest(EXT_ID)).toEqual(manifest);
    });

    it('throws a not-found error for an unknown extension', async () => {
      await expect(intel.readManifest(EXT_ID)).rejects.toThrow(
        /not found on disk.*YAUTJA_CHROME_USER_DATA/s,
      );
    });

    it('propagates a SyntaxError for a malformed manifest.json', async () => {
      await installExt('Default', EXT_ID, '1.0.0', { 'manifest.json': '{broken' });
      await expect(intel.readManifest(EXT_ID)).rejects.toThrow(SyntaxError);
    });
  });

  // ─── readSource / listSourceFiles ──────────────────────────

  describe('readSource', () => {
    it('reads a file from the extension version directory', async () => {
      await installExt('Default', EXT_ID, '1.0.0', {
        'manifest.json': '{}',
        'background.js': 'console.log("hi");',
      });
      expect(await intel.readSource(EXT_ID, 'background.js')).toBe('console.log("hi");');
    });

    it('reads a nested file path', async () => {
      await installExt('Default', EXT_ID, '1.0.0', {
        'manifest.json': '{}',
        'src/lib/util.js': 'export const x = 1;',
      });
      expect(await intel.readSource(EXT_ID, join('src', 'lib', 'util.js'))).toBe(
        'export const x = 1;',
      );
    });

    it('throws when the extension is not found', async () => {
      await expect(intel.readSource(EXT_ID, 'x.js')).rejects.toThrow(/not found on disk/);
    });

    it('propagates ENOENT when the file does not exist in a found extension', async () => {
      await installExt('Default', EXT_ID, '1.0.0', { 'manifest.json': '{}' });
      await expect(intel.readSource(EXT_ID, 'missing.js')).rejects.toThrow();
    });
  });

  describe('listSourceFiles', () => {
    it('lists only top-level files, excluding directories', async () => {
      await installExt('Default', EXT_ID, '1.0.0', {
        'manifest.json': '{}',
        'background.js': '',
        'popup.html': '',
        'src/nested.js': '',
      });
      const files = await intel.listSourceFiles(EXT_ID);
      expect(files.sort()).toEqual(['background.js', 'manifest.json', 'popup.html']);
      expect(files).not.toContain('src');
    });

    it('throws when the extension is not found', async () => {
      await expect(intel.listSourceFiles(EXT_ID)).rejects.toThrow(/not found on disk/);
    });
  });

  // ─── readStorage (LevelDB) ─────────────────────────────────

  describe('readStorage', () => {
    beforeEach(async () => {
      // Storage lives next to the profile where the extension was found.
      await installExt('Default', EXT_ID, '1.0.0', { 'manifest.json': '{}' });
    });

    it('unwraps Chrome-wrapped values and cleans the !extdb. key prefix', async () => {
      await createStorageDb('Default', EXT_ID, [
        ['!extdb.count', JSON.stringify({ origin: 'normal', value: 42 })],
        ['!extdb.settings', JSON.stringify({ origin: 'normal', value: { theme: 'dark' } })],
      ]);
      const storage = await intel.readStorage(EXT_ID);
      expect(storage).toEqual({ count: 42, settings: { theme: 'dark' } });
    });

    it('keeps plain (non-prefixed) keys as-is', async () => {
      await createStorageDb('Default', EXT_ID, [
        ['plain', JSON.stringify({ origin: 'normal', value: 'v' })],
      ]);
      const storage = await intel.readStorage(EXT_ID);
      expect(storage).toEqual({ plain: 'v' });
    });

    it('keeps the whole parsed object when there is no .value wrapper', async () => {
      await createStorageDb('Default', EXT_ID, [
        ['!extdb.raw', JSON.stringify({ a: 1, b: 'two' })],
      ]);
      const storage = await intel.readStorage(EXT_ID);
      expect(storage).toEqual({ raw: { a: 1, b: 'two' } });
    });

    it('keeps non-JSON values as raw strings', async () => {
      await createStorageDb('Default', EXT_ID, [['!extdb.note', 'not json at all']]);
      const storage = await intel.readStorage(EXT_ID);
      expect(storage).toEqual({ note: 'not json at all' });
    });

    it('treats a JSON null wrapper value as "no wrapper" (value !== undefined check)', async () => {
      // parsed.value is null → not undefined → unwraps to null
      await createStorageDb('Default', EXT_ID, [
        ['!extdb.k', JSON.stringify({ origin: 'normal', value: null })],
      ]);
      const storage = await intel.readStorage(EXT_ID);
      expect(storage).toEqual({ k: null });
    });

    it('filters to a single key when requested (matched via cleaned key)', async () => {
      await createStorageDb('Default', EXT_ID, [
        ['!extdb.wanted', JSON.stringify({ value: 'yes' })],
        ['!extdb.other', JSON.stringify({ value: 'no' })],
      ]);
      const storage = await intel.readStorage(EXT_ID, 'wanted');
      expect(storage).toEqual({ wanted: 'yes' });
    });

    it('filters to a single key when requested (matched via raw key)', async () => {
      await createStorageDb('Default', EXT_ID, [
        ['!extdb.wanted', JSON.stringify({ value: 'yes' })],
        ['plain-other', JSON.stringify({ value: 'no' })],
      ]);
      const storage = await intel.readStorage(EXT_ID, '!extdb.wanted');
      expect(storage).toEqual({ wanted: 'yes' });
    });

    it('returns an empty object when the requested key does not exist', async () => {
      await createStorageDb('Default', EXT_ID, [['!extdb.a', JSON.stringify({ value: 1 })]]);
      const storage = await intel.readStorage(EXT_ID, 'missing');
      expect(storage).toEqual({});
    });

    it('reads storage from the same profile where the extension was found', async () => {
      // Remove the Default-profile install from the shared beforeEach so the
      // extension is only found in Profile 1.
      await rm(join(userDataDir, 'Default', 'Extensions', EXT_ID), {
        recursive: true,
        force: true,
      });
      await writeLocalState(['Default', 'Profile 1']);
      await installExt('Profile 1', EXT_ID, '1.0.0', { 'manifest.json': '{}' });
      await createStorageDb('Profile 1', EXT_ID, [
        ['!extdb.p1key', JSON.stringify({ value: 'from-profile-1' })],
      ]);
      const storage = await intel.readStorage(EXT_ID);
      expect(storage).toEqual({ p1key: 'from-profile-1' });
    });

    it('throws a descriptive error when the extension has no storage on disk', async () => {
      await expect(intel.readStorage(EXT_ID)).rejects.toThrow(
        `Extension ${EXT_ID} has no local storage on disk`,
      );
    });

    it('throws a not-found error for an unknown extension', async () => {
      await expect(intel.readStorage('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).rejects.toThrow(
        /not found on disk/,
      );
    });

    it('cleans up its temporary LevelDB copy after reading', async () => {
      await createStorageDb('Default', EXT_ID, [['!extdb.a', JSON.stringify({ value: 1 })]]);
      await intel.readStorage(EXT_ID);
      const leftovers = (await readdir(tmpdir())).filter((f) =>
        f.startsWith(`yautja-ext-${EXT_ID}-`),
      );
      expect(leftovers).toEqual([]);
    });

    it('cleans up its temporary directory even when opening the DB fails', async () => {
      // Storage dir exists but contains a corrupt MANIFEST → ClassicLevel.open() throws.
      const dbPath = join(userDataDir, 'Default', 'Local Extension Settings', EXT_ID);
      await mkdir(dbPath, { recursive: true });
      await writeFile(join(dbPath, 'CURRENT'), 'MANIFEST-000001\n');
      await writeFile(join(dbPath, 'MANIFEST-000001'), 'garbage not a manifest');
      await expect(intel.readStorage(EXT_ID)).rejects.toThrow();
      const leftovers = (await readdir(tmpdir())).filter((f) =>
        f.startsWith(`yautja-ext-${EXT_ID}-`),
      );
      expect(leftovers).toEqual([]);
    });
  });
});
