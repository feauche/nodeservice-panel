import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { localClock, localDateTime, localDay, zoneLabel } from '../../common/local-time.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { outageDuration } from '../notifications/telegram/telegram.format.js';

/** Поводы, по которым панель говорит о себе самой. */
export type PanelAlertReason = 'crash' | 'metrics' | 'disk' | 'connectivity';

/** О каждом поводе — не чаще раза в сутки. */
export const PANEL_ALERT_EVERY_MS = 24 * 60 * 60_000;

interface ReasonMark {
  /** Когда о поводе в последний раз сообщили. */
  sentAt: string;
  /** Сколько раз повод повторялся с тех пор, а сообщать было рано: называем в следующем сообщении. */
  skipped: number;
  /** Метрики: «не записываются» сказали, «снова записываются» — ещё нет. */
  open?: boolean;
  /** Метрики: с какого момента не записываются (для «не записывались 12 мин»). */
  since?: string | null;
  /** Для повода с восстановлением: о текущем сбое действительно успели сообщить. */
  notified?: boolean;
}
export type PanelAlertsState = Partial<Record<PanelAlertReason, ReasonMark>>;

const KEY = 'panel.alerts';

/** Отметки «когда сообщали» — в app_meta: перезапуск панели (в том числе после сбоя) их не теряет. */
@Injectable()
export class PanelAlertsStore {
  constructor(@Inject(DB) private readonly db: Db) {}

  async load(): Promise<PanelAlertsState> {
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, KEY) });
    if (!row) return {};
    try {
      const v = JSON.parse(row.value) as unknown;
      return v && typeof v === 'object' ? (v as PanelAlertsState) : {};
    } catch {
      return {};
    }
  }

  async save(state: PanelAlertsState): Promise<void> {
    const value = JSON.stringify(state);
    await this.db
      .insert(appMeta)
      .values({ key: KEY, value })
      .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: new Date() } });
  }
}

/** «1 раз», «2 раза», «5 раз». */
const timesWord = (n: number): string =>
  n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'раза' : 'раз';

