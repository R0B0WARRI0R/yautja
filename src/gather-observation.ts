import { ExtensionServer } from './connection/extension-server.js';
import { ThermalSensor } from './vision/thermal.js';
import { EMSensor } from './vision/em.js';
import { AudioSensor } from './vision/audio.js';
import { MotionSensor } from './vision/motion.js';
import { ThreatSensor } from './vision/threat.js';
import { WorkingMemory } from './memory/browser-state.js';
import { AttentionRouter } from './targeting/router.js';
import type { BrowserState } from './memory/browser-state.js';
import type { Anomaly } from './vision/base-sensor.js';
import { writeFileSync } from 'fs';

const server = new ExtensionServer(9876);
const router = new AttentionRouter();
const memory = new WorkingMemory(5);

let thermal: ThermalSensor;
let em: EMSensor;
let audio: AudioSensor;
let motion: MotionSensor;
let threat: ThreatSensor;

async function main() {
  const question = process.argv[2] || 'what is happening on this page?';

  console.log('Yautja — Full Sensor Stack + MiniMax M3 Test');
  console.log('=============================================\n');

  await server.start();
  console.log('Waiting for extension...');

  await new Promise<void>((resolve) => {
    if (server.isExtensionConnected()) return resolve();
    const unsub = server.onStatusChange((s) => {
      if (s.connected) { unsub(); setTimeout(resolve, 500); }
    });
  });
  console.log('[X] Extension connected\n');

  const tabs = await server.listTabs();
  const ATTACHABLE = /^https?:\/\/|^file:\/\//;
  const usable = tabs.filter((t) => ATTACHABLE.test(t.url));
  const target = usable.find((t) => t.active) ?? usable[0];
  if (!target) { console.log('No attachable tab!'); return; }

  console.log(`Attaching to: ${target.url.substring(0, 60)}`);
  await server.attachTab(target.tabId);

  // Create all 5 sensors
  thermal = new ThermalSensor(server, { maxTransactions: 200, slowThresholdMs: 1500 });
  em = new EMSensor(server, { cacheTtlMs: 3000 });
  audio = new AudioSensor(server, { maxEntries: 100 });
  motion = new MotionSensor(server, { pollIntervalMs: 2000 });
  threat = new ThreatSensor(server, { maxBlockedRequests: 50 });

  // Subscribe all sensors
  thermal.subscribe();
  em.subscribe();
  audio.subscribe();
  motion.subscribe();
  threat.subscribe();

  // Enable all CDP domains (Security may not be available via chrome.debugger)
  console.log('Enabling CDP domains...');
  const domains = ['Network', 'Page', 'Runtime', 'Performance', 'Security'];
  for (const domain of domains) {
    try {
      await server.enableDomains([domain]);
      console.log(`  [X] ${domain}`);
    } catch (e) {
      console.log(`  [-] ${domain} not available via extension (${(e as Error).message.substring(0, 60)})`);
    }
  }
  console.log('[X] All sensors active. Gathering data for 5 seconds...\n');

  // Wait for data to accumulate
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Gather all sensor summaries into BrowserState
  console.log('Gathering sensor summaries...');
  const [networkSummary, domSummary, consoleSummary, perfSummary, securitySummary] = await Promise.all([
    thermal.summarize(),
    em.summarize().catch(() => ({ url: '', semantic: { pageType: 'unknown', title: '', headings: [], mainContentPreview: '', language: '' }, interactive: { buttons: [], links: [], inputs: [], total: 0 }, structural: { totalElements: 0, depth: 0, iframes: 0, images: 0, scripts: 0, forms: 0, stylesheets: 0 } })),
    audio.summarize(),
    motion.summarize(),
    threat.summarize(),
  ]);

  // Collect anomalies
  const allAnomalies: Anomaly[] = [
    ...thermal.getAnomalies(),
    ...await em.getAnomalies().catch(() => []),
    ...await audio.getAnomalies(),
    ...await motion.getAnomalies(),
    ...await threat.getAnomalies(),
  ];

  const state: BrowserState = {
    url: domSummary.url || target.url,
    title: domSummary.semantic.title,
    readyState: 'complete',
    timestamp: Date.now(),
    network: networkSummary,
    dom: domSummary,
    console: consoleSummary,
    performance: perfSummary,
    security: securitySummary,
  };

  memory.update(state);

  // Build observation via attention router
  const observation = router.observe(question, state, allAnomalies);

  console.log('\n=== OBSERVATION (sent to MiniMax M3) ===\n');
  console.log(observation.text);
  console.log(`\n[token estimate: ${observation.tokenEstimate}]\n`);

  // Write observation to file for MiniMax to read
  writeFileSync('D:\\Yautja\\observation.txt', observation.text, 'utf-8');
  console.log('Observation written to D:\\Yautja\\observation.txt');
  console.log('\nNow asking MiniMax M3...\n');

  // Cleanup sensors
  thermal.unsubscribe();
  em.unsubscribe();
  audio.unsubscribe();
  motion.unsubscribe();
  threat.unsubscribe();
  await server.stop();

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
