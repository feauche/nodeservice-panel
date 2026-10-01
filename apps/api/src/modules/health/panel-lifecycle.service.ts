import { type BeforeApplicationShutdown, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { SHARED_VERSION } from '@nodeservice/shared';
import type { Redis } from 'ioredis';

import type { Env } from '../../config/env.schema.js';
import { VALKEY } from '../../infra/valkey/valkey.module.js';
import { SYSTEM_ACTOR } from '../audit/audit.context.js';
import { AuditService } from '../audit/audit.service.js';
import { PanelAlertsService } from './panel-alerts.service.js';

/**
 * Отметки жизни панели — в Valkey, а не в базе: базу восстанавливают из копии, и вместе с ней вернулась бы
 * отметка из прошлого — без штатной остановки (копию делают, пока панель работает), то есть ложный «сбой».
 * Консольное восстановление Valkey очищает — отметок нет, и это считается первым запуском.
 */
export const PANEL_LIFE_KEY = 'panel:lifecycle';

interface LifeMark {
  /** Когда начался этот запуск. */
  startedAt: string;
  /** Последняя отметка живости: ставится раз в минуту. */
  aliveAt: string;
  /** Штатная остановка; null — панель работает или остановилась не штатно. */
  stoppedAt: string | null;
}

/**
 * Жизнь самой панели. Запуск — запись «Сервис запущен» в Журнал и проверка, как панель остановилась в прошлый
 * раз: штатная остановка (обновление, перезапуск контейнера, восстановление из копии) ставит отметку; нет её —
 * панель упала, её убили за нехватку памяти или сервер выключился, и владелец узнаёт об этом
 * (PanelAlertsService.crashed). Раз в минуту — отметка живости: по ней видно, когда панель остановилась.
 */
@Injectable()
export class PanelLifecycleService implements BeforeApplicationShutdown {
  private readonly log = new Logger(PanelLifecycleService.name);
  /** Отметка этого запуска; null — запуск ещё не отмечен (или панель уже остановилась). */
  private mark: LifeMark | null = null;
  /** Об ошибке отметки пишем в лог один раз на полосу неудач, а не каждую минуту. */
  private failing = false;

  constructor(
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
    @Inject(VALKEY) private readonly valkey: Redis,
    private readonly alerts: PanelAlertsService,
  ) {}

  /**
   * Панель запустилась (main.ts, после listen): запись «Сервис запущен» в Журнал. Версия — сама версия
   * панели: образ запускает `node dist/main` без npm, переменной npm_package_version в нём нет, и в Журнале
   * всегда стояло 0.1.0. Прошлый запуск без отметки штатной остановки — оповещение о сбое. Не смогли
   * прочитать отметку — о сбое ничего не утверждаем.
   */
  async started(now = new Date()): Promise<void> {
    let prev: LifeMark | null = null;
    try {
      const raw = await this.valkey.get(PANEL_LIFE_KEY);
      prev = raw ? (JSON.parse(raw) as LifeMark) : null;
    } catch (err) {
      this.log.warn(`Отметка прошлого запуска не прочитана: ${(err as Error).message}`);
    }
    this.mark = { startedAt: now.toISOString(), aliveAt: now.toISOString(), stoppedAt: null };
    await this.save();
    await this.audit.record({
      action: 'system.started',
      actor: SYSTEM_ACTOR,
      source: 'auto',
      metadata: { version: SHARED_VERSION, node: process.version, env: this.config.get('NODE_ENV') },
    });
    if (prev && !prev.stoppedAt && prev.aliveAt)
      await this.alerts
        .crashed(new Date(prev.aliveAt), now)
        .catch((err) => this.log.warn(`Оповещение о сбое панели не отправлено: ${(err as Error).message}`));
  }

  /** Раз в минуту: панель жива. До запуска и после штатной остановки не трогаем. */
  @Interval(60_000)
  async heartbeat(now = new Date()): Promise<void> {
    if (!this.mark) return;
    this.mark = { ...this.mark, aliveAt: now.toISOString() };
    await this.save();
  }

  /** Nest останавливает панель (сигнал от Docker): штатная остановка. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.markStopped();
  }

  /**
   * Отметка штатной остановки. Кроме остановки через Nest её ставит восстановление из копии: после него
   * панель выходит сама (process.exit), минуя обработчики остановки.
   */
  async markStopped(now = new Date()): Promise<void> {
    if (!this.mark) return;
    const mark = { ...this.mark, aliveAt: now.toISOString(), stoppedAt: now.toISOString() };
    this.mark = mark;
    await this.save();
    this.mark = null;
  }

  private async save(): Promise<void> {
    if (!this.mark) return;
    try {
      await this.valkey.set(PANEL_LIFE_KEY, JSON.stringify(this.mark));
      this.failing = false;
    } catch (err) {
      if (!this.failing) this.log.warn(`Отметка жизни панели не записана: ${(err as Error).message}`);
      this.failing = true;
    }
  }
}
