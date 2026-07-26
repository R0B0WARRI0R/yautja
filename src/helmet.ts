import { createInterface } from 'readline';
import fs from 'fs';
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
import { MacroRunner } from './macros/runner.js';
import { loadBuiltins, loadUserMacros } from './macros/loader.js';
import { ExtensionIntel } from './intel/extension-intel.js';
import { CdpRemoteClient } from './connection/cdp-remote.js';
import { MitmProxyServer } from './proxy/mitm-proxy.js';
import { success, failure, SCHEMA_VERSION } from './doctrine/types.js';
import type { YautjaError, YautjaResponse, OperationMeta, StateMeta, ContextMeta } from './doctrine/types.js';
import { toYautjaError } from './doctrine/registry.js';
import { classifyLegacyError } from './doctrine/classifier.js';
import { generateTraceId, generateOperationId } from './doctrine/ids.js';
import { TelemetryCollector } from './doctrine/telemetry.js';
import { createRecoveryStatsTool } from './tools/recovery-stats.js';
import { RecoveryMachine } from './doctrine/recovery-machine.js';
import { StateIntegrityTracker } from './doctrine/state-integrity.js';
import { IdempotencyRegistry } from './doctrine/idempotency.js';
import { DEFAULT_RETRY_POLICIES } from './doctrine/retry-engine.js';
import { InputSessionMemory } from './memory/input-session.js';
import { ensureEmpty } from './arsenal/ensure-empty.js';
import type { EnsureEmptyStrategy } from './arsenal/ensure-empty.js';
import { runTypeTransaction } from './arsenal/type-transaction.js';
import type { TypeTxResult } from './arsenal/type-transaction.js';
import { waitForUi } from './arsenal/wait-for-ui.js';
import type { WaitPredicate } from './arsenal/wait-for-ui.js';
import { extractAnswer } from './arsenal/extract-answer.js';
import { SiteProfileStore, isInterceptAllowed, isUrlAllowed, SiteProfileSchema } from './doctrine/site-profile.js';
import { runPreflight, mapPreflightCode } from './doctrine/preflight.js';
import { EconomicSensor } from './vision/economic-sensor.js';
import { TabRegistry } from './connection/tab-registry.js';
import { SessionGates, RateLimiter } from './doctrine/gates.js';
import { browserFetch } from './intel/browser-fetch.js';
import { EvidenceStore } from './intel/evidence-store.js';
import { exportHarToFile } from './intel/har-export.js';
import { surfaceFromNetwork, buildBundleScanScript, mergeEndpoints } from './intel/api-surface.js';
import type { ApiEndpoint } from './intel/api-surface.js';
import { responseDiff } from './intel/response-diff.js';
import { trustedClick } from './arsenal/trusted-input.js';
import { trustedFileChooser } from './arsenal/file-chooser.js';
import { detectCapabilities } from './doctrine/capabilities.js';
import { SessionSnapshotStore } from './memory/session-snapshot.js';
import { TraceStore } from './doctrine/trace-store.js';
import { loadBackendConfig, delegate, isSuperapiConfigured, isChromeDevtoolsConfigured } from './doctrine/backends.js';
import type { DelegableCapability } from './doctrine/backends.js';
import { fileURLToPath } from 'url';
import path from 'path';
import type { BrowserState } from './memory/browser-state.js';
import type { Anomaly } from './vision/base-sensor.js';
import type { BrowserAction, ActionResult } from './arsenal/action-types.js';
import { arsenalToDoctrine } from './arsenal/errors.js';
import type { ArsenalErrorType } from './arsenal/errors.js';

export interface HelmetConfig {
  port: number;
  autoAttach: boolean;
  /** Post-action settle delay in ms (P12: conditional — skipped for wait actions). 0 disables. */
  postActionDelayMs: number;
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
  postActionDelayMs: 1500,
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
  private macroRunner: MacroRunner;
  private extIntel: ExtensionIntel;
  private cdpRemote: CdpRemoteClient;
  private mitmProxy: MitmProxyServer;
  private tabRegistry: TabRegistry;
  private telemetry = new TelemetryCollector();
  private recoveryStats = createRecoveryStatsTool(this.telemetry);
  private sessionId = `sess_${generateOperationId().slice(3)}`;
  private inputSession = new InputSessionMemory();
  private profileStore = new SiteProfileStore([
    fileURLToPath(new URL('../profiles', import.meta.url)),
    `${process.env.APPDATA || process.env.HOME || '/tmp'}/.yautja/profiles`,
  ]);
  private lastPreflight: { url: string; pass: boolean; reasons: string[]; at: number } | null = null;
  private queryBurn = new Map<string, number>();
  private economicSensor = new EconomicSensor(this.profileStore, {
    getCookies: async () => {
      const r = await this.translator.execute({ type: 'getCookies' });
      return r.ok ? (r.value ?? []) : [];
    },
  });
  private gates = new SessionGates(
    path.join(process.env.APPDATA || process.env.HOME || '/tmp', '.yautja', 'sessions', this.sessionId),
    this.sessionId,
  );
  private rateLimiter = new RateLimiter();
  private evidenceStore = new EvidenceStore(
    path.join(process.env.APPDATA || process.env.HOME || '/tmp', '.yautja', 'evidence'),
  );
  private analystMode = process.env.YAUTJA_ANALYST_MODE === '1';
  private lastFetch: { url: string; method: string; host: string; body: string } | null = null;
  private snapshotStore = new SessionSnapshotStore(
    path.join(process.env.APPDATA || process.env.HOME || '/tmp', '.yautja', 'snapshots'),
  );
  private traceStore = new TraceStore({
    rootDir: path.join(process.env.APPDATA || process.env.HOME || '/tmp', '.yautja', 'traces'),
    ttlDays: 7,
  });
  private idempotency = new IdempotencyRegistry({ defaultTtlMs: 300_000 });
  private stateTracker = new StateIntegrityTracker(this.sessionId);
  private recoveryMachine = new RecoveryMachine({
    tracker: this.stateTracker,
    idempotency: this.idempotency,
    policies: {
      ...DEFAULT_RETRY_POLICIES,
      smartType: {
        policy_id: 'smartType.v1',
        max_attempts: 2,
        backoff: { kind: 'fixed', base_ms: 300, max_ms: 1000 },
        retry_on: ['YJ.ACT.TYPE_PARTIAL'],
        never_retry_on: ['YJ.ACT.TYPE_RETRY_BLOCKED', 'YJ.ACT.INPUT_NOT_CLEARABLE', 'YJ.ACT.DOM_TARGET_NOT_FOUND'],
        escalation: ['ROLLBACK_TO_CHECKPOINT', 'ABORT'],
      },
    },
  });
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
    this.macroRunner = new MacroRunner(this);
    this.extIntel = new ExtensionIntel();
    this.cdpRemote = new CdpRemoteClient(9222);
    this.mitmProxy = new MitmProxyServer(9877);
    this.tabRegistry = new TabRegistry(this.server);
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

    // Load macros (fail-soft — boot continues even if loading fails)
    try {
      const builtinsResult = await loadBuiltins(this.macroRunner);
      const userResult = await loadUserMacros(this.macroRunner);
      process.stderr.write(
        `[Yautja] Macros loaded: ${builtinsResult.loaded.length} builtin, ${userResult.loaded.length} user\n`,
      );
    } catch (err) {
      process.stderr.write(`[Yautja] macro loading failed (continuing): ${err}\n`);
    }

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
    // Stop MITM proxy if running and clear browser proxy settings
    if (this.mitmProxy.isRunning()) {
      await this.server.proxyStop().catch(() => {});
      await this.mitmProxy.stop();
    }
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

  /** Current page URL via CDP, falling back to the memory snapshot. */
  private async currentPageUrl(): Promise<string> {
    try {
      const r = await this.server.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
      if (typeof r?.result?.value === 'string') return r.result.value;
    } catch {}
    return this.memory.snapshot()?.url ?? '';
  }

  /** Shared cookie context for preflight / economic sensor / snapshots. */
  private async getCookiesCtx(): Promise<Array<{ name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean }>> {
    const r = await this.translator.execute({ type: 'getCookies' });
    return r.ok ? (r.value ?? []) : [];
  }

  async observe(question: string): Promise<string> {
    return (await this.observeCore(question)).text;
  }

  private async observeCore(question: string): Promise<{ text: string; state: BrowserState }> {
    await this.ensureAttached().catch(() => {});
    const { state, anomalies } = await this.gatherState();
    const observation = this.router.observe(question, state, anomalies);
    return { text: observation.text, state };
  }

  async act(action: BrowserAction): Promise<string> {
    const { result, changes } = await this.actCore(action);
    if (!result.ok) {
      return JSON.stringify({
        success: false,
        error: result.error.message,
        type: result.error.type,
        recoveryHint: result.error.recoveryHint,
      });
    }
    return JSON.stringify({ success: true, value: result.value, changes });
  }

