import { Helmet, resolvePort } from './helmet.js';

async function main() {
  const { port, source } = resolvePort();
  process.stderr.write(`[Yautja] Port: ${port} (source: ${source})\n`);
  const helmet = new Helmet({ port });

  process.stderr.write('[Yautja] Starting helmet...\n');
  await helmet.start();
  process.stderr.write('[Yautja] Ready. Serving MCP on stdio.\n');

  helmet.serveMCP();
}

main().catch((err) => {
  process.stderr.write(`[Yautja] Fatal: ${err}\n`);
  process.exit(1);
});
