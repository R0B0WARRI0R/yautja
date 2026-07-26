/**
 * HAR export (P15) — HAR 1.2-compatible export of NetworkCapture entries.
 *
 * - Redaction by default: sensitive request/response headers dropped,
 *   bodies scrubbed of secret patterns (same scrubber as browserFetch).
 * - Large bodies (> INLINE_LIMIT) are replaced by a sha256 stub — the HAR
 *   stays portable, nothing is silently truncated.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { scrubSecrets } from './browser-fetch.js';
import type { CapturedRequest } from './network-capture.js';

const INLINE_LIMIT = 64 * 1024;

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
]);

export interface HarExportOptions {
  redact?: boolean;
  urlIncludes?: string;
  method?: string;
  sinceMs?: number;
}

function headerList(headers: Record<string, string> | undefined, redact: boolean): Array<{ name: string; value: string }> {
  return Object.entries(headers ?? {})
    .filter(([name]) => !redact || !SENSITIVE_HEADERS.has(name.toLowerCase()))
    .map(([name, value]) => ({ name, value }));
}

function contentOf(body: string | undefined, mimeType: string, redact: boolean): { size: number; mimeType: string; text?: string; comment?: string } {
  if (!body) {
    // Edge cases (P17): cached responses, streamed/SSE bodies, and service
    // worker responses have no capturable body — say so, don't fake empty.
    return { size: 0, mimeType, comment: 'no body captured (cached, streamed, or service worker)' };
  }
  const scrubbed = redact ? scrubSecrets(body) : body;
  if (scrubbed.length > INLINE_LIMIT) {
    const sha = crypto.createHash('sha256').update(scrubbed).digest('hex');
    return { size: scrubbed.length, mimeType, comment: `body externalized: sha256:${sha}` };
  }
  return { size: scrubbed.length, mimeType, text: scrubbed };
}

function mimeOf(headers: Record<string, string> | undefined): string {
  const ct = headers?.['content-type'] ?? headers?.['Content-Type'] ?? '';
  return ct.split(';')[0] || 'application/octet-stream';
}

export function buildHar(entries: CapturedRequest[], opts: { redact: boolean }): Record<string, any> {
  const { redact } = opts;
  return {
    log: {
      version: '1.2',
      creator: { name: 'yautja', version: '0.2.0' },
      entries: entries.map((e) => ({
        startedDateTime: new Date(e.timestamp).toISOString(),
        time: e.durationMs ?? 0,
        request: {
          method: e.method,
          url: e.url,
          httpVersion: 'HTTP/1.1',
          headers: headerList(e.requestHeaders, redact),
          cookies: [],
          queryString: [],
          headersSize: -1,
          bodySize: e.requestBody?.length ?? 0,
          ...(e.requestBody
            ? { postData: { mimeType: mimeOf(e.requestHeaders), text: redact ? scrubSecrets(e.requestBody) : e.requestBody } }
            : {}),
        },
        response: {
          status: e.status ?? 0,
          statusText: '',
          httpVersion: 'HTTP/1.1',
          headers: headerList(e.responseHeaders, redact),
          cookies: [],
          content: contentOf(e.responseBody, mimeOf(e.responseHeaders), redact),
          redirectURL: '',
          headersSize: -1,
          bodySize: e.responseBody?.length ?? 0,
        },
        cache: {},
        timings: { send: 0, wait: e.durationMs ?? 0, receive: 0 },
      })),
    },
  };
}

export function filterEntries(entries: CapturedRequest[], opts: HarExportOptions): CapturedRequest[] {
  return entries.filter((e) => {
    if (opts.urlIncludes && !e.url.includes(opts.urlIncludes)) return false;
    if (opts.method && e.method.toUpperCase() !== opts.method.toUpperCase()) return false;
    if (opts.sinceMs && e.timestamp < Date.now() - opts.sinceMs) return false;
    return true;
  });
}

export function exportHarToFile(
  entries: CapturedRequest[],
  destDir: string,
  host: string,
  opts: HarExportOptions,
): { path: string; entries: number; bytes: number } {
  const filtered = filterEntries(entries, opts);
  const har = buildHar(filtered, { redact: opts.redact !== false });
  const content = JSON.stringify(har, null, 2);
  fs.mkdirSync(destDir, { recursive: true });
  const file = path.join(destDir, `${Date.now()}-${host || 'capture'}.har`);
  fs.writeFileSync(file, content);
  return { path: file, entries: filtered.length, bytes: Buffer.byteLength(content) };
}
