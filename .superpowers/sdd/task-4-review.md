# Task 4 Review

## A. Spec compliance: ✅ PASS

All exported symbols, helpers, exclusion rules, and helper contracts from the brief are present and byte-accurate:

- `loadBuiltins(runner: MacroRunner): Promise<LoadResult>` exported
- `LoadResult` interface exported with `loaded: string[]` and `skipped: string[]`
- `BUILTIN_EXCLUDES` is `Set(['runner.js', 'types.js', 'index.js', 'loader.js'])`
- `resolveBuiltinDir` checks `process.env.YAUTJA_BUILTIN_DIR` first, else falls back to `import.meta.url`-based resolution
- `importMacro(file, cacheBust)` helper present with cache-bust branch
- `isValidMacro` validates `name` (string), `description` (string), `run` (function) with proper type-guard narrowing
- 4 tests present, matching brief names and assertions (loads valid, skips framework files, malformed→skipped+continues, missing dir silent)
- No `resolveUserDir` / `loadUserMacros` (deferred to Task 5 — verified by grep)
- `run` tool used for initial file creation; `Edit` used to append test cases (XML tool limit workaround — files are byte-identical to brief content)

`npx vitest run tests/macros/loader.test.ts` → **4/4 pass**. `npx tsc --noEmit` → **0 errors**.

## B. Code quality: ⚠️ NEEDS_FIXES

Most quality concerns are met (stderr logging, fail-soft behavior, `path.join` / `pathToFileURL`, no `void` workarounds, valid type guard). However, the `resolveBuiltinDir` default path contains a **silent Windows-only bug**:

### `resolveBuiltinDir` — Windows portability bug

The brief-specified line:
```ts
return path.resolve(new URL('.', import.meta.url).pathname, '..', 'macros');
```

Verification (PowerShell, Node v24.11.1) with a realistic `import.meta.url` value of `file:///D:/Yautja/dist/macros/loader.js`:

| Step | Output |
|---|---|
| `new URL('.', 'file:///D:/Yautja/dist/macros/loader.js').pathname` | `'/D:/Yautja/dist/macros/'` |
| `path.resolve('/D:/Yautja/dist/macros/', '..', 'macros')` | `'C:\\D:\\Yautja\\dist\\macros'` ❌ |

Whereas the canonical Node.js idiom:
```ts
path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'macros')
```
produces `'D:\\Yautja\\dist\\macros'` ✅.

**Root cause:** On Windows, `URL.pathname` for a `file:///` URL yields `/D:/...` with a leading slash. `path.resolve()` treats that leading slash as drive-relative rather than absolute, so it resolves against the current drive (i.e. cwd), producing `<cwd-drive>:\\D:\\Yautja\\dist\\macros` instead of `D:\\Yautja\\dist\\macros`.

**Why tests don't catch it:** The 4 tests always set `process.env.YAUTJA_BUILTIN_DIR` in `beforeEach`, so the env-var branch returns immediately. The default-URL branch is **never executed** under vitest. The bug only surfaces in production when the env var is unset on Windows.

**Severity assessment:** Important, not Critical — the loader fails *silently* (the `try/catch` around `readdirSync` swallows the missing-dir error and returns `{ loaded: [], skipped: [] }`). End user sees zero built-in macros loaded, no log, no crash. Recoverable via setting `YAUTJA_BUILTIN_DIR` env var, or by switching to the `fileURLToPath` idiom.

**Note for controller:** This bug is present in the brief's reference implementation, not introduced by the implementer. The implementer faithfully copied the brief. Recommend either (a) accept this risk and document the `YAUTJA_BUILTIN_DIR` workaround, or (b) patch the loader to use `fileURLToPath` (a one-line change, but a deviation from brief spec — controller should decide).

### Confirmed correct items

- try/catch around `fs.readdirSync` swallows ENOENT/ENOTDIR and returns empty result
- Per-file try/catch records in `skipped`, calls `process.stderr.write`, and continues iteration
- `process.stderr.write` consistent with `SiteMemory` project pattern
- `path.join` used for cross-platform paths
- `pathToFileURL` used for ESM dynamic import
- Cache-bust flag accepted but `false` at the call site (builtins are deterministic) — correct
- Type guard properly narrows `unknown` → `MacroDef`
- No `void this.X;` workarounds needed (the `err` parameter is consumed inside the catch)

## Issues

- **[Important] Windows default-directory resolution broken.** `path.resolve(new URL('.', import.meta.url).pathname, '..', 'macros')` produces a cwd-prefixed malformed path on Windows (e.g. `C:\D:\Yautja\dist\macros` instead of `D:\Yautja\dist\macros`). Caused by treating `URL.pathname` (which includes a leading `/` on Windows) directly as a `path.resolve()` input. Fix: use `fileURLToPath(import.meta.url)` before `path.resolve`. **Brief-specified pattern; not an implementer mistake.** Masked by tests because tests always set `YAUTJA_BUILTIN_DIR`.
- **[Minor] Files lack trailing newline.** Diff shows `\ No newline at end of file` for both `src/macros/loader.ts` and `tests/macros/loader.test.ts`. Cosmetic.
- **[Minor] `let files: string[];` declaration style.** Required by the try/catch + return pattern, but could be tightened with an IIFE or early-return refactor. Acceptable.

## Verdict

FIX_REQUIRED
