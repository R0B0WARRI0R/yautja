import type { Transport } from './base-sensor.js';

export type RequestStage = 'Request' | 'Response';

export interface InterceptRule {
  id: string;
  enabled: boolean;
  urlPattern: string;
  urlRegex?: string;
  method?: string;
  resourceTypes?: string[];
  stage: RequestStage;
  action: InterceptAction;
  hitCount: number;
  createdAt: number;
}

export type InterceptAction =
  | { type: 'modify'; headers?: Record<string, string>; setCookies?: string[]; body?: string }
  | { type: 'block'; reason?: string }
  | { type: 'mock'; status: number; body: string; contentType?: string; headers?: Record<string, string> }
  | { type: 'redirect'; url: string }
  | { type: 'log'; captureBody?: boolean };

export interface InterceptLog {
  ruleId: string;
  requestId: string;
  url: string;
  method: string;
  stage: RequestStage;
  action: string;
  status?: number;
  requestBody?: string;
  responseBody?: string;
  timestamp: number;
}

export class Interceptor {
  private transport: Transport;
  private rules: Map<string, InterceptRule> = new Map();
  private active = false;
  private log: InterceptLog[] = [];
  private maxLog = 200;
  private pendingBodies: Map<string, { url: string; method: string }> = new Map();

  constructor(transport: Transport) {
    this.transport = transport;
  }

  async enable(): Promise<void> {
    if (this.active) return;
    this.active = true;
    await this.transport.send('Fetch.enable', {
      patterns: [
        { requestStage: 'Request' },
        { requestStage: 'Response' },
      ],
    });
    this.transport.on('Fetch.requestPaused', (p: any) => this.onRequestPaused(p));
  }

  async disable(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    await this.transport.send('Fetch.disable');
    this.rules.clear();
    this.log = [];
    this.pendingBodies.clear();
  }

  isActive(): boolean {
    return this.active;
  }

  addRule(rule: Omit<InterceptRule, 'hitCount' | 'createdAt'>): InterceptRule {
    const full: InterceptRule = {
      ...rule,
      stage: rule.stage || 'Request',
      hitCount: 0,
      createdAt: Date.now(),
    };
    this.rules.set(rule.id, full);
    return full;
  }

  removeRule(id: string): boolean {
    return this.rules.delete(id);
  }

  clearRules(): void {
    this.rules.clear();
  }

  listRules(): InterceptRule[] {
    return Array.from(this.rules.values());
  }

  getLogs(limit?: number): InterceptLog[] {
    const n = limit ?? this.log.length;
    return this.log.slice(-n);
  }

  private async onRequestPaused(p: any): Promise<void> {
    const requestId: string = p.requestId;
    const url: string = p.request?.url || p.request?.url || '';
    const method: string = p.request?.method || 'GET';
    const isResponse = !!p.responseStatusCode || !!p.responseErrorReason;
    const stage: RequestStage = isResponse ? 'Response' : 'Request';

    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;
      if (rule.stage !== stage) continue;
      if (!this.matchesRule(rule, url, method)) continue;

      rule.hitCount++;

      const entry: InterceptLog = {
        ruleId: rule.id,
        requestId,
        url,
        method,
        stage,
        action: rule.action.type,
        status: p.responseStatusCode,
        timestamp: Date.now(),
      };

      if (rule.action.type === 'log' && rule.action.captureBody) {
        if (isResponse) {
          try {
            const bodyResp = await this.transport.send('Fetch.getResponseBody', { requestId });
            entry.responseBody = this.decodeBody(bodyResp);
          } catch {}
        } else {
          entry.requestBody = p.request?.postData;
        }
      }

      this.log.push(entry);
      if (this.log.length > this.maxLog) this.log.shift();

      try {
        switch (rule.action.type) {
          case 'modify': {
            if (isResponse) {
              const originalHeaders = (p.responseHeaders || {}) as Record<string, string>;
              const overrides = rule.action.headers || {};
              const merged = { ...originalHeaders, ...overrides };
              const headerEntries = Object.entries(merged).map(([name, value]) => ({ name, value }));
              let bodyB64: string | undefined;
              if (rule.action.body) {
                bodyB64 = Buffer.from(rule.action.body).toString('base64');
              } else {
                try {
                  const bodyResp = await this.transport.send('Fetch.getResponseBody', { requestId });
                  bodyB64 = bodyResp.base64Encoded ? bodyResp.body : Buffer.from(bodyResp.body).toString('base64');
                } catch {}
              }
              await this.transport.send('Fetch.fulfillRequest', {
                requestId,
                responseCode: p.responseStatusCode || 200,
                responseHeaders: headerEntries,
                body: bodyB64,
              });
            } else {
              const originalHeaders = (p.request?.headers || {}) as Record<string, string>;
              const overrides = rule.action.headers || {};
              const merged = { ...originalHeaders, ...overrides };
              const headerEntries = Object.entries(merged).map(([name, value]) => ({ name, value }));
              await this.transport.send('Fetch.continueRequest', {
                requestId,
                headers: headerEntries.length > 0 ? headerEntries : undefined,
                postData: rule.action.body ? Buffer.from(rule.action.body).toString('base64') : undefined,
              });
            }
            return;
          }
          case 'block': {
            await this.transport.send('Fetch.failRequest', {
              requestId,
              errorReason: rule.action.reason || 'Failed',
            });
            return;
          }
          case 'mock': {
            const bodyB64 = Buffer.from(rule.action.body).toString('base64');
            const responseHeaders = rule.action.headers
              ? Object.entries(rule.action.headers).map(([name, value]) => ({ name, value }))
              : [{ name: 'Content-Type', value: rule.action.contentType || 'application/json' }];
            await this.transport.send('Fetch.fulfillRequest', {
              requestId,
              responseCode: rule.action.status,
              body: bodyB64,
              responseHeaders,
            });
            return;
          }
          case 'redirect': {
            await this.transport.send('Fetch.continueRequest', {
              requestId,
              url: rule.action.url,
            });
            return;
          }
          case 'log': {
            if (isResponse) {
              await this.transport.send('Fetch.continueResponse', { requestId });
            } else {
              await this.transport.send('Fetch.continueRequest', { requestId });
            }
            return;
          }
        }
      } catch {
        // Fall through to passthrough
      }
      return;
    }

    try {
      if (isResponse) {
        await this.transport.send('Fetch.continueResponse', { requestId });
      } else {
        await this.transport.send('Fetch.continueRequest', { requestId });
      }
    } catch {}
  }

  private matchesRule(rule: InterceptRule, url: string, method: string): boolean {
    if (rule.urlRegex) {
      const re = new RegExp(rule.urlRegex, 'i');
      if (!re.test(url)) return false;
    } else if (!url.includes(rule.urlPattern)) {
      return false;
    }
    if (rule.method && rule.method.toUpperCase() !== method.toUpperCase()) return false;
    return true;
  }

  private decodeBody(resp: any): string {
    if (!resp) return '';
    if (resp.base64Encoded) {
      try { return Buffer.from(resp.body, 'base64').toString('utf8'); } catch { return '[binary]'; }
    }
    return resp.body || '';
  }
}
