import { ExtensionServer } from './connection/extension-server.js';
import { ThermalSensor } from './vision/thermal.js';
import { writeFileSync } from 'fs';

const SNAPSHOT_FILE = 'D:\\Yautja\\thermal-snapshot.txt';

const server = new ExtensionServer(9876);

let thermal: ThermalSensor | null = null;

server.onStatusChange((status) => {
  if (status.connected) {
    console.log(`\n[X] Extension connected (v${status.extensionVersion})\n`);
  } else {
    console.log('\n[ ] Extension disconnected — waiting...\n');
  }
});

async function main() {
  console.log('Yautja — Thermal Vision (Network Sensor)');
  console.log('========================================');
  console.log(`Listening on ws://localhost:${server.getPort()}`);
  console.log('Waiting for extension...\n');

  await server.start();
  await waitForConnection();

  // List and attach to first usable tab
  const tabs = await server.listTabs();
  const ATTACHABLE = /^https?:\/\/|^file:\/\//;
  const usable = tabs.filter((t) => ATTACHABLE.test(t.url));
  const skipped = tabs.filter((t) => !ATTACHABLE.test(t.url));

  console.log('--- Tabs ---');
  for (const tab of usable) {
    const flag = tab.active ? ' *' : '  ';
    console.log(`${flag} [${tab.tabId}] ${(tab.title || '(no title)').substring(0, 50)}`);
  }
  if (skipped.length > 0) {
    console.log(`  (${skipped.length} internal skipped)`);
  }

  const target = usable.find((t) => t.active) ?? usable[0];
  if (!target) {
    console.log('\n[!] No attachable tabs. Open a webpage and re-run.');
    return;
  }

  console.log(`\n--- Attaching to [${target.tabId}] ---`);
  await server.attachTab(target.tabId);

  // Create thermal sensor with the server as transport
  thermal = new ThermalSensor(server, { maxTransactions: 200, slowThresholdMs: 1500 });
  thermal.subscribe();

  // Enable Network domain
  console.log('Enabling Network domain...');
  await server.enableDomains(['Network']);
  console.log('[X] Thermal vision active.\n');

  // Print summary every 3 seconds
  console.log('--- Live network summary (Ctrl+C to stop) ---\n');
  setInterval(async () => {
    if (!thermal) return;
    const s = await thermal.summarize();

    process.stdout.write('\x1b[2J\x1b[H'); // clear screen
    const lines: string[] = [];
    const log = (s: string) => { console.log(s); lines.push(s); };

    log(`=== THERMAL VISION @ ${new Date().toLocaleTimeString()} ===`);
    log(`Total: ${s.total} | Completed: ${s.completed} | Failed: ${s.failed} | Pending: ${s.pending}`);
    log('');

    // By type
    log('By type:');
    for (const [type, count] of Object.entries(s.byType).sort((a, b) => b[1] - a[1])) {
      log(`  ${type.padEnd(12)} ${count}`);
    }
    log('');

    // By status
    log('By status:');
    for (const [status, count] of Object.entries(s.byStatus).sort()) {
      log(`  ${status.padEnd(10)} ${count}`);
    }
    log('');

    // Slow requests
    if (s.slow.length > 0) {
      log(`Slow requests (>1500ms):`);
      for (const t of s.slow.slice(0, 5)) {
        log(`  ${(t.durationMs + 'ms').padEnd(8)} ${t.request.method} ${t.request.url.substring(0, 60)}`);
      }
      log('');
    }

    // Failed
    if (s.failedRequests.length > 0) {
      log('Failed:');
      for (const t of s.failedRequests.slice(0, 5)) {
        log(`  ${t.error?.errorText || '??'}  ${t.request.url.substring(0, 60)}`);
      }
      log('');
    }

    // API calls
    if (s.apiCalls.length > 0) {
      log(`API calls (${s.apiCalls.length}):`);
      for (const t of s.apiCalls.slice(0, 5)) {
        const status = t.response?.status ?? '---';
        log(`  ${status} ${t.request.method.padEnd(5)} ${t.request.url.substring(0, 60)}`);
      }
      log('');
    }

    // WebSockets
    if (s.webSockets.length > 0) {
      log(`WebSockets (${s.webSockets.length}):`);
      for (const t of s.webSockets) {
        log(`  ${t.request.url.substring(0, 70)}`);
      }
      log('');
    }

    // Bytes
    log(`Transfer: ${(s.totalEncodedBytes / 1024).toFixed(1)} KB encoded / ${(s.totalDecodedBytes / 1024).toFixed(1)} KB decoded`);

    // Anomalies
    const anomalies = thermal.getAnomalies();
    if (anomalies.length > 0) {
      log('\n--- ANOMALIES ---');
      for (const a of anomalies) {
        const icon = a.severity === 'critical' ? '[!]' : a.severity === 'warning' ? '[~]' : '[i]';
        log(`${icon} ${a.message}`);
      }
    }

    log('\n(Refreshing in 3s... navigate or refresh the page to see new activity)');

    writeFileSync(SNAPSHOT_FILE, lines.join('\n'), 'utf-8');
  }, 3000);
}

function waitForConnection(): Promise<void> {
  return new Promise((resolve) => {
    if (server.isExtensionConnected()) {
      setTimeout(() => resolve(), 500);
      return;
    }
    const unsub = server.onStatusChange((status) => {
      if (status.connected) {
        unsub();
        setTimeout(() => resolve(), 500);
      }
    });
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
