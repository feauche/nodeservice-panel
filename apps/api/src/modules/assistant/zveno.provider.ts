import type { LlmBlock, LlmProvider, LlmResp, LlmRunInput } from './llm.provider.js';

/** Базовый URL zveno.ai (OpenAI-совместимый шлюз). Переопределяется env ZVENO_BASE_URL. */
const BASE_URL = process.env.ZVENO_BASE_URL ?? 'https://api.zveno.ai/v1';

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

/**
 * Провайдер поверх OpenAI-совместимого API (zveno.ai): маппит наш формat блоков
 * (text/tool_use/tool_result) в chat.completions и обратно.
 */
export class ZvenoProvider implements LlmProvider {
  async run(input: LlmRunInput): Promise<LlmResp> {
    const messages: OpenAiMessage[] = [{ role: 'system', content: input.system }];
    for (const m of input.messages) {
      const texts = m.content.filter((b): b is Extract<LlmBlock, { type: 'text' }> => b.type === 'text');
      const toolUses = m.content.filter(
        (b): b is Extract<LlmBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      );
      const toolResults = m.content.filter(
        (b): b is Extract<LlmBlock, { type: 'tool_result' }> => b.type === 'tool_result',
      );
      if (m.role === 'assistant') {
        messages.push({
          role: 'assistant',
          content: texts.map((t) => t.text).join('\n') || null,
          ...(toolUses.length
            ? {
                tool_calls: toolUses.map((u) => ({
                  id: u.id,
                  type: 'function' as const,
                  function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) },
                })),
              }
            : {}),
        });
      } else {
        // Результаты инструментов идут отдельными сообщениями role:'tool'.
        for (const r of toolResults)
          messages.push({ role: 'tool', tool_call_id: r.tool_use_id, content: r.content });
        const text = texts.map((t) => t.text).join('\n');
        if (text) messages.push({ role: 'user', content: text });
      }
    }

    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: 4096,
        messages,
        // Пустой список инструментов провайдеры отвергают: без инструментов поле не отправляем.
        ...(input.tools.length > 0
          ? {
              tools: input.tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.input_schema },
              })),
            }
          : {}),
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`zveno.ai ответил ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: OpenAiMessage; finish_reason?: string }>;
    };
    const choice = data.choices?.[0];
    const msg = choice?.message;
    const blocks: LlmBlock[] = [];
    if (msg?.content) blocks.push({ type: 'text', text: msg.content });
    for (const call of msg?.tool_calls ?? []) {
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(call.function.arguments || '{}');
      } catch {
        parsed = {};
      }
      blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parsed });
    }
    // Есть вызовы — значит tool_use, каким бы ни был finish_reason: иначе вызов теряется, а модель «обещала».
    return { stopReason: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end', blocks };
  }
}