  private async actCore(action: BrowserAction): Promise<{
    result: ActionResult;
    before: BrowserState;
    after: BrowserState;
    changes: string[];
  }> {
    await this.ensureAttached().catch(() => {});
    const { state: beforeState } = await this.gatherState();
    this.memory.update(beforeState);

    const result = await this.translator.execute(action);

    // P12: the post-action sleep is conditional — a wait action already
    // waits declaratively, and the delay is configurable.
    if (action.type !== 'wait' && this.config.postActionDelayMs > 0) {
      await sleep(this.config.postActionDelayMs);
    }

    const { state: afterState } = await this.gatherState();
    this.memory.update(afterState);

    const diff = this.memory.diff();
    return { result, before: beforeState, after: afterState, changes: diff?.fields ?? [] };
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
              capabilities: { tools: {}, resources: {} },
              serverInfo: { name: 'yautja', version: '0.2.0' },
              schema_version: SCHEMA_VERSION,
            });
            break;

          case 'notifications/initialized':
            break;

          case 'tools/list':
            this.sendMCP(id, { tools: MCP_TOOLS });
            break;

          case 'tools/call': {
            const result = await this.envelopeToolCall(params.name, params.arguments || {});
            this.sendMCP(id, {
              content: [{ type: 'text', text: result }],
            });
            break;
          }

          case 'ping':
            this.sendMCP(id, {});
            break;

          case 'resources/list': {
            // GC first (P17: TTL 7 días), then list traces + evidence.
            await this.traceStore.purgeExpired().catch(() => []);
            this.evidenceStore.gc(7);
            const traces = await this.traceStore.listTraces();
            const resources: any[] = traces.map((t) => ({
              uri: `resource://yautja/traces/${t}/network`,
              name: `trace ${t} (network window)`,
              mimeType: 'application/json',
            }));
            for (const rec of this.evidenceStore.list()) {
              resources.push({
                uri: `resource://yautja/evidence/${rec.id}`,
                name: `evidence ${rec.id} (${rec.host}${rec.url ? ' ' + rec.url : ''})`,
                mimeType: 'application/json',
              });
            }
            this.sendMCP(id, { resources });
            break;
          }

          case 'resources/read': {
            const uri = String(params?.uri ?? '');
            let text: string | null = null;
            if (uri.startsWith('resource://yautja/traces/')) {
              text = await this.traceStore.readResource(uri);
            } else if (uri.startsWith('resource://yautja/evidence/')) {
              const found = this.evidenceStore.get(uri.slice('resource://yautja/evidence/'.length));
              text = found?.body ?? null;
            }
            if (text === null) {
              this.sendMCP(id, null, { code: -32602, message: `Unknown or expired resource: ${uri}` });
            } else {
              this.sendMCP(id, { contents: [{ uri, mimeType: 'application/json', text }] });
            }
            break;
          }

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

  private async handleToolCall(name: string, args: any): Promise<string | YautjaResponse<unknown>> {
    switch (name) {
      case 'observe': {
        const { text, state } = await this.observeCore(args.question || 'overview');
        return this.nativeSuccess('observe', args, { text }, {
          url_after: state.url || undefined,
          state_integrity: 'known',
        });
      }
      case 'act': {
        const action = args.action as BrowserAction;
        // P13: profile urlDenyRegex applies to the navigation destination
        if (action?.type === 'navigate' && typeof action.url === 'string') {
          const destProfile = this.profileStore.match(action.url);
          if (!isUrlAllowed(destProfile, action.url)) {
            return this.nativeFailure('act', args, toYautjaError('YJ.POLICY.GATE_DENIED', {
              message: `Site profile "${destProfile.id}" denies navigation to ${action.url} (urlDenyRegex)`,
            }));
          }
        }
        // P14 r2: evaluate(fetch) must not bypass browserFetch gates
        if ((action?.type === 'evaluate' || action?.type === 'evaluateAsync') &&
            typeof (action as any).expression === 'string' &&
            /\bfetch\s*\(|XMLHttpRequest/.test((action as any).expression)) {
          const pageProfile = this.profileStore.match(await this.currentPageUrl());
          const policy = pageProfile.rules.allowEvaluateFetch;
          if (policy === 'none') {
            this.gates.audit({ type: 'evaluateFetch', denied: true, profile: pageProfile.id, expression: (action as any).expression.slice(0, 200) });
            return this.nativeFailure('act', args, toYautjaError('YJ.POLICY.GATE_DENIED', {
              message: `Site profile "${pageProfile.id}" forbids evaluate(fetch) (allowEvaluateFetch: none). Use browserFetch with a session grant instead.`,
            }));
          }
          this.gates.audit({ type: 'evaluateFetch', denied: false, policy, profile: pageProfile.id, expression: (action as any).expression.slice(0, 200) });
        }
        const { result, before, after, changes } = await this.actCore(action);
        const stateMeta: Partial<StateMeta> = {
          url_before: before.url || undefined,
          url_after: after.url || undefined,
          state_integrity: 'known',
        };
        if (!result.ok) {
          return this.nativeFailure('act', args, arsenalToDoctrine(result.error), stateMeta);
        }
        return this.nativeSuccess('act', args, { success: true, value: result.value, changes }, stateMeta);
      }
      case 'inspect': {
        const domain = args.domain as string;
        await this.ensureAttached().catch(() => {});
        const { state } = await this.gatherState();
        const summaries: Record<string, unknown> = {
          network: state.network,
          dom: state.dom,
          console: state.console,
          performance: state.performance,
          security: state.security,
        };
        if (!Object.prototype.hasOwnProperty.call(summaries, domain)) {
          return this.nativeFailure('inspect', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
            message: `Unknown domain "${domain}". Use: network, dom, console, performance, security`,
          }));
        }
        return this.nativeSuccess('inspect', args, summaries[domain], {
          url_after: state.url || undefined,
          state_integrity: 'known',
        });
      }
      case 'diff': {
        const diff = this.memory.diff();
        if (!diff) {
          return this.nativeSuccess('diff', args, {
            diff: null,
            message: 'No previous state to compare. Perform an action first.',
          });
        }
        return this.nativeSuccess('diff', args, diff);
      }
      case 'reattach': {
        try {
          await this.reattach();
          return this.nativeSuccess('reattach', args, {
            success: true,
            tabId: this.server.getCurrentTabId(),
          }, { state_integrity: 'restored' });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return this.nativeFailure('reattach', args, toYautjaError('YJ.NET.SESSION_STATE_UNKNOWN', { message }));
        }
      }
      case 'listTabs': {
        const tabs = await this.server.listTabs();
        return this.nativeSuccess('listTabs', args, { tabs, currentTabId: this.server.getCurrentTabId() });
      }
      case 'switchTab': {
        const tabId = args.tabId;
        if (!tabId) {
          return this.nativeFailure('switchTab', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
            message: 'tabId required',
          }));
        }
        // P13.5: canonical tab switch with location.href verification
        const sw = await this.tabRegistry.switchVerified(Number(tabId));
        if (!sw.ok) {
          if (sw.reason === 'not_found') {
            return this.nativeFailure('switchTab', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
              message: `Tab not found: ${tabId}. Call listTabs to re-enumerate.`,
            }));
          }
          return this.nativeFailure('switchTab', args, toYautjaError('YJ.ACT.TAB_SWITCH_MISMATCH', {
            message: `Attached page (${sw.actualUrl}) does not match requested tab (${sw.expectedUrl})`,
          }));
        }
        for (const domain of ['Network', 'Page', 'Runtime', 'Performance', 'Security']) {
          try { await this.server.enableDomains([domain]); } catch {}
        }
        this.attached = true;
        return this.nativeSuccess('switchTab', args, {
          success: true,
          tabId: sw.tabId,
          url: sw.url,
          previousTabId: sw.previousTabId,
        }, { state_integrity: 'known' });
      }
      case 'openTab': {
        const targetUrl = args.url || 'about:blank';
        // P13.5: canonical open — verified URL post-attach, previous active
        // tab captured BEFORE opening (fixes wrong-URL reports).
        const opened = await this.tabRegistry.openVerified(targetUrl);
        for (const domain of ['Network', 'Page', 'Runtime', 'Performance', 'Security']) {
          try { await this.server.enableDomains([domain]); } catch {}
        }
        this.attached = opened.attached;
        return this.nativeSuccess('openTab', args, {
          success: opened.attached,
          tabId: opened.tabId,
          url: opened.url,
          attached: opened.attached,
          previousActiveTabId: opened.previousActiveTabId,
        }, { state_integrity: opened.attached ? 'known' : 'unknown' });
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
      case 'interceptEnable': {
        // P13: site profile enforcement — a profile with intercept:forbid
        // denies interception explicitly (no silent ignore).
        const profile = this.profileStore.match(await this.currentPageUrl());
        if (!isInterceptAllowed(profile)) {
          return this.nativeFailure('interceptEnable', args, toYautjaError('YJ.POLICY.GATE_DENIED', {
            message: `Site profile "${profile.id}" forbids request interception on this domain`,
          }));
        }
        await this.interceptor.enable();
        return JSON.stringify({ success: true, active: true });
      }
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
      case 'waitFor': {
        const anyOf = args.anyOf as WaitPredicate[] | undefined;
        const allOf = args.allOf as WaitPredicate[] | undefined;
        if ((!anyOf || anyOf.length === 0) && (!allOf || allOf.length === 0)) {
          return this.nativeFailure('waitFor', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
            message: 'anyOf or allOf with at least one predicate is required',
          }));
        }
        const timeoutMs = args.timeoutMs ?? 30_000;
        const result = await waitForUi(
          { transport: this.server, getPendingRequests: () => this.thermal.getPendingCount() },
          { anyOf, allOf, timeoutMs, pollMs: args.pollMs ?? 250 },
        );
        if (result.matched === 'timeout') {
          return this.nativeFailure('waitFor', args, toYautjaError('YJ.ACT.WAIT_TIMEOUT', {
            message: `No wait predicate matched within ${timeoutMs}ms`,
          }));
        }
        let snapshot: { url: string; title: string } | undefined;
        try {
          const { state } = await this.gatherState();
          snapshot = { url: state.url, title: state.dom?.semantic?.title ?? '' };
        } catch {}
        return this.nativeSuccess('waitFor', args, {
          matched: result.matched,
          which: result.which,
          elapsedMs: result.elapsedMs,
          snapshot,
        });
      }
      case 'extractAnswer': {
        const result = await extractAnswer(
          { transport: this.server, getPendingRequests: () => this.thermal.getPendingCount() },
          {
            root: args.root,
            waitUntil: args.waitUntil,
            stableMs: args.stableMs,
            chunkChars: args.chunkChars,
            scrubSelectors: args.scrubSelectors,
            maxChars: args.maxChars,
            timeoutMs: args.timeoutMs,
            pollMs: args.pollMs,
          },
        );
        return this.nativeSuccess('extractAnswer', args, result);
      }
      case 'ensureEmpty': {
        let selector = args.selector as string | undefined;
        if (!selector && args.query) {
          const el = await this.finder.findOne(args.query);
          if (!el) {
            return this.nativeFailure('ensureEmpty', args, toYautjaError('YJ.ACT.DOM_TARGET_NOT_FOUND', {
              message: `No element found for: ${args.query}`,
            }));
          }
          selector = el.selector;
        }
        if (!selector) {
          return this.nativeFailure('ensureEmpty', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
            message: 'query or selector is required',
          }));
        }
        const strategy = (args.strategy as EnsureEmptyStrategy) ?? 'auto';
        const result = await ensureEmpty(this.server, selector, strategy);
        if (!result.found) {
          return this.nativeFailure('ensureEmpty', args, toYautjaError('YJ.ACT.DOM_TARGET_NOT_FOUND', {
            message: `Element not found: ${selector}`,
          }));
        }
        const tabId = this.server.getCurrentTabId() ?? 0;
        let residualBackupId: string | undefined;
        if (!result.wasClean && args.backup !== false && result.residual) {
          residualBackupId = this.inputSession.recordBackup(tabId, selector, result.residual);
        }
        // A successful clean lifts the anti blind-retry block for this selector.
        if (result.afterClean) this.inputSession.clear(tabId, selector);
        if (!result.afterClean) {
          return this.nativeFailure('ensureEmpty', args, toYautjaError('YJ.ACT.INPUT_NOT_CLEARABLE', {
            message: `Input not clearable with strategy ${result.strategyUsed}: ${selector}`,
          }));
        }
        return this.nativeSuccess('ensureEmpty', args, {
          wasClean: result.wasClean,
          afterClean: result.afterClean,
          strategyUsed: result.strategyUsed,
          residualBackupId,
          selectorResolved: selector,
        });
      }
      case 'smartType': {
        const query = args.query as string;
        const text = typeof args.text === 'string' ? args.text : '';
        if (!query) {
          return this.nativeFailure('smartType', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
            message: 'query is required',
          }));
        }
        const submit = args.submit !== false;
        const transactional = args.transactional !== false;
        const doVerify = args.verify !== false;
        const clearFirst = args.clearFirst !== false;
        const onPartial = (args.onPartial as 'rollback' | 'leave' | 'error') ?? 'rollback';

        const url = (await this.gatherState()).state.url;
        let domain = '';
        try { domain = new URL(url).hostname; } catch {}
        let origin = '';
        try { origin = url ? new URL(url).origin : ''; } catch {}

        // Stealth: explicit arg, or auto via tech sensor (anti-bot risk)
        let useStealth = args.stealth === true;
        if (args.stealth === undefined) {
          try {
            const tech = await this.techSensor.summarize();
            useStealth = tech.antiBot.riskLevel === 'high' || tech.antiBot.riskLevel === 'medium';
          } catch {}
        }

        // ─── P13: site profile enforcement ─────────────────────
        const siteProfile = this.profileStore.match(url);
        if (siteProfile.id !== 'default') {
          // CAPTCHA stop_hard: abort before typing, never retry
          if (siteProfile.rules.onCaptcha === 'stop_hard') {
            try {
              const tech = await this.techSensor.summarize();
              const captchaSignals = ((tech.antiBot as any).signals ?? []).filter((s: string) => /recaptcha|hcaptcha|turnstile/i.test(s));
              if (captchaSignals.length > 0) {
                return this.nativeFailure('smartType', args, toYautjaError('YJ.OPSEC.CAPTCHA_DETECTED', {
                  message: `CAPTCHA challenge detected on ${domain}: ${captchaSignals.join(', ')}`,
                }));
              }
            } catch {}
          }
          // Preflight checks (quota cookies, abortIf rules)
          if (siteProfile.preFlight.length > 0) {
            const pf = await runPreflight(siteProfile, { getCookies: () => this.getCookiesCtx() });
            this.lastPreflight = { url, pass: pf.pass, reasons: pf.reasons, at: Date.now() };
            if (!pf.pass) {
              return this.nativeFailure('smartType', args, toYautjaError(mapPreflightCode(pf.abortCode ?? ''), {
                message: `Preflight abort on ${domain}: ${pf.reasons[pf.reasons.length - 1]}`,
              }));
            }
          }
          // Session query burn limit
          const maxQ = siteProfile.rules.maxAgentQueriesPerSession;
          if (submit && maxQ !== undefined && (this.queryBurn.get(domain) ?? 0) >= maxQ) {
            return this.nativeFailure('smartType', args, toYautjaError('YJ.POLICY.QUOTA_EXHAUSTED', {
              message: `Session query budget exhausted on ${domain} (limit ${maxQ}/session)`,
            }));
          }
          // stealth: required → auto-enable (or hard fail in strict mode)
          if (siteProfile.rules.stealth === 'required') {
            if (args.stealth === false && siteProfile.rules.stealthEnforcement === 'strict') {
              return this.nativeFailure('smartType', args, toYautjaError('YJ.POLICY.GATE_DENIED', {
                message: `Site profile "${siteProfile.id}" requires stealth typing`,
              }));
            }
            useStealth = true;
          }
        }

        // Resolve selector: site memory cache → finder (v2: fresh entries only)
        let selector: string | null = null;
        let isCE = false;
        let source: 'cache' | 'discovered' = 'discovered';
        const cached = domain ? this.siteMemory.getInput(domain, query) : null;
        if (cached?.selector) {
          selector = cached.selector;
          isCE = cached.method === 'contenteditable';
          source = 'cache';
        } else {
          const el = await this.finder.findOne(query);
          if (!el) {
            return this.nativeFailure('smartType', args, toYautjaError('YJ.ACT.DOM_TARGET_NOT_FOUND', {
              message: `No input found for: ${query}`,
            }));
          }
          selector = el.selector;
          isCE = !!el.editable;
        }

        // Type transaction wrapped in the doctrine RecoveryMachine (P11)
        const response = await this.recoveryMachine.execute<TypeTxResult>({
          tool: 'smartType',
          action_type: 'type',
          policy_key: 'smartType',
          trace_id: generateTraceId(),
          idempotency_key: args.idempotency_key ?? null,
          session_id: this.sessionId,
          tab_id: this.server.getCurrentTabId() ?? 0,
          origin,
          fn: () => runTypeTransaction(
            { transport: this.server, inputSession: this.inputSession, tabId: this.server.getCurrentTabId() ?? 0 },
            { selector: selector!, text, submit, stealth: useStealth, transactional, verify: doVerify, clearFirst, onPartial, isContentEditable: isCE },
          ),
        });

        if (response.ok) {
          // COMMIT: site memory update + result metadata
          if (domain) {
            this.siteMemory.save(domain, {
              inputs: { [query]: { selector: selector!, method: isCE ? 'contenteditable' : 'input' } },
            });
          }
          (response.result as any).source = source;
          (response.result as any).domain = domain;
          // P13: count the burned query against the session budget
          if (submit && siteProfile.id !== 'default') {
            this.queryBurn.set(domain, (this.queryBurn.get(domain) ?? 0) + 1);
          }
          // v2: track the cache hit for TTL/stats
          if (source === 'cache' && domain) {
            this.siteMemory.recordHit(domain, query);
          }

          // P12: optional declarative wait after submit (e.g. wait for the
          // answer container to settle) using the shared waitForUi engine.
          const waitReady = args.waitReady as { anyOf?: WaitPredicate[]; allOf?: WaitPredicate[]; timeoutMs?: number; pollMs?: number } | undefined;
          if (waitReady && (waitReady.anyOf?.length || waitReady.allOf?.length)) {
            const wait = await waitForUi(
              { transport: this.server, getPendingRequests: () => this.thermal.getPendingCount() },
              { anyOf: waitReady.anyOf, allOf: waitReady.allOf, timeoutMs: waitReady.timeoutMs ?? 30_000, pollMs: waitReady.pollMs ?? 250 },
            );
            if (wait.matched === 'timeout') {
              const env = this.nativeFailure('smartType', args, toYautjaError('YJ.ACT.WAIT_TIMEOUT', {
                message: 'waitReady predicates not met after submit',
              }));
              (env as { result?: unknown }).result = { typeTx: response.result, wait };
              return env;
            }
            (response.result as any).wait = wait;
          }
        } else if (source === 'cache' && domain && response.error?.code === 'YJ.ACT.DOM_TARGET_NOT_FOUND') {
          // Stale cache entry: drop it so the next call re-discovers
          this.siteMemory.save(domain, { inputs: { [query]: undefined as any } });
        }
        return response;
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
      case 'macro_list':
        return JSON.stringify({ macros: this.macroRunner.list() });
      case 'macro_run': {
        // P18: precondition — profile OPSEC rules apply to macros too
        const macroProfile = this.profileStore.match(await this.currentPageUrl());
        if (macroProfile.rules.onCaptcha === 'stop_hard') {
          try {
            const tech = await this.techSensor.summarize();
            const captchaSignals = ((tech.antiBot as any).signals ?? []).filter((s: string) => /recaptcha|hcaptcha|turnstile/i.test(s));
            if (captchaSignals.length > 0) {
              return this.nativeFailure('macro_run', args, toYautjaError('YJ.OPSEC.CAPTCHA_DETECTED', {
                message: `CAPTCHA detected before running macro "${args.name}": ${captchaSignals.join(', ')}`,
              }));
            }
          } catch {}
        }
        const result = await this.macroRunner.run(args.name, args.args, args.timeoutMs);
        return JSON.stringify(result);
      }
      case 'macro_register': {
        const result = await this.macroRunner.registerUserMacro(args.name, args.source, args.overwrite === true);
        return JSON.stringify(result);
      }
      case 'macro_delete': {
        const result = await this.macroRunner.deleteUserMacro(args.name);
        return JSON.stringify(result);
      }
      // ─── Extension inspection tools (hybrid: disk + management + CDP) ──
      case 'extList': {
        // Try chrome.management first (richer data), fall back to debugger.getTargets
        try {
          const extensions = await this.server.managementGetAll();
          const filtered = args.type
            ? extensions.filter((e: any) => e.type === args.type)
            : extensions;
          return JSON.stringify({ extensions: filtered, count: filtered.length, source: 'management' }, null, 2);
        } catch {
          const targets = await this.server.listAllTargets();
          const filtered = args.type
            ? targets.filter((t) => t.type === args.type)
            : targets;
          return JSON.stringify({ extensions: filtered, count: filtered.length, source: 'debugger-targets' }, null, 2);
        }
      }
      case 'extAttach': {
        // Deprecated — no longer needed. Disk/management/CDP backends operate by extId directly.
        return JSON.stringify({
          success: true,
          note: 'extAttach is no longer required. extManifest/extSource/extStorage read from disk; extNetwork uses webRequest; extEval uses CDP remote on :9222.',
        });
      }
      case 'extManifest': {
        const extId = args.extId;
        if (!extId) return JSON.stringify({ error: 'extId required' });
        try {
          const manifest = await this.extIntel.readManifest(extId);
          return JSON.stringify({ extId, manifest }, null, 2);
        } catch (e: any) {
          return JSON.stringify({ error: e.message });
        }
      }
      case 'extSource': {
        const extId = args.extId;
        const filePath = args.path || 'manifest.json';
        if (!extId) return JSON.stringify({ error: 'extId required' });
        try {
          const content = await this.extIntel.readSource(extId, filePath);
          return JSON.stringify({ extId, path: filePath, content });
        } catch (e: any) {
          return JSON.stringify({ error: e.message });
        }
      }
      case 'extStorage': {
        const extId = args.extId;
        if (!extId) return JSON.stringify({ error: 'extId required' });
        const key = args.key;
        try {
          const data = await this.extIntel.readStorage(extId, key);
          return JSON.stringify({ extId, area: 'local', keys: Object.keys(data).length, data });
        } catch (e: any) {
          return JSON.stringify({ error: e.message });
        }
      }
      case 'extNetwork': {
        const extId = args.extId;
        const action = args.action || 'list';
        if (!extId) return JSON.stringify({ error: 'extId required' });
        try {
          if (action === 'start') {
            // Start the tunnel proxy if not running
            if (!this.mitmProxy.isRunning()) {
              await this.mitmProxy.start();
              // Tell the extension to route through our proxy
              await this.server.proxyStart(9877);
              return JSON.stringify({
                success: true,
                action: 'started',
                extId,
                method: 'tunnel-proxy',
                proxyPort: 9877,
                caCertInstalled: true,
                note: 'HTTPS traffic captured via CONNECT tunneling (domain only, no content decryption)',
              });
            }
            // Proxy already running — just clear buffer for fresh capture
            await this.mitmProxy.clear();
            await this.server.proxyStart(9877);
            return JSON.stringify({ success: true, action: 'started', extId, method: 'tunnel-proxy', note: 'Proxy already running, buffer cleared' });
          }
          if (action === 'stop') {
            // Stop routing through proxy
            await this.server.proxyStop();
            return JSON.stringify({ success: true, action: 'stopped', extId });
          }
          if (action === 'installCert') {
            if (!this.mitmProxy.hasCaCert()) {
              // Need to start proxy once to generate cert
              if (!this.mitmProxy.isRunning()) {
                await this.mitmProxy.start();
              }
              await this.mitmProxy.stop();
            }
            // Install CA cert into Windows trust store
            const { exec } = await import('child_process');
            const realPath = this.mitmProxy.getCaCertPath();
            return new Promise((resolve) => {
              exec(`certutil -user -addstore Root "${realPath}"`, (err, stdout) => {
                if (err) {
                  resolve(JSON.stringify({ success: false, error: err.message, hint: `Run manually: certutil -user -addstore Root "${realPath}"` }));
                } else {
                  resolve(JSON.stringify({ success: true, installed: true, certPath: realPath, output: stdout }));
                }
              });
            }).then(s => s as string);
          }
          // action === 'list': return requests captured by the MITM proxy
          const hostPattern = args.hostPattern;
          const { requests, count, total } = await this.mitmProxy.getRequests({ hostPattern, limit: args.limit || 100 });
          const stats = await this.mitmProxy.stats();
          return JSON.stringify({
            requests,
            count,
            method: 'tunnel-proxy',
            totalProxyRequests: total,
            uniqueHosts: stats.uniqueHosts,
            topHosts: Object.entries(stats.hosts).sort((a, b) => b[1] - a[1]).slice(0, 20),
          });
        } catch (e: any) {
          return JSON.stringify({ error: e.message });
        }
      }
      case 'extEval': {
        const extId = args.extId;
        const expression = args.expression;
        if (!extId || !expression) return JSON.stringify({ error: 'extId and expression required' });
        const available = await this.cdpRemote.isAvailable();
        if (!available) {
          return JSON.stringify({
            error: 'Remote debugging port not available. Launch Chrome with --remote-debugging-port=9222 to use extEval.',
          });
        }
        try {
          const { result, exceptionDetails } = await this.cdpRemote.evaluate(
            extId, expression, args.awaitPromise ?? false,
          );
          return JSON.stringify({ result, exceptionDetails });
        } catch (e: any) {
          return JSON.stringify({ error: e.message });
        }
      }
      // ─── Tampermonkey integration tools ──────────────────────────────
      case 'tmListScripts': {
        const tmId = args.extId || 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
        try {
          const data = await this.extIntel.readStorage(tmId);
          const scripts: any[] = [];
          for (const [key, raw] of Object.entries(data)) {
            if (key.startsWith('@meta#')) {
              const uuid = key.substring(6);
              const meta = raw as any;
              if (!meta || meta.deleted) continue;
              scripts.push({
                uuid,
                name: meta.name || '(unnamed)',
                version: meta.version || '',
                namespace: meta.namespace || '',
                description: (meta.description || '').substring(0, 200),
                enabled: meta.options?.enabled !== false,
                matches: meta.matches || [],
                includes: meta.includes || [],
                excludes: meta.excludes || [],
                run_at: meta['run-at'] || 'document-idle',
                grants: meta.grant || [],
                requires: (meta.requires || []).map((r: any) => r.abs_url || r.unsafe_url).filter(Boolean),
                resources: (meta.resources || []).map((r: any) => r.name).filter(Boolean),
                url: meta.url || meta.downloadURL || '',
                lastModified: meta.lastModified || 0,
                system: meta.system || false,
              });
            }
          }
          scripts.sort((a, b) => a.name.localeCompare(b.name));
          return JSON.stringify({ scripts, count: scripts.length, extId: tmId }, null, 2);
        } catch (e: any) {
          return JSON.stringify({ error: e.message, hint: 'Tampermonkey may not be installed or no profile found' });
        }
      }
      case 'tmGetScript': {
        const tmId = args.extId || 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
        const uuid = args.uuid;
        if (!uuid) return JSON.stringify({ error: 'uuid required' });
        try {
          const data = await this.extIntel.readStorage(tmId);
          const metaKey = `@meta#${uuid}`;
          const sourceKey = `@source#${uuid}`;
          const meta = data[metaKey];
          const source = data[sourceKey];
          if (!meta) return JSON.stringify({ error: `Script with UUID ${uuid} not found` });
          return JSON.stringify({
            uuid,
            name: meta.name,
            version: meta.version,
            namespace: meta.namespace,
            description: meta.description,
            enabled: meta.options?.enabled !== false,
            matches: meta.matches || [],
            excludes: meta.excludes || [],
            includes: meta.includes || [],
            grants: meta.grant || [],
            code: source || '(source not found in storage)',
            codeSize: source ? source.length : 0,
          }, null, 2);
        } catch (e: any) {
          return JSON.stringify({ error: e.message });
        }
      }
      case 'tmSearchScripts': {
        const query = args.query as string | undefined;
        const domain = args.domain as string | undefined;
        const limit = (args.limit as number) || 20;

        try {
          let url: string;
          if (domain) {
            url = `https://greasyfork.org/en/scripts/by-site/${encodeURIComponent(domain)}.json?per_page=${limit}`;
          } else if (query) {
            url = `https://greasyfork.org/en/scripts.json?q=${encodeURIComponent(query)}&per_page=${limit}`;
          } else {
            return JSON.stringify({ error: 'Either query or domain required' });
          }

          const resp = await fetch(url, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(15000),
          });
          if (!resp.ok) {
            return JSON.stringify({ error: `GreasyFork API returned ${resp.status}` });
          }
          const data = await resp.json() as any;
          const results = (data.query || []).map((s: any) => ({
            id: s.id,
            name: s.name,
            description: s.description?.substring(0, 300),
            author: s.users?.map((u: any) => u.name).join(', ') || '',
            version: s.version || '',
            url: s.url,
            code_url: s.code_url,
            code_size: s.code_size || 0,
            daily_installs: s.daily_installs || 0,
            total_installs: s.total_installs || 0,
            fan_score: s.fan_score || '0',
            good_ratings: s.good_ratings || 0,
            bad_ratings: s.bad_ratings || 0,
            created_at: s.created_at,
            code_updated_at: s.code_updated_at,
            license: s.license || '',
            locale: s.locale || '',
          }));

          return JSON.stringify({
            results,
            count: results.length,
            source: 'greasyfork.org',
            searchType: domain ? 'by-site' : 'query',
            query: query || domain,
          }, null, 2);
        } catch (e: any) {
          return JSON.stringify({ error: e.message });
        }
      }
      case 'tmInstallScript': {
        const tmId = args.extId || 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
        let code = args.code as string | undefined;
        const installUrl = args.url as string | undefined;

        if (!code && !installUrl) {
          return JSON.stringify({ error: 'Either code (userscript source) or url (install URL) required' });
        }

        try {
          // If URL provided, fetch the script content first (server-side fetch,
          // no CORS). Then bridge-install via the greasyfork.org origin so
          // TM's onMessageExternal handler accepts the message:
          //   port.postMessage({ method: 'importEx', code })
          if (!code && installUrl) {
            const r = await fetch(installUrl, { redirect: 'follow' });
            if (!r.ok) {
              return JSON.stringify({
                error: `Failed to fetch URL: ${r.status} ${r.statusText}`,
                url: installUrl,
              });
            }
            code = await r.text();
          }

          const result = await this.server.sendRaw({
            type: 'tmInstallViaBridge',
            tmExtId: tmId,
            message: { method: 'importEx', code },
            timeout: 20000,
          });

          return JSON.stringify({
            success: !result?.error && !result?.detail,
            result,
          }, null, 2);
        } catch (e: any) {
          return JSON.stringify({
            error: e.message,
            hint: 'Tampermonkey must be installed and the script must start with a valid ==UserScript== header',
          });
        }
      }
      case 'tmToggleScript': {
        const tmId = args.extId || 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
        const uuid = args.uuid as string | undefined;
        const enabled = args.enabled as boolean | undefined;

        if (!uuid || enabled === undefined) {
          return JSON.stringify({ error: 'uuid and enabled (boolean) required' });
        }

        try {
          // Read the raw TM meta object (full internal structure) —
          // tmGetScript returns a simplified shape, but saveScript
          // needs every field TM has stored.
          const data = await this.extIntel.readStorage(tmId);
          const metaKey = `@meta#${uuid}`;
          const meta = data[metaKey];
          if (!meta) {
            return JSON.stringify({ error: `Script ${uuid} not found` });
          }

          // Toggle the enabled flag in-place
          if (!meta.options) meta.options = {};
          meta.options.enabled = enabled;

          // Send via bridge: TM's saveScript accepts the full meta object
          const result = await this.server.sendRaw({
            type: 'tmInstallViaBridge',
            tmExtId: tmId,
            message: { method: 'saveScript', script: meta },
            timeout: 20000,
          });

          return JSON.stringify({
            success: !result?.error && !result?.detail,
            uuid,
            enabled,
            result,
          }, null, 2);
        } catch (e: any) {
          return JSON.stringify({
            error: e.message,
            hint: 'tmToggleScript uses the silent bridge — same caveats as tmInstallScript',
          });
        }
      }
      case 'profileList': {
        return this.nativeSuccess('profileList', args, {
          profiles: this.profileStore.list().map((p) => ({
            id: p.id,
            version: p.version,
            hosts: p.match.hosts,
            pathPrefix: p.match.pathPrefix,
            notes: p.notes,
          })),
        });
      }
      case 'profileLoad': {
        if (args.id) {
          const p = this.profileStore.get(String(args.id));
          if (!p) {
            return this.nativeFailure('profileLoad', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
              message: `Unknown profile: ${args.id}`,
            }));
          }
          return this.nativeSuccess('profileLoad', args, { profile: p });
        }
        if (args.path) {
          try {
            const raw = JSON.parse(fs.readFileSync(String(args.path), 'utf8'));
            const parsed = SiteProfileSchema.safeParse(raw);
            if (!parsed.success) {
              return this.nativeFailure('profileLoad', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
                message: `Invalid profile schema: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
              }));
            }
            this.profileStore.register(parsed.data);
            return this.nativeSuccess('profileLoad', args, { profile: parsed.data, registered: true });
          } catch (e: any) {
            return this.nativeFailure('profileLoad', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
              message: `Cannot load profile from ${args.path}: ${e.message}`,
            }));
          }
        }
        return this.nativeFailure('profileLoad', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
          message: 'id or path is required',
        }));
      }
      case 'profileStatus': {
        const url = await this.currentPageUrl();
        const profile = this.profileStore.match(url);
        let hostname = '';
        try { hostname = new URL(url).hostname; } catch {}
        const budget = await this.economicSensor.summarize(url);
        return this.nativeSuccess('profileStatus', args, {
          url,
          profile: { id: profile.id, version: profile.version, rules: profile.rules },
          budget,
          queryBurn: hostname ? (this.queryBurn.get(hostname) ?? 0) : 0,
          lastPreflight: this.lastPreflight,
        });
      }
      case 'preflight': {
        const url = await this.currentPageUrl();
        const profile = this.profileStore.match(url);
        const action = args.action as string | undefined;
        if (action === 'navigate' && typeof args.url === 'string') {
          const dest = this.profileStore.match(args.url);
          if (!isUrlAllowed(dest, args.url)) {
            return this.nativeFailure('preflight', args, toYautjaError('YJ.POLICY.GATE_DENIED', {
              message: `Site profile "${dest.id}" denies navigation to ${args.url} (urlDenyRegex)`,
            }));
          }
        }
        if (action === 'intercept' && !isInterceptAllowed(profile)) {
          return this.nativeFailure('preflight', args, toYautjaError('YJ.POLICY.GATE_DENIED', {
            message: `Site profile "${profile.id}" forbids request interception on this domain`,
          }));
        }
        const pf = await runPreflight(profile, { getCookies: () => this.getCookiesCtx() });
        this.lastPreflight = { url, pass: pf.pass, reasons: pf.reasons, at: Date.now() };
        if (!pf.pass) {
          return this.nativeFailure('preflight', args, toYautjaError(mapPreflightCode(pf.abortCode ?? ''), {
            message: `Preflight abort on ${profile.id}: ${pf.reasons[pf.reasons.length - 1]}`,
          }));
        }
        return this.nativeSuccess('preflight', args, {
          pass: true,
          profile: profile.id,
          reasons: pf.reasons,
        });
      }
      case 'gateStatus': {
        return this.nativeSuccess('gateStatus', args, this.gates.status());
      }
      case 'gateGrant': {
        // r2: grants must come from the USER's words in chat. The phrase is
        // mandatory and lands in the audit trail (grantedBy: user_phrase).
        if (!args.phrase || typeof args.phrase !== 'string') {
          return this.nativeFailure('gateGrant', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
            message: 'phrase is required — the exact words with which the user authorized this grant',
          }));
        }
        if (!args.level || !Array.isArray(args.hosts) || args.hosts.length === 0) {
          return this.nativeFailure('gateGrant', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
            message: 'level (P1-P4) and hosts[] are required',
          }));
        }
        try {
          const grant = this.gates.grant({
            level: args.level,
            scope: { hosts: args.hosts, pathPrefix: args.pathPrefix, methods: args.methods },
            phrase: args.phrase,
            maxRequests: args.maxRequests,
            maxRps: args.maxRps,
            expiresAt: args.expiresAt,
          });
          return this.nativeSuccess('gateGrant', args, { granted: true, grant });
        } catch (e: any) {
          return this.nativeFailure('gateGrant', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', { message: e.message }));
        }
      }
      case 'gateRevoke': {
        const revoked = this.gates.revoke({ level: args.level, all: args.all === true });
        return this.nativeSuccess('gateRevoke', args, { revoked });
      }
      case 'browserFetch': {
        const url = args.url as string;
        if (!url) {
          return this.nativeFailure('browserFetch', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
            message: 'url is required',
          }));
        }
        const method = String(args.method ?? 'GET').toUpperCase();
        const credentials: 'include' | 'omit' = args.credentials === 'omit' ? 'omit' : 'include';

        // Hard rule: default P0 — no grant, no request.
        const check = this.gates.check(url, method, credentials);
        if (!check.allowed) {
          this.gates.audit({ type: 'browserFetch', url, method, denied: true, reason: check.reason });
          return this.nativeFailure('browserFetch', args, toYautjaError('YJ.POLICY.GATE_DENIED', {
            message: check.reason ?? 'No active grant covers this request',
          }));
        }

        // Per-host rate limit
        let hostname = '';
        try { hostname = new URL(url).hostname; } catch {}
        const maxRps = args.maxRps ?? check.grant?.maxRps ?? 2;
        const delay = this.rateLimiter.nextDelay(hostname, maxRps);
        if (delay > 0) await sleep(delay);
        this.rateLimiter.record(hostname);

        const result = await browserFetch(this.server, {
          url,
          method,
          headers: args.headers,
          body: args.body,
          credentials,
          timeoutMs: args.timeoutMs ?? 15_000,
          redactResponse: args.redactResponse,
          maxBodyChars: args.maxBodyChars,
        });
        this.gates.consume(check.grant!);
        this.gates.audit({
          type: 'browserFetch', url, method, denied: false,
          status: result.status, timingMs: result.timingMs, gateUsed: check.gateUsed,
        });
        if (!result.ok) {
          return this.nativeFailure('browserFetch', args, toYautjaError('YJ.NET.REQUEST_TIMEOUT', {
            message: result.error ?? 'fetch failed in page context',
          }));
        }
        this.lastFetch = { url, method, host: hostname, body: result.body ?? '' };
        let evidenceId: string | undefined;
        if (args.captureAsEvidence && result.body) {
          evidenceId = this.gates.saveEvidence(result.body);
        }
        return this.nativeSuccess('browserFetch', args, {
          status: result.status,
          statusText: result.statusText,
          headers: result.headers,
          body: result.body,
          bodyBytes: result.bodyBytes,
          timingMs: result.timingMs,
          truncated: result.truncated,
          gateUsed: check.gateUsed,
          evidenceId,
        });
      }
      case 'apiSurface': {
        const sources: string[] = args.sources ?? ['network', 'bundles'];
        const lists: ApiEndpoint[][] = [];
        if (sources.includes('network')) {
          lists.push(surfaceFromNetwork(this.networkCapture.list({ limit: 1000 })));
        }
        let bundlesScanned = 0;
        if (sources.includes('bundles')) {
          try {
            const r = await this.server.send('Runtime.evaluate', {
              expression: buildBundleScanScript(),
              awaitPromise: true,
              returnByValue: true,
            });
            const parsed = typeof r?.result?.value === 'string' ? JSON.parse(r.result.value) : null;
            if (parsed?.paths) {
              bundlesScanned = parsed.bundlesScanned ?? 0;
              let origin = '';
              try { origin = new URL(await this.currentPageUrl()).origin; } catch {}
              lists.push((parsed.paths as string[]).map((p) => ({
                method: '*',
                path: p,
                origin,
                authHint: 'unknown' as const,
                from: ['bundle' as const],
                confidence: 0.5,
              })));
            }
          } catch {}
        }
        const endpoints = mergeEndpoints(lists);
        return this.nativeSuccess('apiSurface', args, {
          endpoints,
          bundlesScanned,
          generatedAt: new Date().toISOString(),
        });
      }
      case 'exportHar': {
        const url = await this.currentPageUrl();
        let host = '';
        try { host = new URL(url).hostname; } catch {}
        const result = exportHarToFile(
          this.networkCapture.list({ limit: 5000 }),
          path.join(process.env.APPDATA || process.env.HOME || '/tmp', '.yautja', 'har'),
          host,
          {
            redact: args.redact !== false,
            urlIncludes: args.filter?.urlIncludes,
            method: args.filter?.method,
            sinceMs: args.sinceMs,
          },
        );
        return this.nativeSuccess('exportHar', args, result);
      }
      case 'evidencePut': {
        let body = args.body as string | undefined;
        let url = args.url as string | undefined;
        let method = args.method as string | undefined;
        let host = args.host as string | undefined;
        if (args.fromLastFetch === true) {
          if (!this.lastFetch) {
            return this.nativeFailure('evidencePut', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
              message: 'No browserFetch result in this session',
            }));
          }
          body = this.lastFetch.body;
          url = this.lastFetch.url;
          method = this.lastFetch.method;
          host = this.lastFetch.host;
        }
        if (!body || !host) {
          return this.nativeFailure('evidencePut', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
            message: 'body and host are required (or fromLastFetch: true)',
          }));
        }
        const record = this.evidenceStore.put({
          runId: args.runId ?? this.sessionId,
          host,
          url,
          method,
          kind: args.kind ?? 'manual',
          body,
          storeRaw: args.storeRaw === true && this.analystMode,
        });
        return this.nativeSuccess('evidencePut', args, { record });
      }
      case 'evidenceGet': {
        if (!args.id) {
          return this.nativeFailure('evidenceGet', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
            message: 'id is required',
          }));
        }
        if (args.includeRaw === true && !this.analystMode) {
          return this.nativeFailure('evidenceGet', args, toYautjaError('YJ.POLICY.GATE_DENIED', {
            message: 'includeRaw requires analystMode (set YAUTJA_ANALYST_MODE=1). Evidence is redacted by default.',
          }));
        }
        const found = this.evidenceStore.get(String(args.id));
        if (!found) {
          return this.nativeFailure('evidenceGet', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
            message: `Evidence not found: ${args.id}`,
          }));
        }
        return this.nativeSuccess('evidenceGet', args, found);
      }
      case 'evidenceList': {
        return this.nativeSuccess('evidenceList', args, {
          records: this.evidenceStore.list({ host: args.host, runId: args.runId }),
        });
      }
      case 'responseDiff': {
        const resolve = (v: any): string | null => {
          if (!v) return null;
          if (typeof v === 'string') {
            if (v.startsWith('ev_')) return this.evidenceStore.get(v)?.body ?? null;
            return v;
          }
          if (typeof v === 'object' && typeof v.body === 'string') return v.body;
          return null;
        };
        const a = resolve(args.a);
        const b = resolve(args.b);
        if (a === null || b === null) {
          return this.nativeFailure('responseDiff', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
            message: 'a and b must be evidenceIds (ev_...) or { body: string }',
          }));
        }
        return this.nativeSuccess('responseDiff', args, responseDiff(a, b, args.ignorePaths ?? []));
      }
      case 'trustedClick': {
        let selector = args.selector as string | undefined;
        if (!selector && args.query) {
          const el = await this.finder.findOne(args.query);
          if (!el) {
            return this.nativeFailure('trustedClick', args, toYautjaError('YJ.ACT.DOM_TARGET_NOT_FOUND', {
              message: `No element found for: ${args.query}`,
            }));
          }
          selector = el.selector;
        }
        if (!selector) {
          return this.nativeFailure('trustedClick', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
            message: 'selector or query is required',
          }));
        }
        const result = await trustedClick(this.server, {
          selector,
          button: args.button,
          clickCount: args.clickCount,
        });
        if (!result.ok) {
          const code = result.reason === 'not_found' ? 'YJ.ACT.DOM_TARGET_NOT_FOUND' : 'YJ.PROTOCOL.CAPABILITY_MISSING';
          return this.nativeFailure('trustedClick', args, toYautjaError(code, { message: result.detail }));
        }
        return this.nativeSuccess('trustedClick', args, { clicked: true, selector, trusted: true });
      }
      case 'trustedFileChooser': {
        let selector = (args.triggerSelector ?? args.selector) as string | undefined;
        if (!selector && (args.triggerQuery ?? args.query)) {
          const el = await this.finder.findOne(args.triggerQuery ?? args.query);
          if (!el) {
            return this.nativeFailure('trustedFileChooser', args, toYautjaError('YJ.ACT.DOM_TARGET_NOT_FOUND', {
              message: `No element found for: ${args.triggerQuery ?? args.query}`,
            }));
          }
          selector = el.selector;
        }
        if (!selector) {
          return this.nativeFailure('trustedFileChooser', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
            message: 'triggerSelector or triggerQuery is required',
          }));
        }
        const files = args.files as string[] | undefined;
        if (!Array.isArray(files) || files.length === 0) {
          return this.nativeFailure('trustedFileChooser', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
            message: 'files[] is required (absolute paths)',
          }));
        }
        const missing = files.filter((f) => !fs.existsSync(f));
        if (missing.length > 0) {
          return this.nativeFailure('trustedFileChooser', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
            message: `Files not found on disk: ${missing.join(', ')}`,
          }));
        }
        const result = await trustedFileChooser(
          { send: (m, p) => this.server.send(m, p), on: (e, h) => this.server.on(e, h) },
          { selector, files, timeoutMs: args.timeoutMs },
        );
        if (!result.ok) {
          const err = toYautjaError(result.code, { message: result.detail });
          if (result.code === 'YJ.PROTOCOL.CAPABILITY_MISSING') {
            err.agent_summary = `${result.detail}. Trusted file upload unavailable on this backend; delegate to SuperAPI file_upload or hand off to the user. Do NOT report fake success.`;
          }
          return this.nativeFailure('trustedFileChooser', args, err);
        }
        return this.nativeSuccess('trustedFileChooser', args, {
          attached: true,
          path: result.path,
          filesAttached: result.filesAttached,
          selector,
        });
      }
      case 'capabilities': {
        const profile = this.profileStore.match(await this.currentPageUrl());
        const backends = loadBackendConfig();
        const matrix = detectCapabilities({
          hasEventChannel: typeof this.server.on === 'function',
          hasInterceptor: true,
          interceptAllowedByProfile: isInterceptAllowed(profile),
          superapiConfigured: isSuperapiConfigured(backends),
          chromeDevtoolsConfigured: isChromeDevtoolsConfigured(backends),
        });
        return this.nativeSuccess('capabilities', args, matrix);
      }
      case 'delegate': {
        const capability = args.capability as DelegableCapability | undefined;
        if (!capability) {
          return this.nativeFailure('delegate', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
            message: 'capability is required (heap_profile, cpu_profile, file_upload, observe, act, network_listen)',
          }));
        }
        try {
          const result = delegate(capability, loadBackendConfig());
          return this.nativeSuccess('delegate', args, { capability, ...result });
        } catch {
          return this.nativeFailure('delegate', args, toYautjaError('YJ.PROTOCOL.CAPABILITY_MISSING', {
            message: `No backend configured for capability "${capability}". Configure ~/.yautja/backends.json (superapi.url / chromeDevtools.cdpUrl) or use a yautja-native path.`,
          }));
        }
      }
      case 'snapshotSave': {
        const name = args.name as string;
        if (!name) {
          return this.nativeFailure('snapshotSave', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
            message: 'name is required',
          }));
        }
        const snapshot = await this.snapshotStore.capture({
          getCookies: () => this.getCookiesCtx(),
          getLocalStorage: async () => {
            const r = await this.translator.execute({ type: 'getLocalStorage' });
            if (!r.ok || typeof r.value !== 'string') return {};
            try { return JSON.parse(r.value); } catch { return {}; }
          },
          getUrl: () => this.currentPageUrl(),
        }, name);
        return this.nativeSuccess('snapshotSave', args, {
          saved: true,
          name: snapshot.name,
          origin: snapshot.origin,
          cookies: snapshot.cookies.length,
          localStorageKeys: Object.keys(snapshot.localStorage).length,
        });
      }
      case 'snapshotList': {
        return this.nativeSuccess('snapshotList', args, { snapshots: this.snapshotStore.list() });
      }
      case 'snapshotRestore': {
        const name = args.name as string;
        if (!name) {
          return this.nativeFailure('snapshotRestore', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
            message: 'name is required',
          }));
        }
        const snapshot = this.snapshotStore.load(name);
        if (!snapshot) {
          return this.nativeFailure('snapshotRestore', args, toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', {
            message: `Snapshot not found: ${name}`,
          }));
        }
        const include: string[] = Array.isArray(args.include) ? args.include : ['cookies', 'localStorage', 'url'];
        const result = await this.snapshotStore.restore({
          setCookie: async (cookie) => {
            await this.translator.execute({
              type: 'setCookie',
              cookie: {
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path,
                secure: cookie.secure,
                httpOnly: cookie.httpOnly,
              },
            });
          },
          setLocalStorage: async (key, value) => {
            await this.translator.execute({ type: 'setLocalStorage', key, value });
          },
          navigate: async (url) => {
            await this.translator.execute({ type: 'navigate', url });
          },
        }, snapshot, include, await this.currentPageUrl());
        return this.nativeSuccess('snapshotRestore', args, {
          restored: result.restored,
          skippedForeignCookies: result.skippedForeign,
          opsecWarning: result.opsecWarning,
        });
      }
      case 'recovery_stats':
        return JSON.stringify(this.recoveryStats({
          code: args.code,
          strategy: args.strategy,
          since: args.since,
        }));
      default:
        return `Unknown tool: ${name}`;
    }
  }

  // ─── P10: doctrine envelope shim (migration sub-phase 10a) ──
  //
  // Every MCP tool response is wrapped in a YautjaResponse envelope.
  // Legacy string/JSON payloads are preserved inside `result` (or
  // `result.legacy_text` for non-JSON output) until 10b/10c migrate
  // each tool to native envelope returns.

  private buildOperationMeta(tool: string, args: any): OperationMeta {
    return {
      tool,
      action_type: tool === 'act' ? (args?.action?.type ?? 'unknown') : tool,
      operation_id: generateOperationId(),
      trace_id: generateTraceId(),
      attempt: 1,
      max_attempts: 1,
      idempotency_key: args?.idempotency_key ?? null,
    };
  }

  private buildStateMeta(): StateMeta {
    const snap = this.memory.snapshot();
    const url = snap?.url || '';
    let origin = '';
    try { origin = url ? new URL(url).origin : ''; } catch {}
    return {
      session_id: this.sessionId,
      tab_id: this.server.getCurrentTabId() ?? 0,
      origin,
      url_before: url || undefined,
      checkpoint_id: null,
      state_integrity: 'unknown',
    };
  }

  private buildContextMeta(payloadChars: number): ContextMeta {
    return {
      consumed_tokens_estimate: Math.ceil(payloadChars / 4),
      available_window_tokens: 200_000,
      confidence: 'low',
    };
  }

  // ─── P10b: native envelope builders (core tools) ───────────

  private nativeSuccess(tool: string, args: any, result: unknown, state?: Partial<StateMeta>): YautjaResponse<unknown> {
    return success(result, {
      operation: this.buildOperationMeta(tool, args),
      state: { ...this.buildStateMeta(), ...state },
      context: this.buildContextMeta(JSON.stringify(result).length),
    });
  }

  private nativeFailure(tool: string, args: any, error: YautjaError, state?: Partial<StateMeta>): YautjaResponse<unknown> {
    return failure(error, {
      operation: this.buildOperationMeta(tool, args),
      state: { ...this.buildStateMeta(), ...state },
      context: this.buildContextMeta(error.message.length + error.agent_summary.length),
    });
  }

  private detectLegacyError(raw: string, parsed: any): YautjaError | null {
    // act() legacy shape: { success: false, error, type, recoveryHint }
    if (parsed && parsed.success === false) {
      return classifyLegacyError({
        type: (parsed.type as ArsenalErrorType) || 'UNKNOWN_ERROR',
        message: typeof parsed.error === 'string' ? parsed.error : String(parsed.detail ?? 'Action failed'),
        recoverable: false,
        recoveryHint: parsed.recoveryHint,
      });
    }
    // Generic error payloads from other tools: { error: string, ... }
    if (parsed && typeof parsed.error === 'string') {
      return toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', { message: parsed.error });
    }
    // Plain-text legacy errors: "Unknown tool: x", "Error: unknown domain ..."
    if (raw.startsWith('Unknown tool:') || raw.startsWith('Error:')) {
      return toYautjaError('YJ.PROTOCOL.INVALID_ARGUMENT', { message: raw.split('\n')[0]! });
    }
    return null;
  }

  private recordFailure(operation: OperationMeta, error: YautjaError, started: number, context: ContextMeta): void {
    this.telemetry.record({
      trace_id: operation.trace_id,
      operation_id: operation.operation_id,
      original_error_code: error.code,
      recovery_strategy: error.retry_strategy,
      attempts: 1,
      outcome: 'failed',
      time_to_recover_ms: Date.now() - started,
      context_cost_delta_tokens: context.consumed_tokens_estimate,
      deviated_from_recommendation: false,
    });
  }

  private async envelopeToolCall(name: string, args: any): Promise<string> {
    const operation = this.buildOperationMeta(name, args);
    const started = Date.now();
    try {
      const raw = await this.handleToolCall(name, args);
      // Native envelope (10b core tools): pass through; telemetry on failure.
      if (typeof raw !== 'string') {
        if (!raw.ok && raw.error) {
          this.telemetry.record({
            trace_id: raw.operation.trace_id,
            operation_id: raw.operation.operation_id,
            original_error_code: raw.error.code,
            recovery_strategy: raw.error.retry_strategy,
            attempts: 1,
            outcome: 'failed',
            time_to_recover_ms: Date.now() - started,
            context_cost_delta_tokens: raw.context.consumed_tokens_estimate,
            deviated_from_recommendation: false,
          });
        }
        return JSON.stringify(raw);
      }
      // P18: shim kill-switch — with YAUTJA_LEGACY_SHIM=0, non-migrated
      // tools fail typed instead of silently using the legacy shim.
      if (process.env.YAUTJA_LEGACY_SHIM === '0') {
        const context = this.buildContextMeta(0);
        const err = toYautjaError('YJ.PROTOCOL.CAPABILITY_MISSING', {
          message: `Tool "${name}" is not migrated to a native envelope and the legacy shim is disabled (YAUTJA_LEGACY_SHIM=0)`,
        });
        this.recordFailure(operation, err, started, context);
        return JSON.stringify(failure(err, { operation, state: this.buildStateMeta(), context }));
      }
      let parsed: any = null;
      try {
        const v = JSON.parse(raw);
        if (v && typeof v === 'object') parsed = v;
      } catch { /* legacy plain-text output */ }
      const context = this.buildContextMeta(raw.length);
      const legacyError = this.detectLegacyError(raw, parsed);
      if (legacyError) {
        this.recordFailure(operation, legacyError, started, context);
        const env = failure(legacyError, { operation, state: this.buildStateMeta(), context });
        // Preserve the legacy payload so older agents can still read it.
        if (parsed) (env as { result?: unknown }).result = parsed;
        return JSON.stringify(env);
      }
      const result = parsed ?? { legacy_text: raw };
      return JSON.stringify(success(result, { operation, state: this.buildStateMeta(), context }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const context = this.buildContextMeta(message.length);
      const yerr = classifyLegacyError({ type: 'UNKNOWN_ERROR', message, recoverable: false });
      this.recordFailure(operation, yerr, started, context);
      return JSON.stringify(failure(yerr, { operation, state: this.buildStateMeta(), context }));
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
    description: 'Smart type (transactional, P11): finds the right input, cleans it (ensureEmpty), writes with the correct method, verifies the DOM, auto-submits. Long texts use one-shot insertText; stealth key events only for short texts on anti-bot sites. Caches selector per domain. On failure follow error.recovery (TYPE_PARTIAL → ensureEmpty → retry once; TYPE_RETRY_BLOCKED → ensureEmpty first).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'What input to find (e.g. "search", "email", "ask anything")' },
        text: { type: 'string', description: 'Text to type' },
        submit: { type: 'boolean', description: 'Press Enter after typing (default true)' },
        stealth: { type: 'boolean', description: 'Force stealth mode (default: auto-detect)' },
        transactional: { type: 'boolean', description: 'Run as a transaction with anti blind-retry block (default true)' },
        verify: { type: 'boolean', description: 'Verify the DOM contains the typed text before submit (default true)' },
        clearFirst: { type: 'boolean', description: 'Run ensureEmpty before typing (default true). If false after a recent TYPE_PARTIAL, the call is blocked (TYPE_RETRY_BLOCKED).' },
        onPartial: { type: 'string', enum: ['rollback', 'leave', 'error'], description: 'What to do when verification fails (default "rollback": clean the box and fail with TYPE_PARTIAL)' },
        idempotency_key: { type: 'string', description: 'Optional idempotency key — a cached successful response is returned for repeats' },
        waitReady: { type: 'object', description: 'P12: declarative wait after submit, same shape as waitFor ({anyOf|allOf, timeoutMs, pollMs}). E.g. {allOf:[{type:"ariaBusy",value:false},{type:"textSettled",selector:"main",stableMs:800}]}' },
      },
      required: ['query', 'text'],
    },
  },
  {
    name: 'waitFor',
    description: 'Declarative wait (P12) — replaces blind sleeps. Predicates: selector (attached/visible/hidden/detached), urlMatch (regex), ariaBusy, noPulse, networkIdle (real, via Thermal pending count), textSettled (stream-finished signal), fn (JS expression), timeout. Combine with anyOf/allOf. On timeout returns YJ.ACT.WAIT_TIMEOUT — inspect/observe and adjust.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        anyOf: { type: 'array', description: 'Match when ANY predicate is true. Returns which index matched.' },
        allOf: { type: 'array', description: 'Match when ALL predicates are true' },
        timeoutMs: { type: 'number', description: 'Overall timeout (default 30000)' },
        pollMs: { type: 'number', description: 'Poll interval (default 250)' },
      },
    },
  },
  {
    name: 'extractAnswer',
    description: 'Extract long answers settled and chunked (P12). waitUntil:"settled" waits for textSettled+ariaBusy before reading (no mid-stream cuts). Responses are scrubbed of nav/buttons and chunked (default 6000 chars) — text carries the first chunk, chunks the full series, length the total. truncated=false means no silent cuts.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'CSS selector of the answer container (default "main")' },
        waitUntil: { type: 'string', enum: ['now', 'settled'], description: '"settled" waits for textSettled + ariaBusy false (default "now")' },
        stableMs: { type: 'number', description: 'Text stability window for settled (default 800)' },
        chunkChars: { type: 'number', description: 'Chunk size in chars (default 6000; 0 = single blob)' },
        scrubSelectors: { type: 'array', description: 'Selectors to remove before extraction (default nav/buttons/header/footer)' },
        maxChars: { type: 'number', description: 'Safety cap (default 200000) — truncated flag reports if hit' },
        timeoutMs: { type: 'number', description: 'Timeout for the settled wait (default 30000)' },
        pollMs: { type: 'number', description: 'Poll interval for the settled wait (default 200)' },
      },
    },
  },
  {
    name: 'ensureEmpty',
    description: 'Framework-compatible input cleaner (P11). Triple-checks the element is empty (value/innerText/textContent), cleans it Angular/React-compatible (execCommand delete → native value setter as last resort), and re-verifies. Use after TYPE_PARTIAL or TYPE_RETRY_BLOCKED before typing again.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Text/aria query to find the element (preferred)' },
        selector: { type: 'string', description: 'Explicit CSS selector (overrides query)' },
        strategy: { type: 'string', enum: ['auto', 'execCommand', 'selectAll', 'force'], description: 'Cleaning strategy (default "auto": execCommand then force as last resort)' },
        backup: { type: 'boolean', description: 'Backup residual content to session memory (default true) — result includes residualBackupId' },
      },
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
  {
    name: 'macro_list',
    description: 'List all registered macros (built-in and user-defined). Use this first to discover available macros before calling macro_run.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'macro_run',
    description: 'Invoke a macro by name. Use macro_list first to see names and whether they take args.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Macro name (from macro_list)' },
        args: { type: 'object', description: "Macro arguments (validated against the macro's argsSchema if present)" },
        timeoutMs: { type: 'number', description: 'Override the macro default timeout (ms)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'macro_register',
    description: "Register a new user macro by writing its source to %APPDATA%\\.yautja-macros\\<name>.js and importing it. Source must export default a MacroDef object with { name, description, run }.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Macro name, filename-safe [a-z0-9_-]+' },
        source: { type: 'string', description: 'Full JavaScript source of the macro module' },
        overwrite: { type: 'boolean', description: 'Overwrite existing macro with same name (default false)' },
      },
      required: ['name', 'source'],
    },
  },
  {
    name: 'macro_delete',
    description: 'Delete a user-defined macro. Cannot delete built-in macros.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Macro name to delete' },
      },
      required: ['name'],
    },
  },
  // ─── Extension inspection tools ───────────────────────────────────
  {
    name: 'extList',
    description: 'List all installed Chrome extensions. Uses chrome.management API (richer data: permissions, enabled state, install type). Falls back to debugger targets if management permission unavailable.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', description: 'Filter by target type (e.g. "service_worker")' },
      },
    },
  },
  {
    name: 'extAttach',
    description: 'Deprecated. No longer required — extManifest, extSource, extStorage, extNetwork work by extId directly without attach. Returns a no-op success for backward compat.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        extId: { type: 'string', description: 'Chrome extension ID (32-char alphanumeric from chrome://extensions)' },
      },
      required: ['extId'],
    },
  },
  {
    name: 'extEval',
    description: 'Evaluate JavaScript in an extension service worker at runtime. Requires Chrome launched with --remote-debugging-port=9222. Has full chrome.* API access in the target extension context.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        extId: { type: 'string', description: 'Extension ID' },
        expression: { type: 'string', description: 'JavaScript expression to evaluate' },
        awaitPromise: { type: 'boolean', description: 'Await the result if it returns a Promise (default false)' },
      },
      required: ['extId', 'expression'],
    },
  },
  {
    name: 'extStorage',
    description: 'Read chrome.storage.local from disk (LevelDB). No Chrome changes needed — reads the extension storage directory directly. Returns all keys or a specific key.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        extId: { type: 'string', description: 'Extension ID' },
        area: { type: 'string', enum: ['local', 'sync', 'session'], description: 'Storage area (default "local")' },
        key: { type: 'string', description: 'Specific key to read (default: all keys)' },
      },
      required: ['extId'],
    },
  },
  {
    name: 'extSource',
    description: 'Read the source code of a file within an extension from disk. No Chrome changes needed. Default path is manifest.json.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        extId: { type: 'string', description: 'Extension ID' },
        path: { type: 'string', description: 'File path within the extension (default "manifest.json")' },
      },
      required: ['extId'],
    },
  },
  {
    name: 'extManifest',
    description: 'Read the manifest.json of an extension from disk. No Chrome changes needed. Returns parsed JSON.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        extId: { type: 'string', description: 'Extension ID' },
      },
      required: ['extId'],
    },
  },
  {
    name: 'extNetwork',
    description: 'Capture HTTP requests made by an extension. Uses chrome.webRequest filtered by initiator origin. action="start" to begin, action="list" to see captured requests, action="stop" to stop. Requires webRequest permission in Yautja extension.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        extId: { type: 'string', description: 'Extension ID' },
        action: { type: 'string', enum: ['start', 'stop', 'list'], description: 'Action to perform (default "list")' },
      },
      required: ['extId'],
    },
  },
  // ─── Tampermonkey integration tools ──────────────────────────────
  {
    name: 'tmListScripts',
    description: 'List all userscripts installed in Tampermonkey. Reads from chrome.storage.local on disk (no browser interaction needed). Returns script metadata: name, version, enabled state, URL matches, grants, etc.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        extId: { type: 'string', description: 'Tampermonkey extension ID (default: auto-detected)' },
      },
    },
  },
  {
    name: 'tmGetScript',
    description: 'Get the full source code and metadata of a specific Tampermonkey userscript by UUID. Use tmListScripts first to find the UUID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uuid: { type: 'string', description: 'Script UUID (from tmListScripts)' },
        extId: { type: 'string', description: 'Tampermonkey extension ID (default: auto-detected)' },
      },
      required: ['uuid'],
    },
  },
  {
    name: 'tmSearchScripts',
    description: 'Search GreasyFork.org for userscripts. Search by keyword query or by domain (finds scripts that run on a specific website). Returns name, description, author, install counts, ratings, and code_url for each result.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search keyword (e.g. "dark mode", "adblock")' },
        domain: { type: 'string', description: 'Find scripts for a specific site (e.g. "youtube.com", "github.com")' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
      },
    },
  },
  {
    name: 'tmInstallScript',
    description: 'Silently install a userscript into Tampermonkey. Provide the full userscript source code (with ==UserScript== header) or a URL to install from. Opens a hidden tab on greasyfork.org (an origin whitelisted by TM\'s externally_connectable) and uses CDP to inject chrome.runtime.connect(TM_ID) from the page context — TM\'s internal API accepts the install and skips the dialog. No visible tab, no manual confirmation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Full userscript source code (including ==UserScript== header block)' },
        url: { type: 'string', description: 'URL to install from (alternative to code) — content is fetched server-side then bridged' },
        extId: { type: 'string', description: 'Tampermonkey extension ID (default: auto-detected)' },
      },
    },
  },
  {
    name: 'tmToggleScript',
    description: 'Enable or disable a Tampermonkey userscript by UUID. Opens TM options page briefly to call the internal API, then restores your tab.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uuid: { type: 'string', description: 'Script UUID (from tmListScripts)' },
        enabled: { type: 'boolean', description: 'true to enable, false to disable' },
        extId: { type: 'string', description: 'Tampermonkey extension ID (default: auto-detected)' },
      },
      required: ['uuid', 'enabled'],
    },
  },
  {
    name: 'profileList',
    description: 'List loaded site profiles (P13): id, version, matched hosts, notes.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'profileLoad',
    description: 'Load a site profile by id (from loaded profiles) or by filesystem path (validates and registers it for this session).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Profile id (e.g. "perplexity", "gemini")' },
        path: { type: 'string', description: 'Filesystem path to a profile JSON file' },
      },
    },
  },
  {
    name: 'profileStatus',
    description: 'Show the active site profile for the current tab: matched rules, budget/quota view (economic sensor), session query burn, last preflight result.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'preflight',
    description: 'Run the active site profile preflight checks before an expensive action (P13). Aborts with YJ.POLICY.QUOTA_EXHAUSTED or YJ.POLICY.GATE_DENIED before burning quota.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['type', 'navigate', 'intercept'], description: 'Action to preflight (default: run profile checks only)' },
        url: { type: 'string', description: 'Destination URL (required when action is "navigate")' },
      },
    },
  },
  {
    name: 'gateStatus',
    description: 'Show session gate state (P14): default gate (P0) and active grants with level, scope, usage and expiry.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'gateGrant',
    description: 'Grant a session gate level (P14). ONLY call this when the user explicitly asked in chat — phrase must record their exact words (audit trail, grantedBy: user_phrase). Gates: P1=GET no cookies, P2=GET with cookies, P3=mutations, P4=exotic.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        level: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4'], description: 'Gate level to grant' },
        hosts: { type: 'array', description: 'Hostnames in scope (e.g. ["api.example.com"])' },
        pathPrefix: { type: 'string', description: 'Optional path prefix scope' },
        methods: { type: 'array', description: 'Optional method whitelist' },
        phrase: { type: 'string', description: 'REQUIRED: the user\'s exact authorization words' },
        maxRequests: { type: 'number', description: 'Optional request cap for this grant' },
        maxRps: { type: 'number', description: 'Optional per-host rate limit override' },
        expiresAt: { type: 'string', description: 'Optional ISO expiry timestamp' },
      },
      required: ['level', 'hosts', 'phrase'],
    },
  },
  {
    name: 'gateRevoke',
    description: 'Revoke session gate grants (P14): by level or all.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        level: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4'], description: 'Revoke grants of this level' },
        all: { type: 'boolean', description: 'Revoke every grant' },
      },
    },
  },
  {
    name: 'browserFetch',
    description: 'Fetch from the page context with the tab cookie jar (P14) — gated. Default gate P0: without a grant the call is denied (YJ.POLICY.GATE_DENIED). Secrets in response are masked by default; set-cookie never returned. Use gateGrant first (user approval required).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Target URL' },
        method: { type: 'string', enum: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method (default GET)' },
        headers: { type: 'object', description: 'Request headers' },
        body: { type: 'string', description: 'Request body' },
        credentials: { type: 'string', enum: ['include', 'omit'], description: 'Cookie jar (default include → requires P2)' },
        maxRps: { type: 'number', description: 'Per-host rate limit override' },
        timeoutMs: { type: 'number', description: 'Fetch timeout (default 15000)' },
        redactResponse: { type: 'boolean', description: 'Mask secrets in body (default true)' },
        maxBodyChars: { type: 'number', description: 'Body cap (default 200000) — truncated flag reports if hit' },
        captureAsEvidence: { type: 'boolean', description: 'Store body as content-addressed evidence, returns evidenceId' },
      },
      required: ['url'],
    },
  },
  {
    name: 'apiSurface',
    description: 'Machine-readable API surface (P15): endpoints from captured network traffic + paths found in loaded JS bundles, merged with auth hints and confidence. Passive recon output for api-recon workflows.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sources: { type: 'array', description: 'Sources to merge: "network", "bundles" (default both)' },
      },
    },
  },
  {
    name: 'exportHar',
    description: 'Export captured network traffic as HAR 1.2 (P15) to ~/.yautja/har/. Redacted by default (sensitive headers dropped, secrets masked); large bodies externalized as sha256 stubs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filter: { type: 'object', description: '{ urlIncludes?, method? }' },
        redact: { type: 'boolean', description: 'Redact secrets (default true)' },
        sinceMs: { type: 'number', description: 'Only entries from the last N ms' },
      },
    },
  },
  {
    name: 'evidencePut',
    description: 'Store evidence content-addressed and redacted (P15). Provide body+host manually, or fromLastFetch:true to store the last browserFetch response.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        body: { type: 'string', description: 'Body to store' },
        host: { type: 'string', description: 'Host the evidence belongs to' },
        url: { type: 'string' },
        method: { type: 'string' },
        kind: { type: 'string', enum: ['browserFetch', 'intercept', 'manual'], description: 'Evidence kind (default manual)' },
        runId: { type: 'string', description: 'Run grouping (default: session id)' },
        fromLastFetch: { type: 'boolean', description: 'Store the last browserFetch response' },
        storeRaw: { type: 'boolean', description: 'Store unredacted (requires analystMode)' },
      },
    },
  },
  {
    name: 'evidenceGet',
    description: 'Retrieve evidence by id (P15). Redacted by default; includeRaw requires analystMode (YAUTJA_ANALYST_MODE=1).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Evidence id (ev_...)' },
        includeRaw: { type: 'boolean', description: 'Return unredacted body (analystMode only)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'evidenceList',
    description: 'List evidence records (P15), filterable by host or runId.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        host: { type: 'string' },
        runId: { type: 'string' },
      },
    },
  },
  {
    name: 'responseDiff',
    description: 'Diff two response bodies (P15): JSON deep diff {added, removed, changed} with dotted paths (BOLA-style extra-field detection), text line-diff fallback. Inputs: evidence ids or { body }.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        a: { description: 'Evidence id or { body: string }' },
        b: { description: 'Evidence id or { body: string }' },
        ignorePaths: { type: 'array', description: 'Dotted paths to ignore (e.g. ["data.timestamp"])' },
      },
      required: ['a', 'b'],
    },
  },
  {
    name: 'trustedClick',
    description: 'Click via CDP Input.dispatchMouseEvent (P16) — the DOM event is isTrusted:true, unlike el.click(). Use for SPAs that reject synthetic clicks (uploads, payment widgets).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector of the target' },
        query: { type: 'string', description: 'Text/aria query to find the element (alternative to selector)' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left)' },
        clickCount: { type: 'number', description: 'Number of clicks (default 1)' },
      },
    },
  },
  {
    name: 'trustedFileChooser',
    description: 'Attach files to a file input or upload trigger (P16). Direct DOM.setFileInputFiles for input[type=file]; file chooser intercept + trusted click for trigger buttons. Returns YJ.PROTOCOL.CAPABILITY_MISSING (never fake success) if the backend lacks support — delegate to SuperAPI file_upload then.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        triggerSelector: { type: 'string', description: 'CSS selector of the file input or trigger button' },
        triggerQuery: { type: 'string', description: 'Text/aria query to find it' },
        files: { type: 'array', description: 'Absolute file paths to attach (must exist on disk)' },
        timeoutMs: { type: 'number', description: 'File chooser wait timeout (default 10000)' },
      },
      required: ['files'],
    },
  },
  {
    name: 'capabilities',
    description: 'Capability matrix for this session (P16): stealth, intercept (profile-aware), trustedClick, trustedFileChooser, silentNetwork, browserFetch, and configured backends (yautja/superapi/chromeDevtools). Check before choosing an action path.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'snapshotSave',
    description: 'Capture a session snapshot (P17): cookies + localStorage + current URL, saved by name to ~/.yautja/snapshots/. Lab tool — see snapshotRestore OPSEC warning.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Snapshot name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'snapshotList',
    description: 'List saved session snapshots (P17).',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'snapshotRestore',
    description: 'Restore a session snapshot (P17). include selects ["cookies","localStorage","url"]. Foreign-domain cookies are skipped; restoring cookies on a non-lab host returns an opsecWarning you MUST surface to the user.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Snapshot name' },
        include: { type: 'array', description: 'What to restore: "cookies", "localStorage", "url" (default all)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'delegate',
    description: 'Route a capability to the right backend (P18): observe/act/network_listen → yautja native; heap_profile/cpu_profile → chrome-devtools; file_upload → superapi. Config in ~/.yautja/backends.json. Dry-run: returns the routing decision; unconfigured backend → YJ.PROTOCOL.CAPABILITY_MISSING.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        capability: { type: 'string', enum: ['heap_profile', 'cpu_profile', 'file_upload', 'observe', 'act', 'network_listen'], description: 'Capability to route' },
        args: { type: 'object', description: 'Capability args (reserved)' },
      },
      required: ['capability'],
    },
  },
  {
    name: 'recovery_stats',
    description: 'Recovery outcome statistics from doctrine telemetry. Filter by error code, recovery strategy, or start time. Shows success rate, avg time-to-recover, and context cost of failed operations.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Filter by error code (e.g. YJ.ACT.DOM_TARGET_NOT_FOUND)' },
        strategy: { type: 'string', description: 'Filter by recovery strategy (RETRY_SAME, REOBSERVE_THEN_RETRY, ROLLBACK_TO_CHECKPOINT, REQUEST_APPROVAL, ABORT)' },
        since: { type: 'number', description: 'Only outcomes after this timestamp (ms)' },
      },
    },
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
