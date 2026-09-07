import { BrokerClient } from './broker-client.js';
import type { ExtensionServer } from './extension-server.js';
import { scanForBroker } from './broker-discovery.js';

/**
 * BrokerReelection — bucle de reelección y re-registro automático (Tanda C
 * multi-instancia). Hace que el sistema se autorregule cuando el broker
 * muere, SIN reiniciar sesiones:
 *
 * Every process, including the base port and promoted brokers, reconciles
 * its connection across its own ten-port window. Only a direct extension
 * owner is a routing candidate. Healthy links stay put; disconnected peers
 * keep looking, even if their current broker registration is still alive.
 * This allows a restarted base port to join a surviving higher-port broker
 * without moving the extension or forming client-to-client routing cycles.
 */

/** Intervalo del bucle de reelección (~5s; unref para no retener el proceso). */
const DEFAULT_REELECTION_INTERVAL_MS = 5_000;
/** Timeout por puerto de la sonda brokerInfo durante el escaneo. */
const DEFAULT_SCAN_TIMEOUT_MS = 500;

export interface ReelectionOptions {
  /** ExtensionServer propio (fuente del puerto real y destino del brokerClient). */
  server: ExtensionServer;
  /** sessionId de este helmet. */
  sessionId: string;
  /** Puerto base de la ventana (p.ej. config.port; la ventana es base..base+9). */
  windowBasePort: number;
  /** Grupo de sesión actual del helmet (para el re-registro con groupId). */
  getGroupId?: () => number | null;
  /** Shared bridge token; required when the target broker enforces authentication. */
  bridgeToken?: string;
  intervalMs?: number;
  scanTimeoutMs?: number;
}

export class BrokerReelection {
  private client: BrokerClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private promoted = false;
  private running = false;
  private pendingTick: Promise<void> | null = null;
  private readonly intervalMs: number;
  private readonly scanTimeoutMs: number;

  constructor(private readonly opts: ReelectionOptions) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_REELECTION_INTERVAL_MS;
    this.scanTimeoutMs = opts.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
  }

  /** Cliente broker vigente (registrado o no); null en modo broker/standalone. */
  getClient(): BrokerClient | null {
    return this.client;
  }

  /** true while serving locally instead of routing through a broker. */
  isPromoted(): boolean {
    return this.promoted;
  }

  /**
   * Adopta el cliente del registro inicial (ya registrado): arma el
   * disparador de reelección para cuando se pierda el broker.
   */
  adopt(client: BrokerClient): void {
    this.client = client;
    this.start();
  }

  /** Arranca el bucle de reelección (idempotente). Primera pasada inmediata. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      this.tick();
    }, this.intervalMs);
    // El bucle no debe mantener vivo el proceso por sí solo.
    this.timer.unref?.();
    this.tick();
  }

  /** Detiene el bucle y el cliente vigente (apagado del helmet). */
  async stop(): Promise<void> {
    this.running = false;
    this.stopTimer();
    await this.pendingTick;
    if (this.client) {
      const client = this.client;
      this.client = null;
      await client.stop();
    }
  }

  // ─── Internal ────────────────────────────────────────────────────

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (!this.running || this.pendingTick) return;
    this.pendingTick = this.reconcile()
      .catch(error => process.stderr.write(`[Yautja] broker reconciliation failed: ${String(error)}\n`))
      .then(() => { this.pendingTick = null; });
  }

  private hasHealthyClient(): boolean {
    return !!this.client?.isRegistered() && this.client.getBridgeState()?.connected === true;
  }

  private async reconcile(): Promise<void> {
    if (this.opts.server.hasLocalExtension()) {
      const prev = this.client;
      this.client = null;
      this.promoted = true;
      if (prev) {
        this.opts.server.setBrokerClient(null);
        await prev.stop();
      }
      return;
    }
    if (this.hasHealthyClient()) return;
    const ownPort = this.opts.server.getPort();
    const ports: number[] = [];
    for (let p = this.opts.windowBasePort; p < Math.min(this.opts.windowBasePort + 10, 65536); p++) {
      if (p !== ownPort) ports.push(p);
    }
    const found = await scanForBroker(ports, this.scanTimeoutMs, this.opts.bridgeToken, true);
    // A local hello, broker recovery or shutdown may win while discovery waits.
    if (!this.running || this.opts.server.hasLocalExtension() || this.hasHealthyClient()) return;

    if (found) {
      const client = new BrokerClient(found.port, this.opts.sessionId, undefined, this.opts.bridgeToken);
      const groupId = this.opts.getGroupId?.() ?? null;
      if (groupId !== null) client.setGroupId(groupId);
      if (await client.start()) {
        if (!this.running || this.opts.server.hasLocalExtension() || this.hasHealthyClient()
          || client.getBridgeState()?.connected === false) {
          await client.stop();
          return;
        }
        const prev = this.client;
        this.client = client;
        this.promoted = false;
        this.opts.server.setBrokerClient(client);
        client.onEvent((payload) => {
          if (this.client === client && !this.opts.server.hasLocalExtension()) this.opts.server.dispatchBrokerEvent(payload);
        });
        if (prev) await prev.stop();
        process.stderr.write(
          `[Yautja] re-registered with broker :${found.port} (session ${this.opts.sessionId})\n`,
        );
        return;
      }
      // La sonda respondió pero el registro falló: próximo ciclo.
      await client.stop();
      return;
    }

    // Preserve a live registration during a temporary MV3 disconnect. With
    // no registration, keep a local slot available and continue discovery.
    if (this.client?.isRegistered() || this.promoted) return;
    this.promoted = true;
    const prev = this.client;
    this.client = null;
    this.opts.server.setBrokerClient(null);
    this.opts.server.setBrokerSessionId(this.opts.sessionId);
    if (prev) await prev.stop();
    process.stderr.write(
      `[Yautja] promoted to broker on port ${ownPort} (session ${this.opts.sessionId})\n`,
    );
  }
}
