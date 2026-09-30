import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  type CreateNotificationRequest,
  createNotificationRequestSchema,
  type IncidentKind,
  type Notification,
  type NotificationLink,
  type NotificationSeverity,
  type NotificationsResponse,
  type TelegramEvent,
} from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';
import { clipKeepingEnd } from '../../common/text.js';
import type { NotificationRow } from '../../infra/db/schema/index.js';
import { EventsService } from '../events/events.service.js';
import { NotificationsRepository } from './notifications.repository.js';
import { type TelegramDispatch, TelegramService } from './telegram/telegram.service.js';

export interface PushInput {
  severity: NotificationSeverity;
  title: string;
  body?: string | null;
  link?: NotificationLink | null;
  /** Про какой сервер: в title/body пишем токен `{server}`, имя подставится при показе (переименование видно сразу). */
  server?: { id: string; name: string; host?: string | null } | null;
  /**
   * То же событие в Telegram (R6): тип для тумблера и инцидент, чтобы «Починилось» ушло ответом на
   * исходное сообщение. Уходит независимо от того, попадает ли уведомление в колокольчик.
   */
  telegram?: {
    event: TelegramEvent;
    incidentId?: string | null;
    /** Вид инцидента — для тумблеров «Какие инциденты». */
    kind?: IncidentKind | null;
    /** Сервер, по которому склеиваются сбои (id или имя ноды). */
    serverKey?: string | null;
    /** Показать в Telegram другой сервер, чем в колокольчике (например, ноду, которой нет в NodeService). */
    server?: { name: string; host?: string | null } | null;
    /** Готовый HTML для Telegram (биллинг) вместо обычного блочного формата. */
    html?: string | null;
    /**
     * Инцидент сейчас разберёт Джарвис: в Telegram отправляем после разбора — уже с выводом
     * (releaseAfterAnalysis). Не дождались за ANALYSIS_WAIT_MS — уходит как есть. Колокольчик — сразу.
     */
    awaitAnalysis?: boolean;
  } | null;
}

/** Сколько Telegram ждёт разбора Джарвиса: автоматический разбор стартует через минуту-две после открытия. */
export const ANALYSIS_WAIT_MS = process.env.NODE_ENV === 'test' ? 50 : 4 * 60_000;

/** Токен имени сервера в тексте уведомления. */
export const SERVER_TOKEN = '{server}';

/**
 * Центр уведомлений. `push()` вызывают сервисы панели (инциденты, обслуживание, фоновые задачи),
 * клиент дублирует свои всплывашки через POST. Ошибка записи уведомления не должна ронять
 * основную операцию — только в лог.
 */
/** Уровни, которые попадают в колокольчик; ok/info показываются всплывашкой и остаются в Журнале. */
const IMPORTANT = new Set<NotificationSeverity>(['warn', 'crit']);

