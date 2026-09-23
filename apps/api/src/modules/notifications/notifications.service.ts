import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  type CreateNotificationRequest,
  createNotificationRequestSchema,
  type Notification,
  type NotificationLink,
  type NotificationSeverity,
  type NotificationsResponse,
} from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';
import type { NotificationRow } from '../../infra/db/schema/index.js';
import { NotificationsEvents } from './notifications.events.js';
import { NotificationsRepository } from './notifications.repository.js';

export interface PushInput {
  severity: NotificationSeverity;
  title: string;
  body?: string | null;
  link?: NotificationLink | null;
}

/**
 * Центр уведомлений. `push()` вызывают сервисы панели (инциденты, обслуживание, фоновые задачи),
 * клиент дублирует свои всплывашки через POST. Ошибка записи уведомления не должна ронять
 * основную операцию — только в лог.
 */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);

  constructor(
    private readonly repo: NotificationsRepository,
    private readonly events: NotificationsEvents,
  ) {}

  toDto(row: NotificationRow): Notification {
    return {
      id: row.id,
      severity: row.severity as NotificationSeverity,
      title: row.title,
      body: row.body,
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
    try {
      const row = await this.repo.insert({
        severity: input.severity,
        title: input.title.slice(0, 200),
        body: input.body ? input.body.slice(0, 1000) : null,
        linkTo: input.link?.to ?? null,
        linkLabel: input.link?.label ?? null,
      });
      this.events.emit(this.toDto(row));
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
    this.events.emit(dto);
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
