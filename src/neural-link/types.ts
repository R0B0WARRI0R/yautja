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