@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);

  constructor(
    private readonly repo: NotificationsRepository,
    private readonly events: EventsService,
    private readonly telegram: TelegramService,
  ) {}

  toDto(row: NotificationRow & { serverNameNow?: string | null }): Notification {
    // Имя сервера — актуальное из справочника; удалён — то, что было при создании.
    const name = row.serverNameNow ?? row.serverName ?? 'сервер';
    const fill = (t: string | null): string | null => (t === null ? null : t.replaceAll(SERVER_TOKEN, name));
    return {
      id: row.id,
      severity: row.severity as NotificationSeverity,
      title: fill(row.title) ?? row.title,
      body: fill(row.body),
      link: row.linkTo && row.linkLabel ? { to: row.linkTo, label: row.linkLabel } : null,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
    };
  }

  async list(): Promise<NotificationsResponse> {
    const { items, unread, total } = await this.repo.list();
    return { items: items.map((r) => this.toDto(r)), unread, total };
  }

  /** Часовой пояс владельца для времени в сообщениях (из настроек уведомлений). */
  timeZone(): Promise<string> {
    return this.telegram.timeZone();
  }

  /** Серверное событие: тихо, без исключений наружу. */
  /** Сообщения в Telegram, которые ждут разбора Джарвиса: id инцидента → что отправить и запасной таймер. */
  private readonly deferred = new Map<string, { dispatch: TelegramDispatch; timer: NodeJS.Timeout }>();

  /**
   * Разбор готов (или не получился — verdict null): отправить отложенное сообщение, дописав вывод Джарвиса
   * первым блоком. Ничего не ждало — ничего не делаем (сообщение уже ушло).
   */
  releaseAfterAnalysis(incidentId: string, verdict: string | null, confidence: string | null = null): void {
    const d = this.deferred.get(incidentId);
    if (!d) return;
    clearTimeout(d.timer);
    this.deferred.delete(incidentId);
    const conf =
      confidence === 'high'
        ? 'уверенность высокая'
        : confidence === 'medium'
          ? 'уверенность средняя'
          : confidence === 'low'
            ? 'уверенность низкая'
            : null;
    const body = verdict
      ? `🤖 Разбор Джарвиса${conf ? ` (${conf})` : ''}: ${verdict}\n\n${d.dispatch.body ?? ''}`.trim()
      : (d.dispatch.body ?? null);
    void this.telegram.dispatch({ ...d.dispatch, body });
  }

  async push(input: PushInput): Promise<void> {
    if (input.telegram) {
      const name = input.server?.name ?? 'сервер';
      const fill = (t: string) => t.replaceAll(SERVER_TOKEN, name);
      const incidentId = input.telegram.incidentId ?? null;
      if (input.telegram.awaitAnalysis && incidentId && !input.telegram.html) {
        const dispatch: TelegramDispatch = {
          event: input.telegram.event,
          incidentId,
          kind: input.telegram.kind ?? null,
          serverKey: input.telegram.serverKey ?? input.server?.id ?? null,
          title: fill(input.title),
          body: input.body ? fill(input.body) : null,
          server:
            input.telegram.server ??
            (input.server ? { name: input.server.name, host: input.server.host ?? null } : null),
          link: input.link ?? null,
          html: null,
        };
        const prev = this.deferred.get(incidentId);
        if (prev) clearTimeout(prev.timer);
        const timer = setTimeout(() => this.releaseAfterAnalysis(incidentId, null), ANALYSIS_WAIT_MS);
        timer.unref?.();
        this.deferred.set(incidentId, { dispatch, timer });
      }
      // В фоне: медленный Telegram не должен задерживать инцидент или обслуживание.
      else
        void this.telegram.dispatch({
          event: input.telegram.event,
          incidentId: input.telegram.incidentId ?? null,
          kind: input.telegram.kind ?? null,
          serverKey: input.telegram.serverKey ?? input.server?.id ?? null,
          title: fill(input.title),
          body: input.body ? fill(input.body) : null,
          server:
            input.telegram.server ??
            (input.server ? { name: input.server.name, host: input.server.host ?? null } : null),
          link: input.link ?? null,
          html: input.telegram.html ?? null,
        });
    }
    // В колокольчик — только то, что требует внимания. Остальное есть в Журнале.
    if (!IMPORTANT.has(input.severity)) return;
    try {
      const row = await this.repo.insert({
        severity: input.severity,
        title: input.title.slice(0, 200),
        // Длинный текст дела режем в середине: вывод стоит в конце и должен остаться целым.
        body: input.body ? clipKeepingEnd(input.body, 1000) : null,
        linkTo: input.link?.to ?? null,
        linkLabel: input.link?.label ?? null,
        serverId: input.server?.id ?? null,
        serverName: input.server?.name ?? null,
      });
      this.events.emit({ type: 'notification', data: this.toDto(row) });
    } catch (err) {
      this.log.warn(`уведомление не записано: ${(err as Error).message}`);
    }
  }

  /** Всплывашка с клиента — валидируем и сохраняем. */
  async create(input: CreateNotificationRequest): Promise<Notification> {
    const req = createNotificationRequestSchema.parse(input);
    const row = await this.repo.insert({
      severity: req.severity,
      title: req.title,
      body: req.body || null,
      linkTo: req.link?.to ?? null,
      linkLabel: req.link?.label ?? null,
    });
    const dto = this.toDto(row);
    this.events.emit({ type: 'notification', data: dto });
    return dto;
  }

  async markAllRead(): Promise<{ unread: number }> {
    await this.repo.markAllRead();
    return { unread: 0 };
  }

  async delete(id: string): Promise<void> {
    if (!(await this.repo.delete(id)))
      throw problem(HttpStatus.NOT_FOUND, { detail: 'Уведомление уже удалено.' });
  }

  async clear(): Promise<void> {
    await this.repo.clear();
  }
}
