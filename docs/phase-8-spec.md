# Yautja — Phase 8 Implementation Spec

## Context

Phases 1-7 DONE. 340 tests. Sensors + Memory + Targeting + Arsenal complete.

Phase 8 builds the **Neural-Link** — the connection between Yautja and MiniMax M3 (or any OpenAI-compatible LLM). This is where the LLM becomes the hunter.

## Architecture

```
User question
  ↓
Neural-Link builds prompt:
  system: "You are a browser expert using Yautja..."
  context: Observation from AttentionRouter
  tools: [observe, act, inspect, diff]
  ↓
MiniMax M3 responds with tool_call
  ↓
Neural-Link executes tool → result
  ↓
MiniMax M3 gets result → next tool_call OR final answer
  ↓
Loop until final answer → return to user
```

## Modules

1. `src/neural-link/types.ts` — LLM message types + tool definitions
2. `src/neural-link/client.ts` — OpenAI-compatible API client
3. `src/neural-link/conversation.ts` — conversation loop (observe → act → observe)
4. `tests/neural-link/conversation.test.ts`

## Module 1: Types

**File:** `src/neural-link/types.ts`

```typescript
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: LLMToolCall[];
}

export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface LLMConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
  maxIterations: number;
  temperature: number;
}

export interface LLMResponse {
  message: LLMMessage;
  finishReason: 'stop' | 'tool_calls' | 'length';
  usage?: { promptTokens: number; completionTokens: number };
}

export const YAUTJA_TOOLS: LLMTool[] = [
  {
    type: 'function',
    function: {
      name: 'observe',
      description: 'Get a focused observation of the browser state based on a question. The attention router selects which domains (network, DOM, console, performance, security) are relevant.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'What you want to know about the browser state' },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'act',
      description: 'Execute a browser action. Actions include: navigate, click, type, press, scroll, evaluate, screenshot, getCookies, setCookie, wait, reload, and more.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'object', description: 'The browser action to execute' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect',
      description: 'Deep-dive into a specific sensor domain for detailed data that the observation might have truncated.',
      parameters: {
        type: 'object',
        properties: {
          domain: { type: 'string', enum: ['network', 'dom', 'console', 'performance', 'security'] },
          query: { type: 'object', description: 'Optional filter parameters', additionalProperties: true },
        },
        required: ['domain'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'diff',
      description: 'Show what changed in the browser since the last action.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

export const SYSTEM_PROMPT = `You are Yautja — an expert browser analyst with enhanced perception.

You can see and control a web browser through your bio-helmet (Yautja). You have 4 tools:

1. observe(question) — Get a focused view of the browser state. Ask what you want to know.
2. act(action) — Execute a browser action (navigate, click, type, screenshot, etc).
3. inspect(domain) — Get detailed data from a specific domain (network, dom, console, performance, security).
4. diff() — See what changed since your last action.

Your workflow:
1. First, observe the current state to understand the page.
2. If the user asks a question, use observe + inspect to gather evidence.
3. If the user wants an action, use act and then diff to verify.
4. Always provide a clear, concise answer backed by the data you observed.

Be efficient. Don't call tools unnecessarily. If you have enough information from a previous observation, answer directly.`;
```

## Module 2: LLM Client

**File:** `src/neural-link/client.ts`

Minimal OpenAI-compatible chat completions client. No SDK dependency — just `fetch`.

```typescript
import type { LLMMessage, LLMTool, LLMResponse, LLMConfig } from './types.js';

export class LLMClient {
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  async chat(
    messages: LLMMessage[],
    tools?: LLMTool[],
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const body: Record<string, any> = {
      model: this.config.model,
      messages,
      temperature: this.config.temperature,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const response = await fetch(`${this.config.apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`LLMClient: API returned ${response.status}: ${text.substring(0, 200)}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error('LLMClient: no choices in response');
    }

    const message = choice.message as LLMMessage;
    const finishReason = choice.finish_reason as LLMResponse['finishReason'];
    const usage = data.usage
      ? { promptTokens: data.usage.prompt_tokens ?? 0, completionTokens: data.usage.completion_tokens ?? 0 }
      : undefined;

    return { message, finishReason, usage };
  }
}
```

## Module 3: Conversation Loop

**File:** `src/neural-link/conversation.ts`

This is the core loop: LLM observes → calls tools → gets results → observes again → final answer.

```typescript
import { LLMClient } from './client.js';
import type { LLMMessage, LLMConfig, LLMResponse } from './types.js';
import { YAUTJA_TOOLS, SYSTEM_PROMPT } from './types.js';
import type { AttentionRouter } from '../targeting/router.js';
import type { WorkingMemory } from '../memory/browser-state.js';
import type { Anomaly } from '../vision/base-sensor.js';
import type { BrowserAction, ActionResult } from '../arsenal/action-types.js';
import type { Transport } from '../vision/base-sensor.js';
import { ActionTranslator } from '../arsenal/translator.js';

export interface ConversationContext {
  router: AttentionRouter;
  memory: WorkingMemory;
  transport: Transport;
  getPageState: () => Promise<{
    state: import('../memory/browser-state.js').BrowserState;
    anomalies: Anomaly[];
  }>;
}

export interface ConversationResult {
  answer: string;
  iterations: number;
  toolCalls: number;
  history: LLMMessage[];
}

export class Conversation {
  private client: LLMClient;
  private ctx: ConversationContext;
  private messages: LLMMessage[] = [];
  private toolCallCount = 0;

