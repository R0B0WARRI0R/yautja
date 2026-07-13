import { createInterface } from 'readline';
import { ExtensionServer } from './connection/extension-server.js';
import { ThermalSensor } from './vision/thermal.js';
import { EMSensor } from './vision/em.js';
import { AudioSensor } from './vision/audio.js';
import { MotionSensor } from './vision/motion.js';
import { ThreatSensor } from './vision/threat.js';
import { WorkingMemory } from './memory/browser-state.js';
import { AttentionRouter } from './targeting/router.js';
import { ActionTranslator } from './arsenal/translator.js';
import { Interceptor } from './vision/interceptor.js';
import { ElementFinder } from './targeting/element-finder.js';
import { SiteMemory } from './memory/site-memory.js';
import { TechSensor } from './vision/tech.js';
import { StealthMode, STEALTH_PART_1, STEALTH_PART_2, STEALTH_PART_3 } from './vision/stealth.js';
import { WebSocketInspector } from './vision/websocket-inspector.js';
import { OSINTHarvester } from './intel/osint-harvester.js';
import { NetworkIntel } from './intel/network-intel.js';
import { GQLClient } from './intel/gql-client.js';
import { GQLCache } from './intel/gql-cache.js';
import { HashSeedDB } from './intel/hash-seed.js';
import { PatternDetector } from './intel/pattern-detector.js';
import { HashLearner } from './intel/hash-learner.js';
import { BrowserInterceptorManager } from './intel/browser-interceptor.js';
import { LearningLoop } from './intel/learning-loop.js';
import { NetworkCapture } from './intel/network-capture.js';
import type { BrowserState } from './memory/browser-state.js';
import type { Anomaly } from './vision/base-sensor.js';
import type { BrowserAction } from './arsenal/action-types.js';

export interface HelmetConfig {
  port: number;
  autoAttach: boolean;
}

export type PortSource = 'cli' | 'env' | 'default';

export function resolvePort(): { port: number; source: PortSource } {
  const cli = process.argv[2]?.trim();
  if (cli) {
    const n = Number(cli);
    if (Number.isInteger(n) && n >= 1024 && n <= 65535) {
      return { port: n, source: 'cli' };
    }
  }
  const env = process.env.YAUTJA_PORT?.trim();
  if (env) {
    const n = Number(env);
    if (Number.isInteger(n) && n >= 1024 && n <= 65535) {
      return { port: n, source: 'env' };
    }
  }
  return { port: 9876, source: 'default' };
}

const DEFAULT_CONFIG: HelmetConfig = {
  port: resolvePort().port,
  autoAttach: true,
};

export class Helmet {
  private config: HelmetConfig;
  private server: ExtensionServer;
  private router: AttentionRouter;
  private memory: WorkingMemory;
  private thermal: ThermalSensor;
  private em: EMSensor;
  private audio: AudioSensor;
  private motion: MotionSensor;
  private threat: ThreatSensor;
  private translator: ActionTranslator;
  private interceptor: Interceptor;
  private finder: ElementFinder;
  private siteMemory: SiteMemory;
  private techSensor: TechSensor;
  private stealth: StealthMode;
  private wsInspector: WebSocketInspector;
  private osint: OSINTHarvester;
  private netIntel: NetworkIntel;
  private gqlClient: GQLClient;
  private gqlCache: GQLCache;
  private hashSeedDB: HashSeedDB;
  private patternDetector: PatternDetector;
  private hashLearner: HashLearner;
  private browserInterceptor: BrowserInterceptorManager;
  private learningLoop: LearningLoop;
  private networkCapture: NetworkCapture;
  private attached = false;

  constructor(config?: Partial<HelmetConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.server = new ExtensionServer(this.config.port);
    this.router = new AttentionRouter();
    this.memory = new WorkingMemory(5);

    this.thermal = new ThermalSensor(this.server);
    this.em = new EMSensor(this.server);
    this.audio = new AudioSensor(this.server);
    this.motion = new MotionSensor(this.server);
    this.threat = new ThreatSensor(this.server);

    this.translator = new ActionTranslator(this.server);
    this.interceptor = new Interceptor(this.server);
    this.finder = new ElementFinder(this.server);
    this.siteMemory = new SiteMemory();
    this.techSensor = new TechSensor(this.server);
    this.stealth = new StealthMode();
    this.wsInspector = new WebSocketInspector(this.server);
    this.osint = new OSINTHarvester(this.server);
    this.netIntel = new NetworkIntel(this.server);
    this.gqlCache = new GQLCache();
    this.gqlClient = new GQLClient(this.server, this.gqlCache);
    this.hashSeedDB = new HashSeedDB();
    this.patternDetector = new PatternDetector(this.server, this.hashSeedDB);
    this.hashLearner = new HashLearner(this.server, this.hashSeedDB, this.gqlClient);
    this.browserInterceptor = new BrowserInterceptorManager(this.server);
    this.learningLoop = new LearningLoop(
      this.server, this.hashSeedDB, this.patternDetector, this.hashLearner, this.browserInterceptor
    );
    this.networkCapture = new NetworkCapture(this.server);
    this.server.setNetworkCaptureCallback((msg: any) => {
      if (msg.action === 'add' && msg.entry) {
        this.networkCapture.storeRequest(msg.entry);
      } else if (msg.action === 'update' && msg.requestId) {
        this.networkCapture.updateRequestStatus(msg.requestId, msg.status, msg.responseHeaders || {});
      }
    });
    this.server.on('Network.requestWillBeSent', (p: any) => {
      this.networkCapture.storeRequest({
        id: p.requestId,
        url: p.request?.url || '',
        method: p.request?.method || 'GET',
        requestHeaders: p.request?.headers || {},
        requestBody: p.request?.postData?.substring(0, 1048576) || undefined,
        timestamp: Date.now(),
      });
    });
    this.server.on('Network.responseReceived', (p: any) => {
      this.networkCapture.updateRequestStatus(
        p.requestId,
        p.response?.status || 0,
        p.response?.headers || {},
      );
    });
    this.server.on('Network.loadingFinished', (p: any) => {
      this.networkCapture.captureResponseBody(p.requestId).then((r) => {
        if (r) this.networkCapture.attachBodyToRequest(p.requestId, 'response', r.body);
      }).catch(() => {});
    });
  }

