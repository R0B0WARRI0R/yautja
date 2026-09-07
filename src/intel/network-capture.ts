import fs from 'fs';
import path from 'path';

export interface CapturedRequest {
  id: string;
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  status?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  timestamp: number;
  durationMs?: number;
  size?: number;
  matches?: string[];
}

const CAPTURE_DIR = path.join(process.env.APPDATA || process.env.HOME || '/tmp', '.yautja-network-captures');
const MAX_BODY_SIZE = 1024 * 1024;
const REDACTED = '[REDACTED]';
function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return /(?:password|passwd|passphrase|secret|token|apikey|authorization|cookie|credentials?|sessionid|csrftoken|xsrf|clientintegrity)/.test(normalized)
    || ['code', 'otp', 'pin', 'pwd'].includes(normalized);
}

function mask(value: unknown): string {
  // Preserve an existing pattern label, but never a partially redacted secret.
  return typeof value === 'string' && /^\[REDACTED(?::[^\]\r\n]+)?\]$/.test(value) ? value : REDACTED;
}

function redactFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactFields);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) =>
      [key, sensitiveKey(key) ? mask(child) : redactFields(child)]));
  }
  return value;
}

function redactParams(text: string): string {
  const params = new URLSearchParams(text);
  let changed = false;
  for (const key of new Set(params.keys())) {
    if (sensitiveKey(key)) { params.set(key, REDACTED); changed = true; }
  }
  return changed ? params.toString() : text;
}

