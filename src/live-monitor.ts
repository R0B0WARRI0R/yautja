import { ExtensionServer } from './connection/extension-server.js';

const server = new ExtensionServer(9876);

server.onStatusChange((status) => {
  if (status.connected) {
    console.log(`\n[X] Extension connected (v${status.extensionVersion})\n`);
  } else {
    console.log('\n[ ] Extension disconnected — waiting...\n');
  }
});

server.onEvent((event) => {
  const ts = new Date().toLocaleTimeString();
  console.log(`  [${ts}] ${event.method}`);
});

async function main() {
  console.log('Yautja Extension Bridge — Live Monitor');
  console.log('=======================================');
  console.log(`Listening on ws://localhost:${server.getPort()}`);
  console.log('Waiting for extension to connect from Brave...\n');
  console.log('Install the extension: brave://extensions > Developer mode > Load unpacked');
  console.log(`  Path: D:\\Yautja\\extension\n`);

  await server.start();

  // Wait for extension connection
  await waitForConnection();

  // List tabs
  console.log('\n--- Available tabs ---');
  const tabs = await server.listTabs();

  // Filter out internal pages (chrome://, brave://, about:, edge://)
  const ATTACHABLE = /^https?:\/\/|^file:\/\//;
  const usable = tabs.filter((t) => ATTACHABLE.test(t.url));
  const skipped = tabs.filter((t) => !ATTACHABLE.test(t.url));

  for (const tab of usable) {
    const flag = tab.active ? ' *' : '  ';
    console.log(`${flag} [${tab.tabId}] ${(tab.title || '(no title)').substring(0, 50)}`);
    console.log(`     ${tab.url.substring(0, 80)}`);
  }
  if (skipped.length > 0) {
    console.log(`\n  (${skipped.length} internal tab${skipped.length > 1 ? 's' : ''} skipped — cannot attach debugger to brave:// pages)`);
  }

  // Prefer active tab if attachable, otherwise first usable tab
  const target = usable.find((t) => t.active) ?? usable[0];
  if (!target) {
    console.log('\n[!] No attachable tabs found. Open a normal webpage (https://...) in Brave and re-run.');
    return;
  }

  console.log(`\n--- Attaching to tab ${target.tabId}: ${target.title || target.url} ---`);
  await server.attachTab(target.tabId);
  console.log('[X] Attached. Brave will show a debugging banner on this tab.\n');

  // Enable CDP domains and watch events
  console.log('Enabling CDP domains...');
  await server.enableDomains(['Network', 'Page', 'Runtime', 'Performance']);
  console.log('[X] Network, Page, Runtime, Performance enabled.\n');

  // Diagnostic: test CDP command round-trip
  console.log('--- Diagnostic: CDP command test ---');
  try {
    const evalResult = await server.send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });
    const title = evalResult?.result?.value ?? '(no value)';
    console.log(`[X] Runtime.evaluate OK — page title: "${title}"\n`);
  } catch (err) {
    console.log(`[!] Runtime.evaluate FAILED: ${err}\n`);
  }

  // Diagnostic: manually fetch performance metrics
  try {
    const metrics = await server.send('Performance.getMetrics');
    console.log('[X] Performance.getMetrics OK:');
    for (const m of metrics?.metrics ?? []) {
      console.log(`     ${m.name}: ${m.value}`);
    }
    console.log('');
  } catch (err) {
    console.log(`[!] Performance.getMetrics FAILED: ${err}\n`);
  }

  console.log('--- Live CDP events (Ctrl+C to stop) ---\n');

  // Keep alive
  setInterval(() => {
    if (!server.isExtensionConnected()) {
      console.log('\n[!] Extension disconnected. Reconnect from Brave to continue.');
    }
  }, 5000);
}

function waitForConnection(): Promise<void> {
  return new Promise((resolve) => {
    if (server.isExtensionConnected()) {
      resolve();
      return;
    }
    const unsub = server.onStatusChange((status) => {
      if (status.connected) {
        unsub();
        // Small delay to let hello message fully process
        setTimeout(() => resolve(), 500);
      }
    });
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
