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
}

export class NetworkCapture {
  private transport: Transport;
  private requests: Map<string, CapturedRequest> = new Map();
  private active = false;

  constructor(transport: Transport) {
    this.transport = transport;
    try { if (!fs.existsSync(CAPTURE_DIR)) fs.mkdirSync(CAPTURE_DIR, { recursive: true }); } catch {}
  }

  isActive(): boolean { return this.active; }
  setActive(v: boolean): void { this.active = v; }

  async captureRequestBody(requestId: string): Promise<string | null> {
    try {
      const r = await this.transport.send('Network.getRequestPostData', { requestId });
      return r?.postData?.substring(0, MAX_BODY_SIZE) || null;
    } catch { return null; }
  }

  async captureResponseBody(requestId: string): Promise<{ body: string; isBase64: boolean } | null> {
    try {
      const r = await this.transport.send('Network.getResponseBody', { requestId });
      if (!r?.body) return null;
      const body = r.body.substring(0, MAX_BODY_SIZE);
      return { body, isBase64: !!r.base64Encoded };
    } catch { return null; }
  }

  storeRequest(req: CapturedRequest): void {
    this.requests.set(req.id, req);
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
      const sanitized: Partial<CapturedRequest> = {
        id: req.id,
        url: req.url,
        method: req.method,
        requestHeaders: this.sanitizeHeaders(req.requestHeaders),
        requestBody: req.requestBody,
        status: req.status,
        responseHeaders: this.sanitizeHeaders(req.responseHeaders),
        responseBody: req.responseBody,
        timestamp: req.timestamp,
        durationMs: req.durationMs,
        size: req.size,
        matches: req.matches,
      };
      fs.appendFileSync(file, JSON.stringify(sanitized) + '\n');
    } catch {}
  }

  private sanitizeHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!headers) return undefined;
    const sensitive = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'client-integrity'];
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      out[k] = sensitive.includes(k.toLowerCase()) ? '[REDACTED]' : v;
    }
    return out;
  }

  listFiles(): string[] {
    try {
      return fs.readdirSync(CAPTURE_DIR).filter(f => f.endsWith('.jsonl'));
    } catch { return []; }
  }
}