  async start(): Promise<void> {
    await this.server.start();
    if (!this.server.isExtensionConnected()) {
      await new Promise<void>((resolve) => {
        const unsub = this.server.onStatusChange((s) => {
          if (s.connected) { unsub(); setTimeout(resolve, 300); }
        });
      });
    }

    if (this.config.autoAttach) {
      await this.attachToActiveTab();
    }

    this.thermal.subscribe();
    this.em.subscribe();
    this.audio.subscribe();
    this.motion.subscribe();
    this.threat.subscribe();

    for (const domain of ['Network', 'Page', 'Runtime', 'Performance', 'Security']) {
      try { await this.server.enableDomains([domain]); } catch {}
    }
  }

  async stop(): Promise<void> {
    this.thermal.unsubscribe();
    this.em.unsubscribe();
    this.audio.unsubscribe();
    this.motion.unsubscribe();
    this.threat.unsubscribe();
    await this.server.stop();
  }

  isReady(): boolean {
    return this.server.isExtensionConnected() && this.attached;
  }

  async attachToActiveTab(): Promise<void> {
    const tabs = await this.server.listTabs();
    const ATTACHABLE = /^https?:\/\/|^file:\/\//;
    const usable = tabs.filter((t) => ATTACHABLE.test(t.url));
    const target = usable.find((t) => t.active) ?? usable[0];
    if (!target) throw new Error('Helmet: no attachable tab found');
    await this.server.attachTab(target.tabId);
    this.attached = true;
  }

  async listTabs(): Promise<{ tabId: number; url: string; title: string; active: boolean }[]> {
    return this.server.listTabs();
  }

  async ensureAttached(): Promise<void> {
    if (this.attached) {
      try {
        const tabs = await this.server.listTabs();
        const current = tabs.find((t) => t.tabId === this.server.getCurrentTabId());
        if (current) return;
      } catch {}
    }
    this.attached = false;
    await this.attachToActiveTab();
  }

  async reattach(): Promise<void> {
    this.attached = false;
    await this.attachToActiveTab();
  }

  async observe(question: string): Promise<string> {
    await this.ensureAttached().catch(() => {});
    const { state, anomalies } = await this.gatherState();
    const observation = this.router.observe(question, state, anomalies);
    return observation.text;
  }

  async act(action: BrowserAction): Promise<string> {
    await this.ensureAttached().catch(() => {});
    const { state: beforeState } = await this.gatherState();
    this.memory.update(beforeState);

    const result = await this.translator.execute(action);

    await sleep(1500);

    const { state: afterState } = await this.gatherState();
    this.memory.update(afterState);

    if (!result.ok) {
      return JSON.stringify({
        success: false,
        error: result.error.message,
        type: result.error.type,
        recoveryHint: result.error.recoveryHint,
      });
    }

    const diff = this.memory.diff();
    const diffText = diff && diff.fields.length > 0
      ? `\n\nChanges: ${diff.fields.join(', ')}`
      : '';

    return JSON.stringify({ success: true, value: result.value }) + diffText;
  }

  async inspect(domain: string): Promise<string> {
    await this.ensureAttached().catch(() => {});
    const { state } = await this.gatherState();
    switch (domain) {
      case 'network': return JSON.stringify(state.network, null, 2);
      case 'dom': return JSON.stringify(state.dom, null, 2);
      case 'console': return JSON.stringify(state.console, null, 2);
      case 'performance': return JSON.stringify(state.performance, null, 2);
      case 'security': return JSON.stringify(state.security, null, 2);
      default: return `Error: unknown domain "${domain}". Use: network, dom, console, performance, security`;
    }
  }

  async diff(): Promise<string> {
    const diff = this.memory.diff();
    if (!diff) return 'No previous state to compare. Perform an action first.';
    return JSON.stringify(diff, null, 2);
  }

