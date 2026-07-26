import { Helmet, resolvePort } from './helmet.js';

async function main() {
  const { port, source } = resolvePort();
  process.stderr.write(`[Yautja] Port: ${port} (source: ${source})\n`);
  const helmet = new Helmet({ port });

  // Graceful shutdown on signals and host death — registered BEFORE start()
  // so a host dying during the extension wait doesn't leave a zombie.
  // stop() kills the MITM proxy child and restores the Windows proxy
  // registry; without it, a taskkill leaves the browser without internet.
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
  // stdin starts paused — resume() so 'end' actually fires on host death.
  process.stdin.resume();
  process.stdin.on('end', () => shutdown('stdin EOF'));

  process.stderr.write('[Yautja] Starting helmet...\n');
  await helmet.start();
  process.stderr.write('[Yautja] Ready. Serving MCP on stdio.\n');

  helmet.serveMCP();
}

main().catch((err) => {
  process.stderr.write(`[Yautja] Fatal: ${err}\n`);
  process.exit(1);
});
