import Anthropic from '@anthropic-ai/sdk';

/** Блок сообщения (совместим с Anthropic content blocks). */
export type LlmBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface LlmMsg {
  role: 'user' | 'assistant';
  content: LlmBlock[];
}
export interface LlmToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
export interface LlmResp {
  stopReason: 'end' | 'tool_use';
  blocks: LlmBlock[];
}
export interface LlmRunInput {
  apiKey: string;
  model: string;
  system: string;
  messages: LlmMsg[];
  tools: LlmToolDef[];
}

/** Абстракция вызова модели — один ход (может вернуть tool_use). В тестах подменяется фейком. */
export interface LlmProvider {
  run(input: LlmRunInput): Promise<LlmResp>;
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

/** Реальный провайдер поверх Anthropic SDK. */
export class AnthropicProvider implements LlmProvider {
  async run(input: LlmRunInput): Promise<LlmResp> {
    const client = new Anthropic({ apiKey: input.apiKey });
    const res = await client.messages.create({
      model: input.model,
      max_tokens: 1024,
      system: input.system,
      tools: input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool.InputSchema,
      })),
      messages: input.messages as Anthropic.MessageParam[],
    });
    const blocks: LlmBlock[] = res.content.map((b) => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      return { type: 'text', text: '' };
    });
    return { stopReason: res.stop_reason === 'tool_use' ? 'tool_use' : 'end', blocks };
  }
}
