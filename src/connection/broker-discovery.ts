import WebSocket from 'ws';

/**
 * Discovery de la ventana multi-instancia (Tanda C: reelección de broker).
 *
 * Todo helmet es broker-capable (Tanda A): su ExtensionServer responde SIEMPRE
 * a una sonda `{type:'brokerInfo'}` con `{type:'brokerInfo', accepts:true,
 * sessionId, hasExtension}` en el mismo puerto que la extensión. Esto permite
 * a un CLIENT que perdió a su broker escanear la ventana (9876..9885 por
 * defecto) y encontrar al helmet vivo de menor puerto sin reiniciar sesión.
 */

export interface BrokerInfo {
  /** sessionId del helmet que respondió. */
  sessionId: string;
  /** true si ese helmet tiene la extensión conectada en su slot. */
  hasExtension: boolean;
}

/**
 * Sonda un puerto: ¿hay un helmet broker-capable vivo? Resuelve la info del
 * helmet o null si no responde dentro de `timeoutMs` (puerto cerrado, proceso
 * ajeno a Yautja o helmet saturado).
 */
export function queryBrokerInfo(port: number, timeoutMs: number): Promise<BrokerInfo | null> {
  return new Promise((resolve) => {
    let settled = false;
    let ws: WebSocket | null = null;
    const finish = (info: BrokerInfo | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch {}
      resolve(info);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    // La sonda no debe mantener vivo el proceso por sí sola.
    timer.unref?.();

    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch {
      finish(null);
      return;
    }

    ws.on('open', () => {
      try {
        ws!.send(JSON.stringify({ type: 'brokerInfo' }));
      } catch {
        finish(null);
      }
    });
    ws.on('message', (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg?.type === 'brokerInfo' && msg.accepts === true && typeof msg.sessionId === 'string') {
        finish({ sessionId: msg.sessionId, hasExtension: msg.hasExtension === true });
      }
    });
    ws.on('error', () => finish(null));
    ws.on('close', () => finish(null));
  });
}

/**
 * Escaneo de la ventana: prueba los puertos EN ORDEN y devuelve el primero
 * con un helmet vivo que acepte registro. El caller pasa la ventana ordenada
 * (típicamente los puertos MENORES que el propio, de menor a mayor), así que
 * el resultado es el broker candidato de menor puerto vivo.
 */
export async function scanForBroker(ports: number[], timeoutMs: number): Promise<{ port: number; info: BrokerInfo } | null> {
  for (const port of ports) {
    const info = await queryBrokerInfo(port, timeoutMs);
    if (info) return { port, info };
  }
  return null;
}
