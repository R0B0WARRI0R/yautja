# Yautja — Phase 9 Implementation Spec

## Context

Phases 1-8 DONE. 388 tests. All layers built.

Phase 9 builds the **Helmet** — an MCP server that exposes Yautja's 4 tools to ANY agent. This is the primary interface. Any MCP-compatible agent (opencode, Claude, etc.) can perceive and control a browser through Yautja.

## Architecture

```
ANY agent (opencode, Claude, MiniMax, GPT...)
  ↕ MCP protocol (stdio)
Yautja Helmet (MCP server)
  ├── Tool: observe(question) → AttentionRouter → Observation text
  ├── Tool: act(action)       → ActionTranslator → CDP → browser
  ├── Tool: inspect(domain)   → Sensor summary
  └── Tool: diff()            → StateDiff
  ↕ WebSocket
Extension (in Brave)
  ↕ chrome.debugger
Browser tabs
```

## Modules

1. `src/helmet.ts` — MCP server + lifecycle (connects all pieces)
2. `tests/helmet.test.ts`

## MCP Protocol

Yautja uses the MCP (Model Context Protocol) over stdio. The protocol is JSON-RPC 2.0.

### MCP messages

**Initialize:**
```json
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"yautja","version":"0.1.0"}}}
```

**Initialized notification:**
```json
→ {"jsonrpc":"2.0","method":"notifications/initialized"}
```

**List tools:**
```json
→ {"jsonrpc":"2.0","id":2,"method":"tools/list"}
← {"jsonrpc":"2.0","id":2,"result":{"tools":[...4 tools...]}}
```

**Call tool:**
```json
→ {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"observe","arguments":{"question":"why is this slow?"}}}
← {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"...observation..."}]}}
```

### Tool definitions

```typescript
const TOOLS = [
  {
    name: 'observe',
    description: 'Get a focused observation of the browser state. The attention router selects which domains (network, DOM, console, performance, security) are relevant to your question.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'What you want to know about the browser' },
      },
      required: ['question'],
    },
  },
  {
    name: 'act',
    description: 'Execute a browser action. Types: navigate, click, doubleClick, hover, focus, type, press, select, check, scroll, evaluate, evaluateAsync, screenshot, reload, goBack, goForward, getCookies, setCookie, deleteCookies, getLocalStorage, setLocalStorage, clearStorage, wait.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'object', description: 'The browser action object with a "type" field' },
      },
      required: ['action'],
    },
  },
  {
    name: 'inspect',
    description: 'Deep-dive into a specific sensor domain for detailed data.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', enum: ['network', 'dom', 'console', 'performance', 'security'] },
      },
      required: ['domain'],
    },
  },
  {
    name: 'diff',
    description: 'Show what changed in the browser since the last action.',
    inputSchema: { type: 'object', properties: {} },
  },
];
```

## Helmet class

**File:** `src/helmet.ts`

