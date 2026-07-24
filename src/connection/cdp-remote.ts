/**
 * CdpRemoteClient — raw CDP-over-WebSocket client for runtime extension inspection.
 *
 * Connects to Chrome's --remote-debugging-port endpoint (default 9222) to
 * access extension service workers that chrome.debugger blocks.
 *
 * This is the ONLY way to do runtime JS evaluation (extEval) in another
 * extension's context without the chrome.debugger cross-extension restriction.
 *
 * Requires Chrome to be launched with --remote-debugging-port=9222.
 */

import { WebSocket } from 'ws';

const CDP_TIMEOUT_MS = 10_000;

export class CdpRemoteClient {
  private port: number;
  private targetCache: Map<string, { url: string; ws: string }> = new Map();
  private cacheTime = 0;

  constructor(port: number = 9222) {
    this.port = port;
  }

  /** Check whether the remote debugging endpoint is reachable. */
  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`http://localhost:${this.port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /** List all CDP targets from the HTTP endpoint. */
  async listTargets(): Promise<CdpRemoteTarget[]> {
    const resp = await fetch(`http://localhost:${this.port}/json`);
    if (!resp.ok) throw new Error(`CDP /json returned ${resp.status}`);
    return (await resp.json()) as CdpRemoteTarget[];
  }

  /**
   * Find the service-worker target for an extension by ID.
   * Caches the target list for 5 seconds to avoid repeated HTTP round-trips.
   */
  async findExtTarget(extId: string): Promise<CdpRemoteTarget | null> {
    await this.refreshCache();
    for (const t of this.targetCache.values()) {
      if (t.url.includes(extId)) {
        // Return a fresh fetch to get the webSocketDebuggerUrl
        const targets = await this.listTargets();
        return (
          targets.find(
            (t) => t.url.includes(extId) && (t.type === 'service_worker' || t.type === 'worker'),
          ) || null
        );
      }
    }
    return null;
  }

  private async refreshCache(): Promise<void> {
    const now = Date.now();
    if (now - this.cacheTime < 5000) return;
    this.cacheTime = now;
    this.targetCache.clear();
    try {
      const targets = await this.listTargets();
      for (const t of targets) {
        this.targetCache.set(t.id, { url: t.url, ws: t.webSocketDebuggerUrl });
      }
    } catch {
      // endpoint not available
    }
  }

  /**
   * Evaluate JavaScript in an extension's service worker context.
   * Connects to the target's WebSocket, sends Runtime.evaluate, closes.
   */
  async evaluate(
    extId: string,
    expression: string,
    awaitPromise = false,
  ): Promise<{ result: any; exceptionDetails: any }> {
    const targets = await this.listTargets();
    const target = targets.find(
      (t) => t.url.includes(extId) && (t.type === 'service_worker' || t.type === 'worker'),
    );
    if (!target) {
      throw new Error(
        `No service worker target for extension ${extId}. ` +
          'Is Chrome running with --remote-debugging-port=9222 and is the extension active?',
      );
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      const timeout = setTimeout(() => {
        ws.terminate();
        reject(new Error('CDP Runtime.evaluate timed out'));
      }, CDP_TIMEOUT_MS);

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, awaitPromise },
          }),
        );
      });

      ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === 1) {
          clearTimeout(timeout);
          ws.close();
          if (msg.error) {
            reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
          } else {
            resolve({
              result: msg.result?.result,
              exceptionDetails: msg.result?.exceptionDetails || null,
            });
          }
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`CDP WebSocket error: ${err.message}`));
      });
    });
  }
}

export interface CdpRemoteTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}