  constructor(config: LLMConfig, ctx: ConversationContext) {
    this.client = new LLMClient(config);
    this.ctx = ctx;
    this.messages.push({ role: 'system', content: SYSTEM_PROMPT });
  }

  async ask(question: string): Promise<ConversationResult> {
    this.messages.push({ role: 'user', content: question });

    const maxIterations = 10;
    let iterations = 0;

    while (iterations < maxIterations) {
      iterations++;
      const response = await this.client.chat(this.messages, YAUTJA_TOOLS);
      this.messages.push(response.message);

      if (response.finishReason === 'stop' || !response.message.tool_calls) {
        return {
          answer: response.message.content || '(no response)',
          iterations,
          toolCalls: this.toolCallCount,
          history: [...this.messages],
        };
      }

      for (const toolCall of response.message.tool_calls) {
        this.toolCallCount++;
        const result = await this.executeToolCall(toolCall.function.name, toolCall.function.arguments);
        this.messages.push({
          role: 'tool',
          content: JSON.stringify(result),
          tool_call_id: toolCall.id,
        });
      }
    }

    return {
      answer: '(max iterations reached)',
      iterations,
      toolCalls: this.toolCallCount,
      history: [...this.messages],
    };
  }

  private async executeToolCall(name: string, args: string): Promise<any> {
    let parsed: any;
    try {
      parsed = JSON.parse(args);
    } catch {
      return { error: 'invalid arguments' };
    }

    switch (name) {
      case 'observe': {
        const { state, anomalies } = await this.ctx.getPageState();
        const observation = this.ctx.router.observe(
          parsed.question || 'overview',
          state,
          anomalies,
        );
        return { observation: observation.text, domains: observation.domains };
      }

      case 'act': {
        const translator = new ActionTranslator(this.ctx.transport);
        const result: ActionResult = await translator.execute(parsed.action as BrowserAction);
        if (!result.ok) {
          return { error: result.error.message, errorType: result.error.type, recoveryHint: result.error.recoveryHint };
        }
        // After action, update memory
        const { state, anomalies } = await this.ctx.getPageState();
        this.ctx.memory.update(state);
        return { success: true, value: result.value };
      }

      case 'inspect': {
        const { state } = await this.ctx.getPageState();
        const domain = parsed.domain as string;
        switch (domain) {
          case 'network': return state.network;
          case 'dom': return state.dom;
          case 'console': return state.console;
          case 'performance': return state.performance;
          case 'security': return state.security;
          default: return { error: `unknown domain: ${domain}` };
        }
      }

      case 'diff': {
        const diff = this.ctx.memory.diff();
        if (!diff) return { message: 'no previous state to diff' };
        return diff;
      }

      default:
        return { error: `unknown tool: ${name}` };
    }
  }

  getHistory(): LLMMessage[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    this.toolCallCount = 0;
  }
}
```

### Implementation Notes

1. **`LLMClient`** uses `fetch()` — no external SDK. Works with any OpenAI-compatible endpoint (MiniMax, OpenAI, local, etc.).

2. **`Conversation.ask()`** is the main entry point. User asks a question → LLM loops with tool calls → returns answer.

3. **Tool execution:**
   - `observe` → uses AttentionRouter to produce focused observation
   - `act` → uses ActionTranslator to execute, then updates WorkingMemory
   - `inspect` → returns raw sensor summary for a domain
   - `diff` → returns StateDiff from WorkingMemory

4. **`getPageState()`** is a callback provided by the caller (helmet.ts in Phase 9). It gathers all 5 sensor summaries + anomalies into a BrowserState.

5. **Max iterations**: 10 by default. Prevents infinite loops.

6. **No `any` in YOUR interfaces** — but LLM tool arguments are `any` since they come from the model.

## Test cases

Mock the LLM client to return predetermined tool calls:

```
Conversation:
- ask sends system + user message to LLMClient
- LLM responds with stop → returns answer
- LLM responds with tool_call(observe) → executes observe → sends result back
- LLM responds with tool_call(act) → executes action → sends result back
- LLM responds with tool_call(inspect) → returns domain summary
- LLM responds with tool_call(diff) → returns state diff
- LLM loops: observe → act → observe → stop
- max iterations reached → returns fallback
- invalid tool arguments → returns error to LLM
- unknown tool name → returns error
- clear resets messages
- toolCalls counter increments correctly

LLMClient:
- chat sends correct headers and body
- chat throws on non-OK response
- chat throws on no choices
- chat maps usage tokens correctly
- chat passes tools when provided
```

## Deliverables

1. `src/neural-link/types.ts`
2. `src/neural-link/client.ts`
3. `src/neural-link/conversation.ts`
4. `tests/neural-link/conversation.test.ts`

After writing: `cd D:\Yautja && npx vitest run && npm run lint`
Report full output.
