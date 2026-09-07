import { Helmet, resolveBridgeToken, resolvePort } from './helmet.js';

async function main() {
  const { port, source } = resolvePort();
  const bridgeToken = resolveBridgeToken(port);
  process.stderr.write(`[Yautja] Port: ${port} (source: ${source})\n`);
  process.stderr.write(`[Yautja] bridge authentication: ${bridgeToken ? 'enabled' : 'disabled (set YAUTJA_BRIDGE_TOKEN to enable)'}\n`);
  const helmet = new Helmet({ port, bridgeToken });

  // Graceful shutdown on signals: stop() kills the MITM proxy child and
  // restores the Windows proxy registry — without this, a taskkill leaves
  // the browser pointing at a dead proxy (no internet) and a zombie on 9877.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[Yautja] ${signal} received, shutting down...\n`);
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    helmet.stop()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // serveMCP BEFORE start(): readline owns stdin from t=0 (hosts send
  // initialize immediately and messages must never be swallowed), and its
  // close handler covers the startup window too — a host dying while we
  // wait for the extension still shuts us down. Do NOT resume() stdin
  // manually: flowing mode eats JSON-RPC messages.
  helmet.serveMCP();

  process.stderr.write('[Yautja] Starting helmet...\n');
  await helmet.start();
  process.stderr.write('[Yautja] Ready.\n');
}

main().catch((err) => {
  process.stderr.write(`[Yautja] Fatal: ${err}\n`);
  process.exit(1);
});
