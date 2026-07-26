/**
 * extractAnswer (P12) — settled, chunked extraction of long answers.
 *
 * Flow: optional settled wait (textSettled + ariaBusy=false via the shared
 * waitForUi engine) → in-page extraction (clone root, scrub nav/buttons,
 * innerText) → safety cap → chunking for LLM context windows.
 *
 * When `chunkChars > 0`, `text` carries the FIRST chunk and `chunks` the
 * full series — the agent pages through chunks instead of blowing its
 * context on a 20k blob. `length` always reports the total extracted size
 * and `truncated` whether the maxChars safety cap fired (no silent cuts).
 */

import { waitForUi } from './wait-for-ui.js';
import type { Transport } from './wait-for-ui.js';

export interface ExtractAnswerDeps {
  transport: Transport;
  getPendingRequests?: () => number;
}

export interface ExtractAnswerOptions {
  root?: string;
  waitUntil?: 'now' | 'settled';
  stableMs?: number;
  chunkChars?: number;
  scrubSelectors?: string[];
  maxChars?: number;
  timeoutMs?: number;
  pollMs?: number;
}

export interface ExtractAnswerResult {
  text: string;
  chunks?: string[];
  length: number;
  waitedMs: number;
  truncated: boolean;
  settled: boolean;
}

const DEFAULT_STABLE_MS = 800;
const DEFAULT_CHUNK_CHARS = 6000;
const DEFAULT_MAX_CHARS = 200_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SCRUB = ['nav', '[role="navigation"]', 'button', '[role="button"]', 'header', 'footer'];

export function buildExtractionScript(root: string, scrubSelectors: string[]): string {
  return `(() => {
  const root = document.querySelector(${JSON.stringify(root)}) || document.querySelector('main') || document.body;
  if (!root) return '';
  const clone = root.cloneNode(true);
  const scrub = ${JSON.stringify(scrubSelectors)};
  for (const s of scrub) {
    try { clone.querySelectorAll(s).forEach((n) => n.remove()); } catch (e) {}
  }
  return (clone.innerText || clone.textContent || '').replace(/\\n{3,}/g, '\\n\\n').trim();
})()`;
}

/** Split text into chunks, preferring paragraph boundaries near the size limit. */
export function chunkText(text: string, size: number): string[] {
  if (size <= 0) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size; // no useful newline → hard cut
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export async function extractAnswer(deps: ExtractAnswerDeps, opts: ExtractAnswerOptions): Promise<ExtractAnswerResult> {
  const started = Date.now();
  const root = opts.root ?? 'main';
  const waitUntil = opts.waitUntil ?? 'now';

  let settled = false;
  if (waitUntil === 'settled') {
    const wait = await waitForUi(deps, {
      allOf: [
        { type: 'textSettled', selector: root, stableMs: opts.stableMs ?? DEFAULT_STABLE_MS },
        { type: 'ariaBusy', root, value: false },
      ],
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      pollMs: opts.pollMs ?? 200,
    });
    settled = wait.matched !== 'timeout';
    // A timeout here is NOT an error: extract what exists and report
    // settled:false so the agent can decide to re-wait or inspect.
  }

  const r = await deps.transport.send('Runtime.evaluate', {
    expression: buildExtractionScript(root, opts.scrubSelectors ?? DEFAULT_SCRUB),
    returnByValue: true,
  });
  const raw = typeof r?.result?.value === 'string' ? r.result.value : '';

  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const truncated = raw.length > maxChars;
  const text = truncated ? raw.slice(0, maxChars) : raw;

  const chunkChars = opts.chunkChars ?? DEFAULT_CHUNK_CHARS;
  const chunks = chunkChars > 0 ? chunkText(text, chunkChars) : undefined;

  return {
    text: chunks ? (chunks[0] ?? '') : text,
    chunks,
    length: text.length,
    waitedMs: Date.now() - started,
    truncated,
    settled: waitUntil === 'settled' ? settled : true,
  };
}
