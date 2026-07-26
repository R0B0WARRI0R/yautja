#!/usr/bin/env node
// E2E smoke test: spawn helmet, do MCP handshake, exercise all 4 macro tools,
// then verify the page-summary macro returns real DOM data from Chrome.
//
// Robust to: helmet connection failures, no tabs attached, macros that throw.
// Cleans up the temp user macro it registers.

import { spawn } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import { randomUUID } from 'crypto';

const HELMET = 'D:/Yautja/dist/helmet-main.js';
const PORT = process.argv[2] || '9877';  // 9876 is in use by opencode's MCP helmet
const TIMEOUT_MS = 60_000;

function send(helmet, obj) {
  return new Promise((resolve, reject) => {
    const line = JSON.stringify(obj);
    const onData = (chunk) => {
      const text = chunk.toString();
      for (const l of text.split('\n')) {
        if (!l.trim()) continue;
        try {
          const msg = JSON.parse(l);
          if (msg.id === obj.id) {
            helmet.stdout.off('data', onData);
            resolve(msg);
            return;
          }
        } catch {}
      }
    };
    helmet.stdout.on('data', onData);
    helmet.stdin.write(line + '\n');
    setTimeout(() => {
      helmet.stdout.off('data', onData);
      reject(new Error(`timeout waiting for response to ${obj.method} (id=${obj.id})`));
    }, TIMEOUT_MS);
  });
}

function nextId() {
  return Math.floor(Math.random() * 1e9);
}

