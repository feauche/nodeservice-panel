import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  type CreateNotificationRequest,
  createNotificationRequestSchema,
  type Notification,
  type NotificationLink,
  type NotificationSeverity,
  type NotificationsResponse,
  type TelegramEvent,
} from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';
import type { NotificationRow } from '../../infra/db/schema/index.js';
import { EventsService } from '../events/events.service.js';
import { NotificationsRepository } from './notifications.repository.js';
import { TelegramService } from './telegram/telegram.service.js';

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
  telegram?: { event: TelegramEvent; incidentId?: string | null } | null;
}

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

  /** Серверное событие: тихо, без исключений наружу. */
  async push(input: PushInput): Promise<void> {
    if (input.telegram) {
      const name = input.server?.name ?? 'сервер';
      const fill = (t: string) => t.replaceAll(SERVER_TOKEN, name);
      // В фоне: медленный Telegram не должен задерживать инцидент или обслуживание.
      void this.telegram.dispatch({
        event: input.telegram.event,
        incidentId: input.telegram.incidentId ?? null,
        title: fill(input.title),
        body: input.body ? fill(input.body) : null,
        server: input.server ? { name: input.server.name, host: input.server.host ?? null } : null,
        link: input.link ?? null,
      });
    }
    // В колокольчик — только то, что требует внимания. Остальное есть в Журнале.
    if (!IMPORTANT.has(input.severity)) return;
    try {
      const row = await this.repo.insert({
        severity: input.severity,
        title: input.title.slice(0, 200),
        body: input.body ? input.body.slice(0, 1000) : null,
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
