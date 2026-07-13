import { LLMClient } from './client.js';
import type { LLMMessage, LLMConfig } from './types.js';
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
        const { state } = await this.ctx.getPageState();
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