function redactUrl(text: string): string {
  try {
    const url = new URL(text);
    if (url.username) url.username = REDACTED;
    if (url.password) url.password = REDACTED;
    url.search = redactParams(url.search.slice(1));
    // OAuth implicit flows and hash-router query strings can carry credentials.
    const hash = url.hash.slice(1);
    const queryAt = hash.indexOf('?');
    url.hash = queryAt >= 0 ? hash.slice(0, queryAt + 1) + redactParams(hash.slice(queryAt + 1)) : redactParams(hash);
    return url.toString();
  } catch {
    return text.replace(/([?&#])([^?&#]+)/g, (_match, separator: string, params: string) => separator + redactParams(params));
  }
}
const PATTERNS = [
  { name: 'JWT', regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'AWS Key', regex: /AKIA[0-9A-Z]{16}/g },
  { name: 'Google API', regex: /AIza[A-Za-z0-9_-]{35}/g },
  { name: 'GitHub Token', regex: /(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g },
  { name: 'Stripe Key', regex: /(sk|pk)_(test|live)_[A-Za-z0-9]{24,}/g },
  { name: 'Bearer Token', regex: /Bearer\s+[A-Za-z0-9_-]{20,}/g },
  { name: 'Email', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { name: 'Credit Card', regex: /\b(?:\d[ -]*?){13,16}\b/g },
  { name: 'Phone (ES)', regex: /(?:\+34\s?)?[6789]\d{2}\s?\d{2}\s?\d{2}\s?\d{2}/g },
  { name: 'Spanish DNI', regex: /\b\d{8}[A-Z]\b/g },
  { name: 'IBAN', regex: /ES\d{2}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}/g },
  { name: 'JWT in cookie', regex: /[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g },
  { name: 'OAuth Code', regex: /[?&]code=[A-Za-z0-9_-]{20,}/g },
];

export interface Transport {
  send(method: string, params?: Record<string, any>): Promise<any>;
  getCurrentTabId?(): number | null;
  getGeneration?(): string;
  getDocumentEpoch?(tabId: number): number;
  sendToTab?(tabId: number, generation: string, method: string, params?: Record<string, any>): Promise<any>;
}

export class NetworkCapture {
  private transport: Transport;
  private buffers = new Map<string, Map<string, CapturedRequest>>();
  private get requests(): Map<string, CapturedRequest> {
    const tabId = this.transport.getCurrentTabId?.() ?? 0;
    const key = `${this.transport.getGeneration?.() ?? ''}:${tabId}:${this.transport.getDocumentEpoch?.(tabId) ?? 0}`;
    if (!this.buffers.has(key)) {
      this.buffers.set(key, new Map());
      if (this.buffers.size > 8) this.buffers.delete(this.buffers.keys().next().value!);
    }
    return this.buffers.get(key)!;
  }
  private active = false;

  constructor(transport: Transport) {
    this.transport = transport;
    try { if (!fs.existsSync(CAPTURE_DIR)) fs.mkdirSync(CAPTURE_DIR, { recursive: true }); } catch {}
  }

  isActive(): boolean { return this.active; }
  setActive(v: boolean): void { this.active = v; }

  private sendBodyCommand(method: string, requestId: string): Promise<any> {
    const tabId = this.transport.getCurrentTabId?.();
    const generation = this.transport.getGeneration?.();
    if (tabId != null && generation && this.transport.sendToTab) {
      return this.transport.sendToTab(tabId, generation, method, { requestId });
    }
    return this.transport.send(method, { requestId });
  }

  async captureAndAttachResponseBody(requestId: string): Promise<void> {
    const buffer = this.requests;
    const request = buffer.get(requestId);
    if (!request) return;
    const response = await this.captureResponseBody(requestId);
    // Pin the record too: a clear/navigation or reused request id invalidates it.
    if (!response || buffer.get(requestId) !== request) return;
    request.responseBody = response.body;
    request.size = response.body.length;
    request.matches = this.detectPatterns(response.body);
  }

  async captureRequestBody(requestId: string): Promise<string | null> {
    try {
      const r = await this.sendBodyCommand('Network.getRequestPostData', requestId);
      return r?.postData?.substring(0, MAX_BODY_SIZE) || null;
    } catch { return null; }
  }

  async captureResponseBody(requestId: string): Promise<{ body: string; isBase64: boolean } | null> {
    try {
      const r = await this.sendBodyCommand('Network.getResponseBody', requestId);
      if (!r?.body) return null;
      const body = r.body.substring(0, MAX_BODY_SIZE);
      return { body, isBase64: !!r.base64Encoded };
    } catch { return null; }
  }

  storeRequest(req: CapturedRequest): void {
    this.requests.set(req.id, req);
    if (this.requests.size > 500) this.requests.delete(this.requests.keys().next().value!);
    if (this.active) this.appendToFile(req);
  }

  updateRequestStatus(requestId: string, status: number, headers: Record<string, string>): void {
    const r = this.requests.get(requestId);
    if (r) {
      r.status = status;
      r.responseHeaders = headers;
      r.durationMs = Date.now() - r.timestamp;
    }
  }

  attachBodyToRequest(requestId: string, type: 'request' | 'response', body: string): void {
    const r = this.requests.get(requestId);
    if (!r) return;
    if (type === 'request') r.requestBody = body;
    else r.responseBody = body;
    r.size = body.length;
    r.matches = this.detectPatterns(body);
  }

  detectPatterns(text: string): string[] {
    if (!text) return [];
    const found = new Set<string>();
    for (const p of PATTERNS) {
      p.regex.lastIndex = 0;
      let m;
      while ((m = p.regex.exec(text)) !== null) {
        found.add(p.name);
        if (m.index === p.regex.lastIndex) p.regex.lastIndex++;
      }
    }
    return Array.from(found);
  }

  /** Redact bodies and sensitive headers before they cross the MCP boundary. */
  redactForOutput(req: CapturedRequest): CapturedRequest {
    return {
      ...req,
      url: redactUrl(req.url),
      requestHeaders: this.sanitizeHeaders(req.requestHeaders) ?? {},
      responseHeaders: this.sanitizeHeaders(req.responseHeaders),
      requestBody: req.requestBody === undefined ? undefined : this.redactBody(req.requestBody),
      responseBody: req.responseBody === undefined ? undefined : this.redactBody(req.responseBody),
    };
  }

  redactBody(text: string): string {
    let out = text;
    for (const pattern of PATTERNS) {
      pattern.regex.lastIndex = 0;
      out = out.replace(pattern.regex, `[REDACTED:${pattern.name}]`);
    }
    try {
      return JSON.stringify(redactFields(JSON.parse(out)));
    } catch {
      // Captures can be truncated or non-JSON. Handle complete/truncated scalar
      // JSON fields too, without relying on the secret's format or length.
      out = out.replace(/("(?:\\.|[^"\\])*")\s*:\s*("(?:\\.|[^"\\])*(?:"|$)|[^,}\]\r\n]+)/g,
        (match, key: string, value: string) => {
          try { return sensitiveKey(JSON.parse(key)) ? `${key}:${JSON.stringify(mask(value))}` : match; }
          catch { return match; }
        });
    }
    if (/^[^=&\s]+=[^\r\n]*$/.test(out)) out = redactParams(out);
    out = out.replace(/(Content-Disposition:[^\r\n]*\bname="([^"]+)"[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n)([\s\S]*?)(?=\r?\n--[^\r\n]+|$)/gi,
      (match, prefix: string, name: string) => sensitiveKey(name) ? prefix + REDACTED : match);
    return out;
  }

  list(filters?: { urlPattern?: string; method?: string; hasMatches?: boolean; statusMin?: number; statusMax?: number; limit?: number }): CapturedRequest[] {
    let result = Array.from(this.requests.values());
    if (filters) {
      if (filters.urlPattern) result = result.filter(r => r.url.includes(filters.urlPattern!));
      if (filters.method) result = result.filter(r => r.method === filters.method);
      if (filters.hasMatches) result = result.filter(r => r.matches && r.matches.length > 0);
      if (filters.statusMin !== undefined) result = result.filter(r => (r.status || 0) >= filters.statusMin!);
      if (filters.statusMax !== undefined) result = result.filter(r => (r.status || 0) <= filters.statusMax!);
    }
    result.sort((a, b) => b.timestamp - a.timestamp);
    if (filters?.limit) result = result.slice(0, filters.limit);
    return result;
  }

  clear(): void { this.requests.clear(); }

  getAllRequests(): CapturedRequest[] {
    return Array.from(this.requests.values());
  }

  stats(): { total: number; withBody: number; withMatches: number; uniqueMatches: Set<string> } {
    const all = Array.from(this.requests.values());
    const withBody = all.filter(r => r.requestBody || r.responseBody);
    const withMatches = all.filter(r => r.matches && r.matches.length > 0);
    const uniqueMatches = new Set<string>();
    for (const r of withMatches) r.matches!.forEach(m => uniqueMatches.add(m));
    return { total: all.length, withBody: withBody.length, withMatches: withMatches.length, uniqueMatches };
  }

  private appendToFile(req: CapturedRequest): void {
    try {
      const date = new Date(req.timestamp).toISOString().split('T')[0];
      const file = path.join(CAPTURE_DIR, `capture-${date}.jsonl`);
      const sanitized = this.redactForOutput(req);
      fs.appendFileSync(file, JSON.stringify(sanitized) + '\n');
    } catch {}
  }

  private sanitizeHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!headers) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      out[k] = sensitiveKey(k) ? REDACTED
        : ['location', 'referer', 'referrer', 'content-location'].includes(k.toLowerCase()) ? redactUrl(v) : v;
    }
    return out;
  }

  listFiles(): string[] {
    try {
      return fs.readdirSync(CAPTURE_DIR).filter(f => f.endsWith('.jsonl'));
    } catch { return []; }
  }
}
