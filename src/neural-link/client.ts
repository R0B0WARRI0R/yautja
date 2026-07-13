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

    const data = (await response.json()) as Record<string, any>;
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