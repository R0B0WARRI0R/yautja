import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import type { MacroRunner } from './runner.js';
import type { MacroDef } from './types.js';

const BUILTIN_EXCLUDES = new Set(['runner.js', 'types.js', 'index.js', 'loader.js']);

export interface LoadResult {
  loaded: string[];
  skipped: string[];
}

function resolveBuiltinDir(): string {
  if (process.env.YAUTJA_BUILTIN_DIR) return process.env.YAUTJA_BUILTIN_DIR;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'macros');
}

async function importMacro(file: string, cacheBust = false): Promise<MacroDef> {
  let url = pathToFileURL(file).href;
  if (cacheBust) {
    const stat = fs.statSync(file);
    url += `?v=${stat.mtimeMs}`;
  }
  const mod = await import(url);
  return mod.default as MacroDef;
}

function isValidMacro(def: unknown): def is MacroDef {
  return !!def
    && typeof def === 'object'
    && typeof (def as any).name === 'string'
    && typeof (def as any).description === 'string'
    && typeof (def as any).run === 'function';
}

export async function loadBuiltins(runner: MacroRunner): Promise<LoadResult> {
  const dir = resolveBuiltinDir();
  const result: LoadResult = { loaded: [], skipped: [] };
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !BUILTIN_EXCLUDES.has(f));
  } catch {
    return result;
  }
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const def = await importMacro(full, false);
      if (!isValidMacro(def)) {
        process.stderr.write(`[Yautja] builtin macro ${f}: invalid shape\n`);
        result.skipped.push(f);
        continue;
      }
      runner.register(def, 'builtin');
      result.loaded.push(def.name);
    } catch (err) {
      process.stderr.write(`[Yautja] builtin macro ${f}: ${err instanceof Error ? err.message : String(err)}\n`);
      result.skipped.push(f);
    }
  }
  return result;
}

export function resolveUserDir(): string {
  if (process.env.YAUTJA_USER_DIR) return process.env.YAUTJA_USER_DIR;
  return path.join(process.env.APPDATA || process.env.HOME || '/tmp', '.yautja-macros');
}

export async function loadUserMacros(runner: MacroRunner): Promise<LoadResult> {
  const dir = resolveUserDir();
  const result: LoadResult = { loaded: [], skipped: [] };

  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    process.stderr.write(`[Yautja] cannot create user macro dir ${dir}: ${err}\n`);
    return result;
  }

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !f.startsWith('.'));
  } catch {
    return result;
  }

  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const def = await importMacro(full, true);
      if (!isValidMacro(def)) {
        process.stderr.write(`[Yautja] user macro ${f}: invalid shape\n`);
        result.skipped.push(f);
        continue;
      }
      runner.register(def, 'user', full);
      result.loaded.push(def.name);
    } catch (err) {
      process.stderr.write(`[Yautja] user macro ${f}: ${err instanceof Error ? err.message : String(err)}\n`);
      result.skipped.push(f);
    }
  }
  return result;
}