function log(label, value) {
  console.log(`\n=== ${label} ===`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function main() {
  console.log('Spawning helmet...');
  const helmet = spawn('node', [HELMET, PORT], { stdio: ['pipe', 'pipe', 'pipe'] });

  let stderrBuf = '';
  helmet.stderr.on('data', (c) => { stderrBuf += c.toString(); });

  // Give the helmet 2s to start (it tries to connect to Chrome via extension).
  await sleep(2000);

  try {
    // 1. Initialize MCP
    log('1. initialize', await send(helmet, { jsonrpc: '2.0', id: nextId(), method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e-test', version: '1.0' } } }));

    // 2. tools/list — verify 4 macro tools exposed
    const list = await send(helmet, { jsonrpc: '2.0', id: nextId(), method: 'tools/list' });
    const names = list.result.tools.map((t) => t.name);
    log('2. tools/list count', list.result.tools.length);
    log('   macro tools', names.filter((n) => n.startsWith('macro_')));

    // 3. macro_list — initial empty (or with page-summary if builtins are loaded)
    const initialList = await send(helmet, { jsonrpc: '2.0', id: nextId(), method: 'tools/call', params: { name: 'macro_list', arguments: {} } });
    log('3. macro_list initial', JSON.parse(initialList.result.content[0].text));

    // 4. macro_register a temp user macro that scrapes document.title
    const tmpName = `e2e-scrape-${randomUUID().slice(0, 8)}`;
    const source = `export default { name: '${tmpName}', description: 'E2E: scrape document.title', async run(_a, ctx) { const r = await ctx.act({ type: 'evaluate', expression: 'document.title' }); return { title: r }; } };`;
    const reg = await send(helmet, { jsonrpc: '2.0', id: nextId(), method: 'tools/call', params: { name: 'macro_register', arguments: { name: tmpName, source } } });
    log('4. macro_register', JSON.parse(reg.result.content[0].text));

    // 5. macro_list — should now include tmpName and page-summary
    const afterReg = await send(helmet, { jsonrpc: '2.0', id: nextId(), method: 'tools/call', params: { name: 'macro_list', arguments: {} } });
    log('5. macro_list after register', JSON.parse(afterReg.result.content[0].text).macros.map(m => `${m.name}:${m.source}`));

    // 6. macro_run the user macro — should return document.title of active tab
    const runUser = await send(helmet, { jsonrpc: '2.0', id: nextId(), method: 'tools/call', params: { name: 'macro_run', arguments: { name: tmpName } } });
    const userResult = JSON.parse(runUser.result.content[0].text);
    log('6. macro_run user macro', { success: userResult.success, result: userResult.result, stage: userResult.stage, error: userResult.error, log: userResult.log });

    // 7. macro_run the built-in page-summary — should observe real page state
    const runBuiltin = await send(helmet, { jsonrpc: '2.0', id: nextId(), method: 'tools/call', params: { name: 'macro_run', arguments: { name: 'page-summary' } } });
    const builtinResult = JSON.parse(runBuiltin.result.content[0].text);
    log('7. macro_run page-summary', { success: builtinResult.success, stage: builtinResult.stage, error: builtinResult.error, observation_preview: builtinResult.result?.observation?.slice(0, 200), log: builtinResult.log });

    // 8. macro_run unknown — should return lookup error
    const runUnknown = await send(helmet, { jsonrpc: '2.0', id: nextId(), method: 'tools/call', params: { name: 'macro_run', arguments: { name: 'nonexistent-macro' } } });
    log('8. macro_run unknown', JSON.parse(runUnknown.result.content[0].text));

    // 9. macro_run with invalid name validation
    const regInvalid = await send(helmet, { jsonrpc: '2.0', id: nextId(), method: 'tools/call', params: { name: 'macro_register', arguments: { name: 'Bad Name!', source: 'x' } } });
    log('9. macro_register invalid name', JSON.parse(regInvalid.result.content[0].text));

    // 10. macro_delete cleanup
    const del = await send(helmet, { jsonrpc: '2.0', id: nextId(), method: 'tools/call', params: { name: 'macro_delete', arguments: { name: tmpName } } });
    log('10. macro_delete', JSON.parse(del.result.content[0].text));

    // 11. macro_delete refuses built-in
    const delBuiltin = await send(helmet, { jsonrpc: '2.0', id: nextId(), method: 'tools/call', params: { name: 'macro_delete', arguments: { name: 'page-summary' } } });
    log('11. macro_delete built-in (should refuse)', JSON.parse(delBuiltin.result.content[0].text));

    // ─── P10–P18 smoke (envelope-aware) ──────────────────────
    // 12. Envelope shape on a native tool
    const obs = JSON.parse((await send(helmet, { jsonrpc: '2.0', id: nextId(), method: 'tools/call', params: { name: 'listTabs', arguments: {} } })).result.content[0].text);
    log('12. envelope shape (listTabs)', { ok: obs.ok, schema_version: obs.schema_version, hasState: !!obs.state });

    // 13. ensureEmpty fails fast without query/selector (P11)
    const ee = JSON.parse((await send(helmet, { jsonrpc: '2.0', id: nextId(), method: 'tools/call', params: { name: 'ensureEmpty', arguments: {} } })).result.content[0].text);
    log('13. ensureEmpty INVALID_ARGUMENT', { ok: ee.ok, code: ee.error?.code });

    // 14. waitFor times out typed (P12)
    const wf = JSON.parse((await send(helmet, { jsonrpc: '2.0', id: nextId(), method: 'tools/call', params: { name: 'waitFor', arguments: { anyOf: [{ type: 'selector', selector: '#definitely-not-here-x1' }], timeoutMs: 1200, pollMs: 200 } } })).result.content[0].text);
    log('14. waitFor WAIT_TIMEOUT', { ok: wf.ok, code: wf.error?.code });

    // 15. profileList ships perplexity/gemini/default (P13)
    const pl = JSON.parse((await send(helmet, { jsonrpc: '2.0', id: nextId(), method: 'tools/call', params: { name: 'profileList', arguments: {} } })).result.content[0].text);
    const profileIds = (pl.result?.profiles ?? []).map((p) => p.id);
    log('15. profileList', { ok: pl.ok, ids: profileIds });

    // 16. preflight passes on a default domain (P13)
    const pf = JSON.parse((await send(helmet, { jsonrpc: '2.0', id: nextId(), method: 'tools/call', params: { name: 'preflight', arguments: {} } })).result.content[0].text);
    log('16. preflight', { ok: pf.ok, pass: pf.result?.pass, profile: pf.result?.profile });

    // 17. gateStatus default P0; browserFetch denied without grant (P14)
    const gs = JSON.parse((await send(helmet, { jsonrpc: '2.0', id: nextId(), method: 'tools/call', params: { name: 'gateStatus', arguments: {} } })).result.content[0].text);
    const bf = JSON.parse((await send(helmet, { jsonrpc: '2.0', id: nextId(), method: 'tools/call', params: { name: 'browserFetch', arguments: { url: 'https://example.com/api', method: 'POST' } } })).result.content[0].text);
    log('17. gates', { defaultGate: gs.result?.defaultGate, fetchDenied: bf.ok === false && bf.error?.code === 'YJ.POLICY.GATE_DENIED' });

    // Summary
    console.log('\n========== SUMMARY ==========');
    console.log('Tools exposed:', names.filter((n) => n.startsWith('macro_')).length, '/ 4 expected');
    console.log('User macro register+run+delete: OK if steps 4,6,10 succeeded');
    console.log('Built-in page-summary: OK if step 7 returned success:true with real observation');
    console.log('Lookup error: OK if step 8 stage=lookup');
    console.log('Validation error: OK if step 9 stage=validation');
    console.log('Built-in delete refused: OK if step 11 stage=permission');
    console.log('Envelope: OK if step 12 ok===true && schema_version==="1.0"');
    console.log('P11: OK if step 13 code===YJ.PROTOCOL.INVALID_ARGUMENT');
    console.log('P12: OK if step 14 code===YJ.ACT.WAIT_TIMEOUT');
    console.log('P13: OK if step 15 includes perplexity+gemini+default && step 16 pass===true');
    console.log('P14: OK if step 17 defaultGate===P0 && fetchDenied===true');
  } catch (err) {
    console.error('\n!!! E2E FAILED !!!');
    console.error('Error:', err.message);
    console.error('\nHelmet stderr captured:\n', stderrBuf);
    process.exit(1);
  } finally {
    helmet.kill('SIGTERM');
    await sleep(500);
    if (!helmet.killed) helmet.kill('SIGKILL');
  }
}

main().catch((err) => {
  console.error('Unhandled:', err);
  process.exit(1);
});