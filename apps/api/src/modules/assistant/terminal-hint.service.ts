import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { TerminalHintRequest, TerminalHintResponse } from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';
import { AuditService } from '../audit/audit.service.js';
import { ServersService } from '../servers/servers.service.js';
import { READ_TOOL_DEFS, runReadTool } from './assistant.read-tools.js';
import { ReadDepsService } from './assistant-read-deps.service.js';
import { AssistantSettingsStore } from './assistant-settings.store.js';
import { LLM_PROVIDER, type LlmBlock, type LlmMsg, type LlmProvider } from './llm.provider.js';
import { hintSystem, lastLines, maskSecrets, parseHint, SUBMIT_HINT_TOOL } from './terminal-hint.logic.js';

const ROUNDS = 4;
const HINT_TOOLS = [
  ...READ_TOOL_DEFS.filter((t) => t.name === 'get_server_detail' || t.name === 'get_metrics_history'),
  SUBMIT_HINT_TOOL,
];

/**
 * Подсказки к терминалу (R4.6): администратор сам показывает Джарвису последние строки вывода.
 * Секреты и адреса маскируются до отправки, Джарвис ничего не выполняет, команды из подсказки
 * только вставляются в строку ввода у администратора.
 */
@Injectable()
export class TerminalHintService {
  private readonly log = new Logger(TerminalHintService.name);

  constructor(
    private readonly settings: AssistantSettingsStore,
    private readonly servers: ServersService,
    private readonly deps: ReadDepsService,
    private readonly audit: AuditService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
  ) {}

  async hint(serverId: string, req: TerminalHintRequest): Promise<TerminalHintResponse> {
    const cfg = await this.settings.config();
    if (!cfg)
      throw problem(HttpStatus.CONFLICT, {
        detail: 'Джарвис выключен: задайте провайдера, ключ и модель в «Настройки → Джарвис».',
      });
    if (!cfg.permissions.terminalHints)
      throw problem(HttpStatus.CONFLICT, {
        detail: 'Подсказки в терминале выключены: включите их в «Настройки → Джарвис → Разрешения».',
      });
    const server = (await this.servers.list()).find((s) => s.id === serverId);
    if (!server) throw problem(HttpStatus.NOT_FOUND, { detail: 'Сервер не найден.' });
    const masked = maskSecrets(lastLines(req.text));
    if (!masked.text.trim())
      throw problem(HttpStatus.BAD_REQUEST, { detail: 'В терминале пока нет вывода: подсказывать нечего.' });

    const os = [server.facts.os, server.facts.osVersion].filter(Boolean).join(' ') || null;
    const question = req.question?.trim();
    const messages: LlmMsg[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `<вывод>\n${masked.text}\n</вывод>${question ? `\n\nВопрос администратора: ${question}` : ''}\n\nДайте подсказку.`,
          },
        ],
      },
    ];
    const deps = this.deps.get(cfg.permissions);
    let result: Omit<TerminalHintResponse, 'masked'> | null = null;
    try {
      for (let round = 0; round < ROUNDS && !result; round += 1) {
        const res = await this.llm.run({
          apiKey: cfg.apiKey,
          model: cfg.model,
          system: hintSystem({ name: server.name, os }, cfg.level),
          messages,
          tools: HINT_TOOLS,
        });
        const uses = res.blocks.filter(
          (b): b is Extract<LlmBlock, { type: 'tool_use' }> => b.type === 'tool_use',
        );
        if (uses.length === 0) break;
        messages.push({ role: 'assistant', content: res.blocks });
        const results: LlmBlock[] = [];
        for (const use of uses) {
          let content: string;
          if (use.name === 'submit_hint') {
            const parsed = parseHint(use.input);
            if (parsed.ok) result = parsed.value;
            content = parsed.ok ? 'Подсказка принята.' : parsed.error;
          } else if (use.name === 'get_server_detail' || use.name === 'get_metrics_history') {
            try {
              content =
                (
                  await runReadTool(
                    use.name,
                    { ...((use.input ?? {}) as Record<string, unknown>), serverId },
                    deps,
                  )
                )?.content ?? 'Нет данных.';
            } catch {
              content = 'Инструмент временно недоступен.';
            }
          } else content = 'Этот инструмент здесь недоступен.';
          results.push({ type: 'tool_result', tool_use_id: use.id, content });
        }
        messages.push({ role: 'user', content: results });
      }
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.log.warn(`Подсказка к терминалу: ${err instanceof Error ? err.message : err}`);
      const m = err instanceof Error ? `${err.name} ${err.message}` : '';
      throw problem(HttpStatus.FAILED_DEPENDENCY, {
        detail: /Timeout|Abort/i.test(m)
          ? 'Провайдер не ответил за 60 секунд. Повторите.'
          : /ответил (401|403)/.test(m)
            ? 'Провайдер отклонил ключ. Проверьте ключ в «Настройки → Джарвис».'
            : 'Не удалось получить ответ Джарвиса. Повторите.',
      });
    }
    if (!result)
      throw problem(HttpStatus.FAILED_DEPENDENCY, { detail: 'Джарвис не дал подсказки. Повторите.' });

    await this.audit.record({
      action: 'server.terminal.hint',
      target: { type: 'server', id: server.id, display: server.name },
      // Сам вывод терминала в Журнал не пишем: только сколько ушло и сколько скрыто.
      metadata: {
        model: cfg.model,
        chars: masked.text.length,
        masked: masked.count,
        withQuestion: Boolean(question),
      },
    });
    return { ...result, masked: masked.count };
  }
}