  serveMCP(): void {
    const rl = createInterface({ input: process.stdin, output: process.stderr });

    rl.on('line', async (line: string) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }

      const { id, method, params } = msg;

      try {
        switch (method) {
          case 'initialize':
            this.sendMCP(id, {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'yautja', version: '0.1.0' },
            });
            break;

          case 'notifications/initialized':
            break;

          case 'tools/list':
            this.sendMCP(id, { tools: MCP_TOOLS });
            break;

          case 'tools/call': {
            const result = await this.handleToolCall(params.name, params.arguments || {});
            this.sendMCP(id, {
              content: [{ type: 'text', text: result }],
            });
            break;
          }

          case 'ping':
            this.sendMCP(id, {});
            break;

          default:
            if (id != null) {
              this.sendMCP(id, null, { code: -32601, message: `Unknown method: ${method}` });
            }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (id != null) {
          this.sendMCP(id, null, { code: -32603, message: errMsg });
        }
      }
    });
  }

  private async handleToolCall(name: string, args: any): Promise<string> {
    switch (name) {
      case 'observe':
        return this.observe(args.question || 'overview');
      case 'act':
        return this.act(args.action as BrowserAction);
      case 'inspect':
        return this.inspect(args.domain);
      case 'diff':
        return this.diff();
      case 'reattach':
        await this.reattach();
        return JSON.stringify({ success: true, tabId: this.server.getCurrentTabId() });
      case 'listTabs': {
        const tabs = await this.server.listTabs();
        return JSON.stringify({ tabs, currentTabId: this.server.getCurrentTabId() });
      }
      case 'switchTab': {
        const tabId = args.tabId;
        if (!tabId) return JSON.stringify({ error: 'tabId required' });
        await this.server.detachAll();
        await this.server.attachTab(tabId);
        for (const domain of ['Network', 'Page', 'Runtime', 'Performance', 'Security']) {
          try { await this.server.enableDomains([domain]); } catch {}
        }
        return JSON.stringify({ success: true, tabId });
      }
      case 'openTab': {
        const targetUrl = args.url || 'about:blank';
        await this.translator.execute({ type: 'evaluate', expression: `window.open(${JSON.stringify(targetUrl)}, '_blank')` });
        
        let targetTab: any = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          await sleep(500 + attempt * 500);
          const tabs = await this.server.listTabs();
          targetTab = tabs.find((t) => t.url === targetUrl) 
                   || tabs.find((t) => t.url.startsWith(targetUrl.replace(/\?.*$/, '')))
                   || tabs[tabs.length - 1];
          if (targetTab && !targetTab.url.includes('chrome://') && !targetTab.url.includes('about:blank')) break;
          targetTab = null;
        }
        
        if (!targetTab) {
          const tabs2 = await this.server.listTabs();
          targetTab = tabs2[tabs2.length - 1];
        }
        
        if (targetTab) {
          await this.server.detachAll();
          try {
            await this.server.attachTab(targetTab.tabId);
          } catch {
            await sleep(1000);
            try { await this.server.attachTab(targetTab.tabId); } catch {}
          }
          for (const domain of ['Network', 'Page', 'Runtime', 'Performance', 'Security']) {
            try { await this.server.enableDomains([domain]); } catch {}
          }
          return JSON.stringify({ success: true, tabId: targetTab.tabId, url: targetTab.url });
        }
        return JSON.stringify({ success: false, error: 'Could not find or attach to new tab' });
      }
      case 'closeTab': {
        const tabId = args.tabId;
        if (!tabId) return JSON.stringify({ error: 'tabId required' });
        if (this.server.getCurrentTabId() === tabId) {
          const tabs = await this.server.listTabs();
          const yt = tabs.find((t) => t.url.includes('youtube.com'));
          if (yt) {
            await this.server.detachAll();
            await this.server.attachTab(yt.tabId);
            for (const domain of ['Network', 'Page', 'Runtime', 'Performance', 'Security']) {
              try { await this.server.enableDomains([domain]); } catch {}
            }
          }
        }
        try { await this.server.closeTab(tabId); } catch (e: any) {
          return JSON.stringify({ success: false, error: e.message });
        }
        return JSON.stringify({ success: true, closed: tabId });
      }
      case 'interceptEnable':
        await this.interceptor.enable();
        return JSON.stringify({ success: true, active: true });
      case 'interceptDisable':
        await this.interceptor.disable();
        return JSON.stringify({ success: true, active: false });
      case 'interceptStatus':
        return JSON.stringify({ active: this.interceptor.isActive(), rules: this.interceptor.listRules() });
      case 'interceptAddRule': {
        const rule = this.interceptor.addRule(args.rule);
        return JSON.stringify({ success: true, rule });
      }
      case 'interceptRemoveRule':
        return JSON.stringify({ success: this.interceptor.removeRule(args.id) });
      case 'interceptClearRules':
        this.interceptor.clearRules();
        return JSON.stringify({ success: true });
      case 'interceptLog':
        return JSON.stringify(this.interceptor.getLogs(args.limit));
      case 'findElement': {
        const results = await this.finder.find(args.query, args.limit || 10);
        return JSON.stringify(results);
      }
      case 'findClick': {
        const el = await this.finder.findOne(args.query);
        if (!el) return JSON.stringify({ success: false, error: `No element found for: ${args.query}` });
        const result = await this.translator.execute({
          type: 'click', selector: el.selector,
        });
        return JSON.stringify({ success: result.ok, found: el, error: result.ok ? undefined : result.error });
      }
      case 'findType': {
        const el = await this.finder.findOne(args.query);
        if (!el) return JSON.stringify({ success: false, error: `No element found for: ${args.query}` });
        const result = await this.translator.execute({
          type: 'type', selector: el.selector, text: args.text, clearFirst: args.clearFirst ?? true,
        });
        return JSON.stringify({ success: result.ok, found: el, error: result.ok ? undefined : result.error });
      }
      case 'captureBody': {
        if (!this.interceptor.isActive()) return JSON.stringify({ error: 'Interceptor not active. Call interceptEnable first.' });
        return JSON.stringify({ hint: 'Use interceptAddRule with action type "log" and captureBody: true' });
      }
      case 'smartType': {
        const query = args.query;
        const text = args.text || '';
        const submit = args.submit !== false;
        const url = (await this.gatherState()).state.url;
        const domain = new URL(url).hostname;

        let useStealth = args.stealth === true;
        if (args.stealth === undefined) {
          try {
            const tech = await this.techSensor.summarize();
            useStealth = tech.antiBot.riskLevel === 'high' || tech.antiBot.riskLevel === 'medium';
          } catch {}
        }

        const ceExpr = (sel: string, txt: string, doSubmit: boolean) =>
          `(async () => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'no element'; el.focus(); await new Promise(r => setTimeout(r, 50)); document.execCommand('selectAll'); await new Promise(r => setTimeout(r, 50)); document.execCommand('insertText', false, ${JSON.stringify(txt)}); if (${doSubmit}) { await new Promise(r => setTimeout(r, 150)); el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',code:'Enter',keyCode:13,which:13,charCode:13,bubbles:true,cancelable:true,composed:true})); } return el.textContent; })()`;

        const doType = async (sel: string, method: string): Promise<boolean> => {
          const check = await this.translator.execute({
            type: 'evaluate',
            expression: `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; return { editable: el.isContentEditable || el.getAttribute('contenteditable') === 'true', tag: el.tagName }; })()`,
          });
          const elInfo = check.ok ? (check as any).value : null;
          if (!elInfo) return false;

          const isCE = method === 'contenteditable' || elInfo.editable;
          if (isCE) {
            const r = await this.translator.execute({ type: 'evaluateAsync', expression: ceExpr(sel, text, submit) });
            return r.ok && r.value !== 'no element';
          } else {
            const r = await this.translator.execute({ type: 'type', selector: sel, text, clearFirst: true, stealth: useStealth });
            if (r.ok && submit) await this.translator.execute({ type: 'press', key: 'Enter' });
            return r.ok;
          }
        };

        const profile = this.siteMemory.get(domain);
        if (profile?.inputs?.[query]) {
          const cached = profile.inputs[query];
          const ok = await doType(cached.selector, cached.method);
          if (ok) return JSON.stringify({ success: true, source: 'cache', domain });
          this.siteMemory.save(domain, { inputs: { [query]: undefined as any } });
        }

        const el = await this.finder.findOne(query);
        if (!el) return JSON.stringify({ success: false, error: `No input found for: ${query}` });

        const method = el.editable ? 'contenteditable' : 'input';
        const ok = await doType(el.selector, method);

        if (ok) {
          this.siteMemory.save(domain, {
            inputs: { [query]: { selector: el.selector, method } },
          });
        }
        return JSON.stringify({ success: ok, source: 'discovered', domain });
      }
      case 'siteMemory': {
        const url = (await this.gatherState()).state.url;
        const domain = new URL(url).hostname;
        const profile = this.siteMemory.get(domain);
        return JSON.stringify({ domain, profile });
      }
      case 'siteMemoryClear': {
        this.siteMemory.clear(args.domain);
        return JSON.stringify({ success: true });
      }
      case 'techScan': {
        const summary = await this.techSensor.summarize();
        return JSON.stringify(summary, null, 2);
      }
      case 'stealthCheck': {
        const summary = await this.techSensor.summarize();
        return JSON.stringify({ antiBot: summary.antiBot, recommendation: summary.antiBot.riskLevel === 'high' ? 'Use stealth mode' : 'Safe to type normally' });
      }
      case 'stealthEnable': {
        this.stealth.activate();
        await this.translator.execute({ type: 'evaluate', expression: STEALTH_PART_1 });
        await sleep(100);
        await this.translator.execute({ type: 'evaluate', expression: STEALTH_PART_2 });
        await sleep(100);
        const r3 = await this.translator.execute({ type: 'evaluate', expression: STEALTH_PART_3 });
        return JSON.stringify({ success: r3.ok, parts: ['core', 'fingerprint', 'misc'] });
      }
      case 'stealthDisable': {
        this.stealth.deactivate();
        const r = await this.translator.execute({
          type: 'evaluate',
          expression: `(() => { delete window.__yautja_stealth; location.reload(); return true; })()`,
        });
        return JSON.stringify({ success: r.ok });
      }
      case 'wsWatch': {
        this.wsInspector.watch();
        return JSON.stringify({ success: true, active: true });
      }
      case 'wsUnwatch': {
        this.wsInspector.unwatch();
        return JSON.stringify({ success: true, active: false });
      }
      case 'wsList': {
        return JSON.stringify(this.wsInspector.listConnections(), null, 2);
      }
      case 'wsFrames': {
        return JSON.stringify(this.wsInspector.getFrames({
          connectionId: args.connectionId,
          direction: args.direction,
          search: args.search,
          limit: args.limit,
        }), null, 2);
      }
      case 'wsStats': {
        return JSON.stringify(this.wsInspector.getStats(), null, 2);
      }
      case 'wsClear': {
        this.wsInspector.clear();
        return JSON.stringify({ success: true });
      }
      case 'osintHarvest': {
        const result = await this.osint.harvest();
        return JSON.stringify(result, null, 2);
      }
      case 'netIntel': {
        const result = await this.netIntel.analyze();
        return JSON.stringify(result, null, 2);
      }
      case 'capturedGql': {
        const tabId = args.tabId;
        const limit = args.limit || 100;
        const result = await this.server.getCapturedGql(tabId, limit);
        return JSON.stringify(result, null, 2);
      }
      case 'clearGql': {
        await this.server.clearCapturedGql(args.tabId);
        return JSON.stringify({ success: true });
      }
      case 'hashAcquire': {
        const url = (await this.gatherState()).state.url;
        let domain = '';
        try { domain = new URL(url).hostname; } catch {}
        const result = await this.learningLoop.acquireHash(
          args.operationName, domain, args.queryTemplate, args.endpoint, args.headers
        );
        return JSON.stringify(result, null, 2);
      }
      case 'hashSeed': {
        const url = (await this.gatherState()).state.url;
        let domain = '';
        try { domain = new URL(url).hostname; } catch {}
        const op = args.operationName;
        if (!op) {
          const all = this.learningLoop.getSeeds(domain);
          return JSON.stringify({ domain, seeds: all }, null, 2);
        }
        const seed = this.hashSeedDB.get(op, domain);
        return JSON.stringify({ domain, seed }, null, 2);
      }
      case 'hashRotations': {
        return JSON.stringify({ rotations: this.learningLoop.getRotations(args.limit || 20) }, null, 2);
      }
      case 'hashSave': {
        const url = (await this.gatherState()).state.url;
        let domain = '';
        try { domain = new URL(url).hostname; } catch {}
        this.hashSeedDB.set({
          operationName: args.operationName,
          hash: args.hash,
          hashPrefix: HashSeedDB.hashPrefix(args.hash),
          queryTemplate: args.queryTemplate || '',
          variables: [],
          signatureFields: [],
          capturedAt: Date.now(),
          lastValidatedAt: Date.now(),
          ttlDays: args.ttlDays || 30,
          rotationCount: 0,
          source: 'external',
        }, domain);
        return JSON.stringify({ success: true, domain, operationName: args.operationName });
      }
      case 'interceptorStart': {
        const installed = await this.learningLoop.startInterceptor();
        return JSON.stringify({
          success: installed,
          active: this.browserInterceptor.isActive(),
          lastError: this.browserInterceptor.getStatus().lastCapturedHash || null,
        });
      }
      case 'interceptorStop': {
        await this.learningLoop.stopInterceptor();
        return JSON.stringify({ success: true });
      }
      case 'interceptorStatus': {
        return JSON.stringify(this.learningLoop.getStatus(), null, 2);
      }
      case 'interceptorPull': {
        const captures = await this.browserInterceptor.pullCaptures();
        return JSON.stringify({ captures, count: captures.length });
      }
      case 'learningStatus': {
        return JSON.stringify(this.learningLoop.getStatus(), null, 2);
      }
      case 'captureRequest': {
        if (!args.requestId) {
          const ids = this.networkCapture.list().map(r => r.id);
          return JSON.stringify({ hint: 'requestId required. Available IDs:', ids: ids.slice(-10) });
        }
        const body = await this.networkCapture.captureRequestBody(args.requestId);
        if (body) this.networkCapture.attachBodyToRequest(args.requestId, 'request', body);
        return JSON.stringify({ requestId: args.requestId, body, length: body?.length || 0 });
      }
      case 'captureResponse': {
        if (!args.requestId) {
          const ids = this.networkCapture.list().map(r => r.id);
          return JSON.stringify({ hint: 'requestId required. Available IDs:', ids: ids.slice(-10) });
        }
        const r = await this.networkCapture.captureResponseBody(args.requestId);
        if (r) this.networkCapture.attachBodyToRequest(args.requestId, 'response', r.body);
        return JSON.stringify({ requestId: args.requestId, length: r?.body.length || 0 });
      }
      case 'captureList': {
        const filters: any = {};
        if (args.urlPattern) filters.urlPattern = args.urlPattern;
        if (args.method) filters.method = args.method;
        if (args.hasMatches) filters.hasMatches = true;
        if (args.limit) filters.limit = args.limit;
        const list = this.networkCapture.list(filters);
        return JSON.stringify({ count: list.length, items: list });
      }
      case 'captureStats': {
        const s = this.networkCapture.stats();
        return JSON.stringify({
          total: s.total,
          withBody: s.withBody,
          withMatches: s.withMatches,
          uniqueMatches: Array.from(s.uniqueMatches),
          persistenceActive: this.networkCapture.isActive(),
          files: this.networkCapture.listFiles(),
        });
      }
      case 'captureSetActive': {
        const active = args.active !== false;
        this.networkCapture.setActive(active);
        return JSON.stringify({ success: true, active });
      }
      case 'captureClear': {
        this.networkCapture.clear();
        return JSON.stringify({ success: true });
      }
      case 'gqlQuery': {
        const url = (await this.gatherState()).state.url;
        let domain = '';
        try { domain = new URL(url).hostname; } catch {}
        const result = await this.gqlClient.query(domain, {
          endpoint: args.endpoint,
          query: args.query,
          variables: args.variables,
          hash: args.hash,
          operationName: args.operationName,
          headers: args.headers,
        });
        return JSON.stringify(result, null, 2);
      }
      case 'gqlCache': {
        const url = (await this.gatherState()).state.url;
        let domain = '';
        try { domain = new URL(url).hostname; } catch {}
        const info = this.gqlCache.get(domain);
        return JSON.stringify({ domain, info }, null, 2);
      }
      case 'gqlCacheAdd': {
        const url = (await this.gatherState()).state.url;
        let domain = '';
        try { domain = new URL(url).hostname; } catch {}
        this.gqlCache.addHash(domain, args.operationName, args.hash, args.query);
        return JSON.stringify({ success: true, domain, operationName: args.operationName });
      }
      case 'gqlCacheList': {
        return JSON.stringify({ domains: this.gqlCache.listDomains() }, null, 2);
      }
      default:
        return `Unknown tool: ${name}`;
    }
  }

  private sendMCP(id: number | string, result: any, error?: any): void {
    const msg: any = { jsonrpc: '2.0', id };
    if (error) msg.error = error;
    else msg.result = result;
    process.stdout.write(JSON.stringify(msg) + '\n');
  }

  private async gatherState(): Promise<{ state: BrowserState; anomalies: Anomaly[] }> {
    const [network, dom, console, performance, security] = await Promise.all([
      this.thermal.summarize(),
      this.em.summarize().catch(() => FALLBACK_DOM),
      this.audio.summarize(),
      this.motion.summarize(),
      this.threat.summarize(),
    ]);

    const anomalies: Anomaly[] = [
      ...this.thermal.getAnomalies(),
      ...await this.em.getAnomalies().catch(() => []),
      ...await this.audio.getAnomalies(),
      ...await this.motion.getAnomalies(),
      ...await this.threat.getAnomalies(),
    ];

    return {
      state: {
        url: dom.url || '',
        title: dom.semantic.title,
        readyState: 'complete',
        timestamp: Date.now(),
        network, dom, console, performance, security,
      },
      anomalies,
    };
  }
}

