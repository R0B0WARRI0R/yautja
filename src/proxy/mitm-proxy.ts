import path from 'path';
import fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { createConnection } from 'net';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface CapturedProxyRequest {
  id: string;
  protocol: string;
  url?: string;
  method: string;
  host: string;
  domain?: string;
  port?: number;
  path?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  status?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  mimeType?: string;
  timestamp: number;
  durationMs?: number;
  connected?: boolean;
  error?: string;
}

const MAX_BUFFER = 5000;

export class MitmProxyServer {
  private port: number;
  private running = false;
  private child: ChildProcess | null = null;
  private capturedRequests: CapturedProxyRequest[] = [];
  private scriptPath: string;
  private _pendingResolve: ((value: any) => void) | null = null;

  constructor(port = 9877) {
    this.port = port;
    // Use the standalone proxy script in the project root
    // Try multiple candidate locations since the MCP cwd may differ from the project dir
    const candidates = [
      path.join(process.cwd(), 'Yautja', 'proxy-standalone.cjs'),
      path.join(process.cwd(), 'proxy-standalone.cjs'),
      path.join(__dirname, '..', '..', 'proxy-standalone.cjs'),
      'D:\\Yautja\\proxy-standalone.cjs',
    ];
    this.scriptPath = candidates.find(p => fs.existsSync(p)) || candidates[0];
  }

  async start(): Promise<{ port: number; caCertPath: string }> {
    if (this.running) return { port: this.port, caCertPath: this.getCaCertPath() };

    if (!fs.existsSync(this.scriptPath)) {
      throw new Error(`Proxy script not found: ${this.scriptPath}`);
    }

    // Asignación dinámica: si el puerto base está ocupado (otro helmet/proxy
    // vivo), probar el siguiente hasta 10 candidatos, igual que el WS de la
    // extensión. Así varias instancias de Kimi conviven sin configuración.
    const MAX_ATTEMPTS = 10;
    const basePort = this.port;
    let chosen = -1;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const candidate = basePort + attempt;
      if (!(await this.isPortInUse(candidate))) { chosen = candidate; break; }
    }
    if (chosen === -1) {
      throw new Error(`No free proxy port in range ${basePort}..${basePort + MAX_ATTEMPTS - 1}`);
    }
    if (chosen !== basePort) {
      this.port = chosen;
      process.stderr.write(`[Yautja] Proxy port ${basePort} busy — using ${chosen} instead (auto)\n`);
    }

    return new Promise((resolve, reject) => {
      this.child = spawn(process.execPath, [this.scriptPath], {
        cwd: path.dirname(this.scriptPath),
        env: {
          ...process.env,
          YAUTJA_PROXY_PORT: String(this.port),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('Proxy startup timeout (10s)'));
        }
      }, 10000);

      this.child.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg.includes('Listening on')) {
          this.running = true;
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve({ port: this.port, caCertPath: this.getCaCertPath() });
          }
        }
      });

      // Parse stdout: JSON request lines + RESULT: lines
      let stdoutBuf = '';
      this.child.stdout?.on('data', (data: Buffer) => {
        stdoutBuf += data.toString();
        let idx;
        while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.substring(0, idx).trim();
          stdoutBuf = stdoutBuf.substring(idx + 1);
          if (!line) continue;
          if (line.startsWith('RESULT:')) {
            const json = line.substring(7);
            try {
              const result = JSON.parse(json);
              if (this._pendingResolve) {
                this._pendingResolve(result);
                this._pendingResolve = null;
              }
            } catch {}
          } else {
            // A captured request JSON
            try {
              const req = JSON.parse(line);
              this.capturedRequests.push(req);
              if (this.capturedRequests.length > MAX_BUFFER) {
                this.capturedRequests.splice(0, this.capturedRequests.length - MAX_BUFFER);
              }
            } catch {}
          }
        }
      });

      this.child.on('exit', (code) => {
        this.running = false;
        this.child = null;
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`Proxy exited with code ${code} before startup`));
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.running || !this.child) return;
    return new Promise((resolve) => {
      this.child?.on('exit', () => { this.running = false; this.child = null; resolve(); });
      this.child?.kill('SIGTERM');
      setTimeout(() => {
        if (this.child) { try { this.child.kill('SIGKILL'); } catch {} }
        this.running = false;
        resolve();
      }, 3000);
    });
  }

  isRunning(): boolean { return this.running; }
  getPort(): number { return this.port; }

  getCaCertPath(): string {
    // No CA cert needed — we tunnel HTTPS without interception
    return '';
  }

  hasCaCert(): boolean { return true; }

  async getRequests(filter?: { hostPattern?: string; limit?: number }): Promise<{ requests: CapturedProxyRequest[]; count: number; total: number }> {
    if (!this.child || !this.running) {
      const filtered = filter?.hostPattern
        ? this.capturedRequests.filter(r => (r.host || '').includes(filter.hostPattern!))
        : this.capturedRequests;
      const limited = filtered.slice(-(filter?.limit || 100));
      return { requests: limited, count: limited.length, total: this.capturedRequests.length };
    }
    return new Promise((resolve) => {
      this._pendingResolve = resolve;
      const cmd = JSON.stringify({ action: 'list', hostPattern: filter?.hostPattern, limit: filter?.limit || 100 });
      this.child?.stdin?.write(cmd + '\n');
      setTimeout(() => {
        if (this._pendingResolve) {
          this._pendingResolve = null;
          resolve({ requests: [], count: 0, total: 0 });
        }
      }, 3000);
    });
  }

  async clear(): Promise<void> {
    this.capturedRequests = [];
    if (this.child && this.running) {
      return new Promise((resolve) => {
        this._pendingResolve = () => resolve();
        this.child?.stdin?.write(JSON.stringify({ action: 'clear' }) + '\n');
        setTimeout(() => resolve(), 2000);
      });
    }
  }

  async stats(): Promise<{ total: number; uniqueHosts: number; hosts: Record<string, number> }> {
    if (!this.child || !this.running) {
      const hosts: Record<string, number> = {};
      for (const r of this.capturedRequests) hosts[r.host] = (hosts[r.host] || 0) + 1;
      return { total: this.capturedRequests.length, uniqueHosts: Object.keys(hosts).length, hosts };
    }
    return new Promise((resolve) => {
      this._pendingResolve = resolve;
      this.child?.stdin?.write(JSON.stringify({ action: 'stats' }) + '\n');
      setTimeout(() => {
        if (this._pendingResolve) {
          this._pendingResolve = null;
          resolve({ total: 0, uniqueHosts: 0, hosts: {} });
        }
      }, 3000);
    });
  }

  private async isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const conn = createConnection({ port, host: '127.0.0.1' });
      conn.on('connect', () => { conn.destroy(); resolve(true); });
      conn.on('error', () => resolve(false));
      setTimeout(() => { conn.destroy(); resolve(false); }, 500);
    });
  }
}
