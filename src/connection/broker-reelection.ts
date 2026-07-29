import { BrokerClient } from './broker-client.js';
import type { ExtensionServer } from './extension-server.js';
import { scanForBroker } from './broker-discovery.js';

/**
 * BrokerReelection — bucle de reelección y re-registro automático (Tanda C
 * multi-instancia). Hace que el sistema se autorregule cuando el broker
 * muere, SIN reiniciar sesiones:
 *
 * - Cuando un CLIENT pierde a su broker (o el registro inicial falló), el
 *   bucle escanea cada `intervalMs` la ventana de puertos MENORES que el
 *   propio (windowBasePort..ownPort-1) buscando un helmet vivo que acepte
 *   registro (sonda brokerInfo, ver broker-discovery.ts).
 * - Si lo encuentra → se re-registra como cliente (sale del modo degradado y
 *   reanuda el forwarding; envía su groupId actual para repoblar los
 *   sessionGroups del nuevo broker).
 * - Si NO hay ningún helmet menor vivo → el helmet se AUTOPROMUEVE a broker:
 *   su ExtensionServer ya acepta registros (Tanda A), así que solo cambia el
 *   rol interno; la extensión rotará hasta su puerto por sí sola.
 *
 * Decisión de estabilidad: un helmet promovido NO se degrada si más tarde
 * reaparece un helmet de puerto menor — el rol no vuelve atrás hasta
 * reiniciar la sesión. Evita oscilaciones de rol y re-enrutados de la
 * extensión en cadena.
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
  intervalMs?: number;
  scanTimeoutMs?: number;
}

export class BrokerReelection {
  private client: BrokerClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private promoted = false;
  private ticking = false;
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

  /** true tras la autopromoción (estable hasta reinicio — ver cabecera). */
  isPromoted(): boolean {
    return this.promoted;
  }

  /**
   * Adopta el cliente del registro inicial (ya registrado): arma el
   * disparador de reelección para cuando se pierda el broker.
   */
  adopt(client: BrokerClient): void {
    this.client = client;
    this.armOnLoss(client);
  }

  /** Arranca el bucle de reelección (idempotente). Primera pasada inmediata. */
  start(): void {
    if (this.timer || this.promoted) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // El bucle no debe mantener vivo el proceso por sí solo.
    this.timer.unref?.();
    void this.tick();
  }

  /** Detiene el bucle y el cliente vigente (apagado del helmet). */
  async stop(): Promise<void> {
    this.stopTimer();
    if (this.client) {
      const client = this.client;
      this.client = null;
      await client.stop();
    }
  }

  // ─── Internal ────────────────────────────────────────────────────

  private armOnLoss(client: BrokerClient): void {
    client.onStatusChange((registered) => {
      if (!registered && this.client === client) this.start();
    });
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.promoted) return;
    if (this.client?.isRegistered()) {
      this.stopTimer();
      return;
    }
    this.ticking = true;
    try {
      const ownPort = this.opts.server.getPort();
      const lowerPorts: number[] = [];
      for (let p = this.opts.windowBasePort; p < ownPort; p++) lowerPorts.push(p);
      const found = lowerPorts.length > 0 ? await scanForBroker(lowerPorts, this.scanTimeoutMs) : null;
      // Re-check tras el await: otro camino pudo resolver el rol mientras.
      if (this.promoted) return;
      if (this.client?.isRegistered()) {
        this.stopTimer();
        return;
      }

      if (found) {
        // Hay un helmet vivo de menor puerto → re-registro como cliente.
        const client = new BrokerClient(found.port, this.opts.sessionId);
        const groupId = this.opts.getGroupId?.() ?? null;
        if (groupId !== null) client.setGroupId(groupId);
        if (await client.start()) {
          const prev = this.client;
          this.client = client;
          this.opts.server.setBrokerClient(client);
          client.onEvent((payload) => this.opts.server.dispatchBrokerEvent(payload));
          this.armOnLoss(client);
          if (prev) await prev.stop();
          process.stderr.write(
            `[Yautja] re-registered with broker :${found.port} (session ${this.opts.sessionId})\n`,
          );
          this.stopTimer();
          return;
        }
        // La sonda respondió pero el registro falló: próximo ciclo.
        await client.stop();
        return;
      }

      // Sin helmet menor vivo → autopromoción a broker (estable: el rol no
      // vuelve atrás aunque reaparezca un helmet de puerto menor).
      this.promoted = true;
      const prev = this.client;
      this.client = null;
      this.opts.server.setBrokerClient(null);
      this.opts.server.setBrokerSessionId(this.opts.sessionId);
      if (prev) await prev.stop();
      process.stderr.write(
        `[Yautja] promoted to broker on port ${ownPort} (session ${this.opts.sessionId})\n`,
      );
      this.stopTimer();
    } finally {
      this.ticking = false;
    }
  }
}