const MCP_TOOLS = [
  {
    name: 'observe',
    description: 'Get a focused observation of the browser state based on a question.',
    inputSchema: {
      type: 'object' as const,
      properties: { question: { type: 'string', description: 'What you want to know' } },
      required: ['question'],
    },
  },
  {
    name: 'act',
    description: 'Execute a browser action (navigate, click, type, evaluate, screenshot, etc).',
    inputSchema: {
      type: 'object' as const,
      properties: { action: { type: 'object', description: 'Action object with type field' } },
      required: ['action'],
    },
  },
  {
    name: 'inspect',
    description: 'Deep-dive into a sensor domain (network, dom, console, performance, security).',
    inputSchema: {
      type: 'object' as const,
      properties: { domain: { type: 'string', enum: ['network', 'dom', 'console', 'performance', 'security'] } },
      required: ['domain'],
    },
  },
  {
    name: 'diff',
    description: 'Show what changed since the last action.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'reattach',
    description: 'Re-attach to the active browser tab (use after tab switch/close).',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'listTabs',
    description: 'List all open browser tabs with URLs and active state.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'switchTab',
    description: 'Switch to a specific tab by its tabId (from listTabs).',
    inputSchema: {
      type: 'object' as const,
      properties: { tabId: { type: 'number', description: 'Tab ID to switch to' } },
      required: ['tabId'],
    },
  },
  {
    name: 'openTab',
    description: 'Open a new tab with a URL and attach to it. Does NOT overwrite current tab.',
    inputSchema: {
      type: 'object' as const,
      properties: { url: { type: 'string', description: 'URL to open' } },
      required: ['url'],
    },
  },
  {
    name: 'closeTab',
    description: 'Close a tab by its tabId.',
    inputSchema: {
      type: 'object' as const,
      properties: { tabId: { type: 'number', description: 'Tab ID to close' } },
      required: ['tabId'],
    },
  },
  {
    name: 'interceptEnable',
    description: 'Enable network request interception (starts the Fetch domain).',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'interceptDisable',
    description: 'Disable network request interception and clear all rules.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'interceptStatus',
    description: 'Check if interception is active and list current rules.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'interceptAddRule',
    description: 'Add an interception rule. Rule: {id, enabled, urlPattern, method?, action}. Actions: modify (headers), block, mock (status+body), redirect (url), log.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        rule: {
          type: 'object',
          description: 'Interception rule object',
          properties: {
            id: { type: 'string', description: 'Unique rule ID' },
            enabled: { type: 'boolean', description: 'Whether rule is active' },
            urlPattern: { type: 'string', description: 'Substring to match in URL' },
            method: { type: 'string', description: 'HTTP method to match (optional)' },
            action: {
              type: 'object',
              description: 'modify={headers} | block={reason} | mock={status,body,contentType} | redirect={url} | log',
            },
          },
        },
      },
      required: ['rule'],
    },
  },
  {
    name: 'interceptRemoveRule',
    description: 'Remove an interception rule by ID.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'interceptClearRules',
    description: 'Remove all interception rules.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'interceptLog',
    description: 'Get log of intercepted requests.',
    inputSchema: {
      type: 'object' as const,
      properties: { limit: { type: 'number', description: 'Max entries to return' } },
    },
  },
  {
    name: 'findElement',
    description: 'Find interactive elements by text/description instead of CSS selectors. Returns ranked matches with selectors.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'What element to find (e.g. "login button", "search box", "submit")' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'findClick',
    description: 'Find an element by text and click it in one step. Much more robust than CSS selectors.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'What to click (e.g. "login", "submit", "sign in with google")' },
      },
      required: ['query'],
    },
  },
  {
    name: 'findType',
    description: 'Find an input by text and type into it in one step.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Which input to find (e.g. "email", "password", "username")' },
        text: { type: 'string', description: 'Text to type' },
        clearFirst: { type: 'boolean', description: 'Clear field first (default true)' },
      },
      required: ['query', 'text'],
    },
  },
  {
    name: 'captureBody',
    description: 'Hint: enable interceptor and add a rule with action type "log" and captureBody: true to capture request/response bodies.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'smartType',
    description: 'Smart type: finds the right input, writes with the correct method, auto-submits. Auto-detects anti-bot protection and switches to stealth mode (human-like key events with jitter). Caches selector per domain.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'What input to find (e.g. "search", "email", "ask anything")' },
        text: { type: 'string', description: 'Text to type' },
        submit: { type: 'boolean', description: 'Press Enter after typing (default true)' },
        stealth: { type: 'boolean', description: 'Force stealth mode (default: auto-detect)' },
      },
      required: ['query', 'text'],
    },
  },
  {
    name: 'siteMemory',
    description: 'Show cached selectors for the current domain.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'siteMemoryClear',
    description: 'Clear site memory cache for a domain.',
    inputSchema: {
      type: 'object' as const,
      properties: { domain: { type: 'string', description: 'Domain to clear (omit for all)' } },
    },
  },
  {
    name: 'techScan',
    description: 'Detect technologies on the current page: frameworks, CDN, analytics, CMS, payment, JS libraries. Also detects anti-bot services (Cloudflare, reCAPTCHA, DataDome, etc).',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'stealthCheck',
    description: 'Check if the current page has anti-bot protection. Returns risk level and recommendation.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'stealthEnable',
    description: 'Inject stealth overrides: navigator.webdriver=false, fake plugins, canvas noise, WebGL spoof, AudioContext noise, Error.stack scrubbing, permission spoofing. Bypasses most bot detection.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'stealthDisable',
    description: 'Disable stealth mode and reload the page.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'wsWatch',
    description: 'Start monitoring WebSocket traffic (all WS connections and frames).',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'wsUnwatch',
    description: 'Stop monitoring WebSocket traffic.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'wsList',
    description: 'List all WebSocket connections (active and closed) with frame counts.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'wsFrames',
    description: 'Get WebSocket frames with filters. Search for auth tokens, specific messages, etc.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connectionId: { type: 'string', description: 'Filter by connection ID (optional)' },
        direction: { type: 'string', enum: ['sent', 'received'], description: 'Filter by direction (optional)' },
        search: { type: 'string', description: 'Search substring in frame payload (optional)' },
        limit: { type: 'number', description: 'Max frames to return (default 50)' },
      },
    },
  },
  {
    name: 'wsStats',
    description: 'WebSocket traffic summary: total connections, frames sent/received, data volume.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'wsClear',
    description: 'Clear all WebSocket buffer data.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'osintHarvest',
    description: 'Extract intelligence from current page: emails, phones, social profiles (Twitter/GitHub/LinkedIn/Instagram/etc), crypto addresses (BTC/ETH), IBANs, API keys, OpenGraph, JSON-LD, external links, forms. One-command OSINT collection.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'netIntel',
    description: 'Network intelligence: discover hidden APIs, extract auth tokens (JWT/session/API keys from localStorage/cookies/meta), map infrastructure (CDN/analytics/tracking domains), analyze cookies, find WebSocket URLs.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'capturedGql',
    description: 'Get captured GQL requests from the extension content script (persisted queries + operation names + hashes). Filter by tabId, set limit.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tabId: { type: 'number', description: 'Filter by current tab (optional)' },
        limit: { type: 'number', description: 'Max items to return (default 100)' },
      },
    },
  },
  {
    name: 'clearGql',
    description: 'Clear captured GQL buffer. Filter by tabId or clear all.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tabId: { type: 'number', description: 'Clear only this tab (optional)' },
      },
    },
  },
  {
    name: 'gqlQuery',
    description: 'Generic GraphQL query client. Supports raw queries OR persisted queries (hash). Auto-detects endpoint, caches hashes per domain. Pass hash alone if query is cached server-side. Pass query for raw. Returns data or errors with fallback hints.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        endpoint: { type: 'string', description: 'GQL endpoint URL (optional, uses cache)' },
        query: { type: 'string', description: 'GraphQL query string (raw mode)' },
        variables: { type: 'object', description: 'Query variables (optional)' },
        hash: { type: 'string', description: 'SHA256 hash of persisted query (persisted mode)' },
        operationName: { type: 'string', description: 'Operation name (required for persisted mode)' },
        headers: { type: 'object', description: 'Extra HTTP headers (optional)' },
      },
    },
  },
  {
    name: 'gqlCache',
    description: 'Show cached GQL queries and endpoint for current domain.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'gqlCacheAdd',
    description: 'Add a known operation hash to the cache for current domain. Use after discovering hash via reverse engineering.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        operationName: { type: 'string', description: 'Operation name (e.g. "FollowedChannels")' },
        hash: { type: 'string', description: 'SHA256 hash' },
        query: { type: 'string', description: 'Full query string (optional)' },
      },
      required: ['operationName', 'hash'],
    },
  },
  {
    name: 'gqlCacheList',
    description: 'List all domains with cached GQL queries.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'hashAcquire',
    description: 'Acquire/rediscover a hash for an operation. Tries cache, external sources, browser intercept, and template inference in order. Returns source, attempts, and latency.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        operationName: { type: 'string', description: 'Operation name (e.g. "FollowedChannels")' },
        queryTemplate: { type: 'string', description: 'Optional GraphQL query string for inference fallback' },
        endpoint: { type: 'string', description: 'Optional endpoint override' },
        headers: { type: 'object', description: 'Optional extra headers' },
      },
      required: ['operationName'],
    },
  },
  {
    name: 'hashSeed',
    description: 'Show hash seeds (operation + hash + query template) for current domain. Pass operationName to get a specific seed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        operationName: { type: 'string', description: 'Operation name (optional)' },
      },
    },
  },
  {
    name: 'hashRotations',
    description: 'Show detected hash rotation events with timestamps.',
    inputSchema: {
      type: 'object' as const,
      properties: { limit: { type: 'number', description: 'Max events to return (default 20)' } },
    },
  },
  {
    name: 'hashSave',
    description: 'Manually save a hash for an operation (e.g. from external research). Persists to seed DB.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        operationName: { type: 'string' },
        hash: { type: 'string' },
        queryTemplate: { type: 'string' },
        ttlDays: { type: 'number' },
      },
      required: ['operationName', 'hash'],
    },
  },
  {
    name: 'interceptorStart',
    description: 'Install persistent fetch/XHR interceptor via Page.addScriptToEvaluateOnNewDocument. Captures GQL operations + hashes automatically on every page load.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'interceptorStop',
    description: 'Uninstall the persistent browser interceptor.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'interceptorStatus',
    description: 'Get interceptor status and learning loop stats.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'interceptorPull',
    description: 'Pull currently captured GQL requests from the browser context.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'learningStatus',
    description: 'Get full learning loop status: interceptor state, seed count, rotations, recent signals.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'captureRequest',
    description: 'Capture decrypted request POST body via CDP Network.getRequestPostData. SSL-safe.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        requestId: { type: 'string', description: 'Network request ID' },
      },
      required: ['requestId'],
    },
  },
  {
    name: 'captureResponse',
    description: 'Capture decrypted response body via CDP Network.getResponseBody. SSL-safe.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        requestId: { type: 'string', description: 'Network request ID' },
      },
      required: ['requestId'],
    },
  },
  {
    name: 'captureList',
    description: 'List captured requests. Filter by URL, method, or pattern matches (JWT, API keys, PII).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        urlPattern: { type: 'string' },
        method: { type: 'string' },
        hasMatches: { type: 'boolean' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'captureStats',
    description: 'Stats on captured traffic: total, with body, with patterns detected, files on disk.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'captureSetActive',
    description: 'Enable/disable JSONL persistence. When active, every request is appended to .yautja-network-captures/capture-YYYY-MM-DD.jsonl.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        active: { type: 'boolean' },
      },
      required: ['active'],
    },
  },
  {
    name: 'captureClear',
    description: 'Clear all captured requests from memory (does not delete files).',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

const FALLBACK_DOM = {
  url: '',
  semantic: { pageType: 'unknown', title: '', headings: [] as string[], mainContentPreview: '', language: '' },
  interactive: { buttons: [] as any[], links: [] as any[], inputs: [] as any[], total: 0 },
  structural: { totalElements: 0, depth: 0, iframes: 0, images: 0, scripts: 0, forms: 0, stylesheets: 0 },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