/** «1,4 ГБ», «40 ГБ», «512 МБ». */
function size(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ГБ`;
  return `${Math.round(bytes / 1024 ** 2).toLocaleString('ru-RU')} МБ`;
}

/**
 * Панель говорит о себе самой — в колокольчик и в Telegram (событие «Сбои самой панели»): перезапустилась
 * после сбоя, метрики не записываются и снова записываются, мало места на сервере панели. О каждом поводе —
 * не чаще раза в сутки: повторы за это время не шлются, а называются числом в следующем сообщении. Если
 * панель не отвечает совсем, отсюда ничего не уйдёт — на этот случай есть сторож на сервере парка.
 */
@Injectable()
export class PanelAlertsService {
  private readonly log = new Logger(PanelAlertsService.name);
  /** Отметки правятся строго по очереди: повод метрик и повод диска могут прийти одновременно. */
  private turn: Promise<unknown> = Promise.resolve();
  /**
   * Отметки этого запуска. Прочитали из базы один раз — дальше держим здесь: если база перестала принимать
   * запись (кончается место), оповещение всё равно уйдёт, а повторы в те же сутки не пойдут.
   */
  private state: PanelAlertsState | null = null;

  constructor(
    private readonly store: PanelAlertsStore,
    private readonly notifications: NotificationsService,
  ) {}

  private withState<T>(fn: (st: PanelAlertsState) => T): Promise<T> {
    const run = async () => {
      if (!this.state)
        this.state = await this.store.load().catch((err) => {
          this.log.warn(`Отметки оповещений о панели не прочитаны: ${(err as Error).message}`);
          return {};
        });
      const out = fn(this.state);
      await this.store
        .save(this.state)
        .catch((err) => this.log.warn(`Отметки оповещений о панели не записаны: ${(err as Error).message}`));
      return out;
    };
    const next = this.turn.then(run, run);
    this.turn = next.catch(() => undefined);
    return next;
  }

  /**
   * Пора ли сообщать о поводе. Да — ставим отметку «сообщили» и возвращаем, сколько раз повод повторялся
   * молча; нет — прибавляем повтор. `open` — для метрик: отметить, что «снова записываются» ещё впереди.
   */
  private gate(
    reason: PanelAlertReason,
    now: Date,
    extra: Pick<ReasonMark, 'open' | 'since'> = {},
  ): Promise<{ send: boolean; skipped: number }> {
    return this.withState((st) => {
      const m = st[reason];
      if (m && now.getTime() - Date.parse(m.sentAt) < PANEL_ALERT_EVERY_MS) {
        m.skipped += 1;
        return { send: false, skipped: m.skipped };
      }
      st[reason] = { ...m, ...extra, sentAt: now.toISOString(), skipped: 0 };
      return { send: true, skipped: m?.skipped ?? 0 };
    });
  }

  /** Время в поясе панели: «03:12», в другой день — «29 сентября, 23:50». */
  private async clock(): Promise<{ at: (d: Date, now: Date) => string; zone: (now: Date) => string }> {
    const tz = await this.notifications.timeZone().catch(() => 'Europe/Moscow');
    return {
      at: (d, now) => (localDay(d, tz) === localDay(now, tz) ? localClock(d, tz) : localDateTime(d, tz, now)),
      zone: (now) => zoneLabel(now, tz),
    };
  }

  /**
   * Панель поднялась, а штатной остановки перед этим не было: упала, её убили за нехватку памяти или сервер
   * выключился. `lastAliveAt` — последняя отметка живости (ставится раз в минуту).
   */
  async crashed(lastAliveAt: Date, upAt = new Date()): Promise<void> {
    const g = await this.gate('crash', upAt);
    if (!g.send) return;
    const c = await this.clock();
    await this.notifications.push({
      severity: 'warn',
      title: 'Панель перезапустилась после сбоя',
      body: `Остановилась около ${c.at(lastAliveAt, upAt)} (последний признак жизни), снова работает с ${c.at(upAt, upAt)} (${c.zone(upAt)}). Штатной остановки перед этим не было — так бывает, когда панель падает с ошибкой, ей не хватает памяти или сервер панели выключается внезапно. Пока панель не работала, она не следила за серверами и не присылала тревог.${
        g.skipped > 0 ? ` С прошлого сообщения это случалось ещё ${g.skipped} ${timesWord(g.skipped)}.` : ''
      }`,
      link: { to: '/incidents', label: 'Открыть инциденты' },
      telegram: { event: 'panel_health' },
    });
  }

  /** Запись метрик не удаётся дольше порога подряд (с `since`). */
  async metricsDown(since: Date, now = new Date()): Promise<void> {
    const g = await this.gate('metrics', now, { open: true, since: since.toISOString() });
    if (!g.send) return;
    const c = await this.clock();
    await this.notifications.push({
      severity: 'warn',
      title: 'Метрики не записываются',
      body: `С ${c.at(since, now)} (${c.zone(now)}) панель не может записать метрики серверов в хранилище метрик. Пока это так, графики не пополняются, а панель не видит нагрузку на процессор, память и диск серверов и не заведёт по ним инцидент. Обычно дело в том, что хранилище метрик на сервере панели остановилось или на сервере кончилось место.${
        g.skipped > 0
          ? ` С прошлого сообщения запись метрик прерывалась ещё ${g.skipped} ${timesWord(g.skipped)}.`
          : ''
      }`,
      telegram: { event: 'panel_health' },
    });
  }

  /**
   * Метрики снова записываются. Сообщаем, только если о сбое говорили (и ещё не сказали, что прошло), — в том
   * числе до перезапуска панели: отметка в базе.
   */
  async metricsUp(now = new Date()): Promise<void> {
    const since = await this.withState((st) => {
      const m = st.metrics;
      if (!m?.open) return null;
      const from = m.since ? Date.parse(m.since) : Date.parse(m.sentAt);
      m.open = false;
      m.since = null;
      return from;
    });
    if (since === null) return;
    await this.notifications.push({
      severity: 'ok',
      title: 'Метрики снова записываются',
      body: `Не записывались ${outageDuration(now.getTime() - since)}: на графиках за это время будет пробел.`,
      telegram: { event: 'panel_health' },
    });
  }

  /**
   * Панель не смогла зайти ни на один сервер, с которого должна была перепроверить доступность парка.
   * Это один сбой наблюдения самой панели, поэтому не превращаем его в критичный инцидент каждого сервера.
   */
  async connectivityDown(servers: number, now = new Date()): Promise<void> {
    const state = await this.withState((st) => {
      const mark = st.connectivity;
      if (mark?.open) return { send: false, skipped: mark.skipped };
      const send = !mark || now.getTime() - Date.parse(mark.sentAt) >= PANEL_ALERT_EVERY_MS;
      st.connectivity = {
        sentAt: send ? now.toISOString() : mark.sentAt,
        skipped: send ? 0 : mark.skipped + 1,
        open: true,
        since: now.toISOString(),
        notified: send,
      };
      return { send, skipped: mark?.skipped ?? 0 };
    });
    if (!state.send) return;
    await this.notifications.push({
      severity: 'warn',
      title: 'Панель не может перепроверить связь с серверами',
      body: `Панель не смогла войти ни на один сервер парка, чтобы независимо проверить ${servers} ${servers === 1 ? 'сервер' : 'серверов'}, с которыми пропала связь. Пока обзор сети не восстановится, панель не будет объявлять эти серверы выключенными: причина может быть в сети самой панели. Уже открытые дела сохранены без ложного закрытия.`,
      link: { to: '/servers', label: 'Открыть серверы' },
      telegram: { event: 'panel_health' },
    });
  }

  /** Обзор сети восстановился после системного предупреждения. */
  async connectivityUp(now = new Date()): Promise<void> {
    const outage = await this.withState((st) => {
      const mark = st.connectivity;
      if (!mark?.open) return null;
      const since = mark.since ? Date.parse(mark.since) : Date.parse(mark.sentAt);
      const notified = mark.notified === true;
      mark.open = false;
      mark.since = null;
      mark.notified = false;
      return notified ? since : null;
    });
    if (outage === null) return;
    await this.notifications.push({
      severity: 'ok',
      title: 'Панель снова видит сеть серверов',
      body: `Независимая проверка доступности снова работает после ${outageDuration(now.getTime() - outage)}. Следующий проход уточнит состояние каждого сервера по отдельности.`,
      center: true,
      link: { to: '/servers', label: 'Открыть серверы' },
      telegram: { event: 'panel_health' },
    });
  }

  /** На разделе данных сервера панели мало места: сколько свободно и что обычно его занимает. */
  async diskLow(disk: { freeBytes: number; totalBytes: number }, now = new Date()): Promise<void> {
    const g = await this.gate('disk', now);
    if (!g.send) return;
    const pct = disk.totalBytes > 0 ? Math.floor((disk.freeBytes / disk.totalBytes) * 100) : 0;
    await this.notifications.push({
      severity: 'warn',
      title: 'Мало места на сервере панели',
      body: `Свободно ${size(disk.freeBytes)} из ${size(disk.totalBytes)} (${pct} %). Когда место кончится, панель перестанет сохранять данные и присылать тревоги. Обычно место занимают резервные копии панели, старые образы Docker и системный журнал сервера. Пока места мало, напомним раз в сутки.`,
      link: { to: '/settings/backups', label: 'Открыть копии' },
      telegram: { event: 'panel_health' },
    });
  }

  /** Для фоновых вызовов: оповещение не должно ронять то, что его вызвало. */
  quietly(what: string, run: () => Promise<void>): void {
    void run().catch((err) =>
      this.log.warn(`Оповещение о панели (${what}) не отправлено: ${(err as Error).message}`),
    );
  }
}
