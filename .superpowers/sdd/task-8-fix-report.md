# Task 8 Fix Report

## Status
DONE

## Change
Refactored the harness plumbing in `tests/macros/helmet-integration.test.ts` to match the `Object.defineProperty(process, 'stdout', ...)` pattern from `tests/helmet.test.ts:91-92`, eliminating the race condition between the two test files.

**Harness plumbing changes:**

1. **Imports** — added `Writable` alongside `Readable`:
   ```ts
   import { Readable, Writable } from 'stream';
   ```

2. **`spawn()`** — replaced `process.stdout.write = ...` monkey-patch with a `Writable` capture stream + `Object.defineProperty(process, 'stdout', { value: capturedStream, configurable: true })`. The captured stream writes chunks into the `out[]` array via its `write()` handler. Stdin capture is also consolidated into `defineProperty` for symmetry.

3. **`teardown()`** — both `stdin` and `stdout` are now restored via `Object.defineProperty` to the originals captured during `spawn()`, removing the `process.stdout.write = orig` reassignment.

4. **`send()`** — already used `stdin.push()` and async polling; preserved as-is.

**Test bodies** — all 4 `it()` blocks (lines 77–104) are byte-identical to before. Only the plumbing layer changed.

## Verification
- Integration test in isolation: **4/4 pass**
- Full suite: **16 failures** (exactly matches baseline `fa8539c` — the 4 integration tests now pass alongside the 16 pre-existing `helmet.test.ts` failures)
- tsc: **0 errors**

## Race condition resolved
Yes — confirmed by full-suite run. The integration test file no longer assigns to `process.stdout.write` directly; it uses the same `Object.defineProperty(process, 'stdout', { value, configurable: true })` pattern as `helmet.test.ts`. Both files now operate on `process.stdout` via the same descriptor mechanism, eliminating the conflict between monkey-patched write and replaced stream value that previously caused 4 race-dependent new failures (16 → 20).
