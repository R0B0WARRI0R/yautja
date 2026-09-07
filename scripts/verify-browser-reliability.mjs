import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Uses only a temporary browser profile and a random, authenticated bridge port.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'yautja-reliability-'));
process.env.APPDATA = path.join(temp, 'appdata');
const { Helmet } = await import('../dist/helmet.js');
const fixture = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ source: req.url })); return; }
  const id = req.url === '/b' ? 'B' : 'A';
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><title>Fixture ${id}</title><body data-id="${id}"><h1>${id}</h1><button id="count" onclick="this.textContent=String(++window.clicks)">0</button><script>window.clicks=0</script></body>`);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 15_000;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error('Fixture condition timed out'); await delay(50); }
}
function ok(response) { if (typeof response === 'string') response = JSON.parse(response); assert.equal(response.ok, true, JSON.stringify(response.error)); return response.result; }
try {
  for (const variant of ['extension', 'extension-chrome']) {
    if (process.env.YAUTJA_TEST_VARIANT && process.env.YAUTJA_TEST_VARIANT !== variant) continue;
    const listener = net.createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    const bridgeToken = randomBytes(32).toString('hex');
    const extension = path.join(temp, variant);
    await fs.cp(path.join(root, variant), extension, { recursive: true, filter: source => path.basename(source) !== 'config.json' });
    await fs.writeFile(path.join(extension, 'config.json'), JSON.stringify({ yjPort: port, yjBridgeToken: bridgeToken }));
    const helmet = new Helmet({ port, bridgeToken, autoAttach: false, postActionDelayMs: 0 });
    let context;
    const started = helmet.start();
    try {
      context = await chromium.launchPersistentContext(path.join(temp, `${variant}-profile`), {
        executablePath: process.env.YAUTJA_TEST_BROWSER || (variant === 'extension-chrome' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe'), headless: true,
        ignoreDefaultArgs: ['--disable-extensions'],
        args: variant === 'extension-chrome' ? ['--enable-unsafe-extension-debugging'] : [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      });
      if (variant === 'extension-chrome') {
        // Chrome's supported development path for an isolated process over a pipe:
        // https://chromedevtools.github.io/devtools-protocol/tot/Extensions/#method-loadUnpacked
        const cdp = await context.browser().newBrowserCDPSession();
        await cdp.send('Extensions.loadUnpacked', { path: extension });
        await cdp.detach();
      }
      await started;
      try { await until(async () => ok(await helmet.callTool('connection_status', {})).link.connected); }
      catch (error) {
        const diagnostic = await context.browser().newBrowserCDPSession();
        console.error(JSON.stringify({ extensions: await diagnostic.send('Extensions.getExtensions'), targets: await diagnostic.send('Target.getTargets') }));
        await diagnostic.detach();
        console.error(JSON.stringify({ variant, workers: await Promise.all(context.serviceWorkers().map(async worker => ({ url: worker.url(), port: await worker.evaluate(async () => (await chrome.storage.local.get('yjPort')).yjPort) }))) }));
        throw error;
      }
      const a = context.pages()[0] || await context.newPage();
      await a.goto(`${origin}/a`);
      const tabs = ok(await helmet.callTool('listTabs', {})).tabs;
      const aId = tabs.find(tab => tab.url === `${origin}/a`).tabId;
      ok(await helmet.callTool('sessionGroupAddTab', { tabId: aId }));
      ok(await helmet.callTool('sessionGroupRename', { name: 'Yautja reliability fixture' }));
      const opened = ok(await helmet.callTool('openTab', { url: `${origin}/b` }));
      assert.equal(opened.attached, true);
      assert.equal(opened.focused, false);
      await a.bringToFront();
      const identity = ok(await helmet.callTool('act', { action: { type: 'evaluate', expression: 'document.body.dataset.id' } }));
      assert.equal(identity.value, 'B');
      ok(await helmet.callTool('act', { action: { type: 'evaluate', expression: "document.querySelector('#count').click(); window.clicks" } }));
      assert.equal(await a.evaluate(() => window.clicks), 0);
      const b = context.pages().find(page => page.url() === `${origin}/b`);
      assert.equal(await b.evaluate(() => window.clicks), 1);
      await a.evaluate(() => { console.error('fixture-A'); return fetch('/api/a'); });
      await b.evaluate(() => { console.error('fixture-B'); return fetch('/api/b'); });
      await delay(250);
      const bRequests = ok(await helmet.callTool('read_network_requests', { tabId: opened.tabId })).requests;
      assert(bRequests.some(request => request.url.endsWith('/api/b')));
      assert(!bRequests.some(request => request.url.endsWith('/api/a')));
      const other = new Helmet({ port, bridgeToken, autoAttach: false, postActionDelayMs: 0 });
      try {
        await other.start();
        const foreign = ok(await other.callTool('openTab', { url: `${origin}/a` }));
        assert.equal(JSON.parse(await helmet.callTool('switchTab', { tabId: foreign.tabId })).ok, false);
        ok(await helmet.callTool('switchTab', { tabId: opened.tabId }));
        assert.equal(ok(await other.callTool('session_finish', {})).groupClosed, true);
      } finally { await other.stop(); }
      const [switched, queuedIdentity] = await Promise.all([
        helmet.callTool('switchTab', { tabId: aId }),
        helmet.callTool('act', { action: { type: 'evaluate', expression: 'document.body.dataset.id' } }),
      ]);
      ok(switched);
      assert.equal(ok(queuedIdentity).value, 'A');
      ok(await helmet.callTool('switchTab', { tabId: opened.tabId }));
      const pending = helmet.callTool('act', { action: { type: 'evaluateAsync', expression: 'new Promise(() => {})' } });
      let operationId;
      await until(async () => {
        const records = ok(await helmet.callTool('operation_list', {})).operations;
        operationId = records.find(op => op.tool === 'act' && op.phase === 'action' && op.state === 'running')?.id;
        return !!operationId;
      });
      ok(await helmet.callTool('operation_cancel', { operationId }));
      const cancelled = JSON.parse(await pending);
      assert.equal(cancelled.ok, false);
      assert.equal(cancelled.operation.status, 'outcome_unknown');
      ok(await helmet.callTool('closeTab', { tabId: opened.tabId }));
      const missing = JSON.parse(await helmet.callTool('act', { action: { type: 'evaluate', expression: 'document.body.dataset.id' } }));
      assert.equal(missing.ok, false);
      assert.equal(missing.error.code, 'YJ.RUNTIME.TARGET_MISSING');
      const replacement = ok(await helmet.callTool('openTab', { url: `${origin}/b` }));
      const finished = ok(await helmet.callTool('session_finish', {}));
      assert.equal(finished.groupClosed, true);
      assert(finished.closed.includes(replacement.tabId));
      assert(finished.restored.includes(aId));
      assert.equal(a.isClosed(), false);
      assert.equal(ok(await helmet.callTool('session_finish', {})).groupClosed, true);
      // Reproduce a surviving higher-port broker followed by a restarted base.
      // The browser keeps its extension connection; the new base must join it.
      const survivor = new Helmet({ port, bridgeToken, autoAttach: false, postActionDelayMs: 0 });
      const restarted = new Helmet({ port, bridgeToken, autoAttach: false, postActionDelayMs: 0 });
      try {
        await survivor.start();
        await helmet.stop();
        await until(async () => {
          const link = ok(await survivor.callTool('connection_status', {})).link;
          return link.connected && link.role === 'broker';
        });
        const ownerBefore = ok(await survivor.callTool('connection_status', {})).link;
        await restarted.start();
        const joined = ok(await restarted.callTool('connection_status', {})).link;
        assert.equal(joined.connected, true);
        assert.equal(joined.role, 'client');
        assert.equal(joined.generation, ownerBefore.generation);
        const recoveredTab = ok(await restarted.callTool('openTab', { url: `${origin}/b` }));
        assert.equal(ok(await restarted.callTool('act', { action: { type: 'evaluate', expression: 'document.body.dataset.id' } })).value, 'B');
        const recoveredCleanup = ok(await restarted.callTool('session_finish', {}));
        assert.equal(recoveredCleanup.groupClosed, true);
        assert(recoveredCleanup.closed.includes(recoveredTab.tabId));
        assert.equal(ok(await survivor.callTool('connection_status', {})).link.generation, ownerBefore.generation);
      } finally {
        await restarted.callTool('session_finish', {}).catch(() => {});
        await restarted.stop();
        await survivor.callTool('session_finish', {}).catch(() => {});
        await survivor.stop();
      }
      console.log(JSON.stringify({ variant, passed: true, checks: ['same-origin target', 'background focus', 'click isolation', 'network isolation', 'two sessions', 'serialization', 'cancellation', 'missing target', 'borrow restoration', 'group cleanup', 'base-port restart', 'surviving broker preserved'] }));
    } finally {
      await started.catch(() => {});
      await helmet.stop();
      await context?.close();
    }
  }
} finally {
  await new Promise(resolve => fixture.close(resolve));
  // Validate the exact temporary root before recursively deleting this fixture.
  const resolved = path.resolve(temp);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith('yautja-reliability-'));
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3 });
}