```typescript
import { createInterface, type Interface } from 'readline';
import { ExtensionServer } from './connection/extension-server.js';
import { ThermalSensor } from './vision/thermal.js';
import { EMSensor } from './vision/em.js';
import { AudioSensor } from './vision/audio.js';
import { MotionSensor } from './vision/motion.js';
import { ThreatSensor } from './vision/threat.js';
import { WorkingMemory } from './memory/browser-state.js';
import { AttentionRouter } from './targeting/router.js';
import { ActionTranslator } from './arsenal/translator.js';
import type { BrowserState } from './memory/browser-state.js';
import type { Anomaly, Transport } from './vision/base-sensor.js';
import type { BrowserAction } from './arsenal/action-types.js';

export interface HelmetConfig {
  port: number;          // WebSocket port for extension (default 9876)
  autoAttach: boolean;   // Auto-attach to active tab on connect (default true)
}

const DEFAULT_CONFIG: HelmetConfig = {
  port: 9876,
  autoAttach: true,
};

export class Helmet {
  private config: HelmetConfig;
  private server: ExtensionServer;
  private router: new AttentionRouter();
  private memory: WorkingMemory;
  private thermal: ThermalSensor;
  private em: EMSensor;
  private audio: AudioSensor;
  private motion: MotionSensor;
  private threat: ThreatSensor;
  private translator: ActionTranslator;
  private attached = false;

  constructor(config?: Partial<HelmetConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.server = new ExtensionServer(this.config.port);
    this.router = new AttentionRouter();
    this.memory = new WorkingMemory(5);

    // Create sensors with server as transport
    this.thermal = new ThermalSensor(this.server);
    this.em = new EMSensor(this.server);
    this.audio = new AudioSensor(this.server);
    this.motion = new MotionSensor(this.server);
    this.threat = new ThreatSensor(this.server);

    // Action translator
    this.translator = new ActionTranslator(this.server);
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    await this.server.start();
    // Wait for extension to connect
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

    // Subscribe all sensors
    this.thermal.subscribe();
    this.em.subscribe();
    this.audio.subscribe();
    this.motion.subscribe();
    this.threat.subscribe();

    // Enable domains (Security may fail via extension — that's OK)
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

  // ─── Tab management ─────────────────────────────────────────

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

  // ─── Tool: observe ──────────────────────────────────────────

  async observe(question: string): Promise<string> {
    const { state, anomalies } = await this.gatherState();
    const observation = this.router.observe(question, state, anomalies);
    return observation.text;
  }

  // ─── Tool: act ──────────────────────────────────────────────

  async act(action: BrowserAction): Promise<string> {
    const { state: beforeState } = await this.gatherState();
    this.memory.update(beforeState);

    const result = await this.translator.execute(action);

    // Wait for stabilization
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

    // Include diff if action was not inspection
    const diff = this.memory.diff();
    const diffText = diff && diff.fields.length > 0
      ? `\n\nChanges: ${diff.fields.join(', ')}`
      : '';

    return JSON.stringify({ success: true, value: result.value }) + diffText;
  }

  // ─── Tool: inspect ──────────────────────────────────────────

  async inspect(domain: string): Promise<string> {
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

  // ─── Tool: diff ─────────────────────────────────────────────

  async diff(): Promise<string> {
    const diff = this.memory.diff();
    if (!diff) return 'No previous state to compare. Perform an action first.';
    return JSON.stringify(diff, null, 2);
  }

  // ─── MCP Server ─────────────────────────────────────────────

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
            // No response needed
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

  // ─── Internal ───────────────────────────────────────────────

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
```

### Implementation Notes

1. **MCP over stdio**: reads JSON-RPC messages from stdin, writes responses to stdout. This is the standard MCP transport for local servers.

2. **`start()`** is called before `serveMCP()`. It connects to the extension, attaches to a tab, subscribes sensors, enables domains. Once ready, `serveMCP()` starts the stdin loop.

3. **Error handling in MCP**: errors are returned as JSON-RPC error objects with code and message. Tool failures return success=false in the content text (not as MCP errors — the agent can read the error and decide what to do).

4. **`gatherState()`** gathers all 5 sensor summaries in parallel. If EM fails (Runtime.evaluate might not work on some pages), it falls back to empty DOM data.

5. **Security domain**: may not be available via chrome.debugger extension. `start()` enables it with try/catch. The threat sensor still works but won't receive security events.

6. **`autoAttach`**: when true, the helmet attaches to the active tab on start. Can be disabled for multi-tab scenarios.

## Entry point

**File:** `src/helmet-main.ts` (separate entry, not tested)

```typescript
import { Helmet } from './helmet.js';

async function main() {
  const helmet = new Helmet();

  process.stderr.write('[Yautja] Starting helmet...\n');
  await helmet.start();
  process.stderr.write('[Yautja] Ready. Serving MCP on stdio.\n');

  helmet.serveMCP();
}

main().catch((err) => {
  process.stderr.write(`[Yautja] Fatal: ${err}\n`);
  process.exit(1);
});
```

## Test cases

The Helmet class can be tested without a real browser by mocking ExtensionServer. For Phase 9, focus on MCP protocol tests:

```
MCP protocol:
- initialize returns correct serverInfo
- tools/list returns 4 tools with correct schemas
- tools/call observe returns observation text
- tools/call act returns action result
- tools/call inspect returns domain summary
- tools/call diff returns state diff
- unknown method returns error -32601
- unknown tool returns error text
- ping returns empty result

Helmet lifecycle:
- start connects to extension + attaches + subscribes sensors
- isReady false before start, true after
- stop unsubscribes all sensors
```

**Mock strategy**: Create a `MockExtensionServer` that implements just enough of ExtensionServer's interface for Helmet to work. Mock `send()` to return canned CDP responses for Runtime.evaluate (DOM extraction), Performance.getMetrics, etc.

## Deliverables

1. `src/helmet.ts`
2. `src/helmet-main.ts` (entry point, no tests)
3. `tests/helmet.test.ts`
4. Add to `package.json`: `"helmet": "tsc && node dist/helmet-main.js"`
5. Add to `opencode.json` MCP config:
```json
"yautja": {
  "enabled": true,
  "type": "local",
  "command": ["node", "D:/Yautja/dist/helmet-main.js"],
  "timeout": 30000
}
```

After writing: `cd D:\Yautja && npx vitest run && npm run lint`
Report full output.
