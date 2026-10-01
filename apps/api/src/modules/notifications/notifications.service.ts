import {
  type BeforeApplicationShutdown,
  HttpStatus,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
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
import { NotificationsRepository, type PendingTelegram } from './notifications.repository.js';
import { shortOutageMessage } from './telegram/telegram.format.js';
import type { RichBlock } from './telegram/telegram.rich.js';
import { type TelegramDispatch, TelegramService } from './telegram/telegram.service.js';

/**
 * Чем закрылось дело — для сообщения о коротком сбое, если тревога о нём ещё ждала разбора. `recovered` —
 * сбой прошёл (иначе дело закрыто по другой причине, и «в норме» панель не утверждает), `how` — чем
 * закончилось. `merged` — дело влилось в другое: о сбое расскажет оно, тревогу снимаем молча.
 */
export type IncidentClosed = { recovered: boolean; how?: string | null } | 'merged';

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
    /** Готовый HTML для Telegram (например, биллинг) — запасной формат для обычного сообщения. */
    html?: string | null;
    /** Те же данные настоящими блоками Telegram: заголовки, таблицы и подпись. */
    rich?: RichBlock[] | null;
    /**
     * Инцидент сейчас разберёт Джарвис: в Telegram отправляем после разбора — уже с выводом
     * (releaseAfterAnalysis). Не дождались за ANALYSIS_WAIT_MS — уходит как есть. Колокольчик — сразу.
     */
    awaitAnalysis?: boolean;
    /**
     * Важность самого дела для Telegram, если она не та, что у записи в колокольчике (шаг «только вручную»
     * по некритичному делу в колокольчике критичен, а будить из-за него ночью незачем).
     */
    severity?: NotificationSeverity | null;
    /** Событие `resolved`: чем закрылось дело (см. IncidentClosed). */
    closed?: IncidentClosed | null;
  } | null;
}

/** Сколько Telegram ждёт разбора Джарвиса: автоматический разбор стартует через минуту-две после открытия. */
export const ANALYSIS_WAIT_MS = process.env.NODE_ENV === 'test' ? 50 : 4 * 60_000;
/**
 * Дело закрыто, а тревога о нём ещё ждёт отправки. Закрыто только что — сообщение о закрытии уже в пути,
 * оно и скажет о коротком сбое; позже этого срока — закрыли без сообщения, тревога просто не нужна.
 */
const CLOSING_GRACE_MS = 30_000;
/** Сколько при остановке панели ждём отправок, которые уже решено сделать (контейнеру на остановку даётся 10 с). */
const SHUTDOWN_WAIT_MS = 5_000;

const CONFIDENCE: Record<string, string> = {
  high: 'уверенность высокая',
  medium: 'уверенность средняя',
  low: 'уверенность низкая',
};

/** Вывод Джарвиса — первым блоком сообщения; вывода нет — сообщение как есть. */
function withVerdict(
  m: TelegramDispatch,
  verdict: string | null,
  confidence: string | null,
): TelegramDispatch {
  if (!verdict) return m;
  const conf = confidence ? CONFIDENCE[confidence] : undefined;
  return {
    ...m,
    body: `🤖 Разбор Джарвиса${conf ? ` (${conf})` : ''}: ${verdict}\n\n${m.body ?? ''}`.trim(),
  };
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
export class NotificationsService implements OnModuleDestroy, BeforeApplicationShutdown {
  private readonly log = new Logger(NotificationsService.name);

  constructor(
    private readonly repo: NotificationsRepository,
    private readonly events: EventsService,
    private readonly telegram: TelegramService,
  ) {
    // Telegram сам в колокольчик не пишет (центр уведомлений зависит от него, а не наоборот) — о том, что
    // сообщения не доходят, он говорит через нас.
    this.telegram.bell = (n) =>
      this.push({
        severity: 'warn',
        title: n.title,
        body: n.body,
        link: { to: '/settings/notifications', label: 'Открыть уведомления' },
      });
  }

  onModuleDestroy(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /**
   * Панель останавливают. С того, что уже решено отправить, признак «ждёт отправки» снят — даём этим
   * сообщениям уйти, иначе они пропали бы. Долго не ждём: Telegram может и не отвечать.
   */
  async beforeApplicationShutdown(): Promise<void> {
    await Promise.race([
      this.settle(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, SHUTDOWN_WAIT_MS).unref?.();
      }),
    ]);
  }

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

  /**
   * Сколько ждать разбора. Свойством, а не константой: сквозные тесты растягивают ожидание, чтобы дело
   * успело закрыться раньше, чем оно истечёт.
   */
  analysisWaitMs = ANALYSIS_WAIT_MS;
  /**
   * Сообщения в Telegram, которые ждут разбора Джарвиса, лежат в базе (перезапуск панели их не теряет).
   * Здесь — только будильники на точный срок ожидания; после перезапуска их заменяет минутная задача.
   */
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Решения по одному делу (отложить, поставить в очередь, выпустить, снять) — строго по одному. */
  private readonly turns = new Map<string, Promise<unknown>>();
  /** Отправки по одному делу — строго по порядку: «Починилось» не должно обогнать тревогу, на которую отвечает. */
  private readonly sends = new Map<string, Promise<void>>();

  private turn<T>(incidentId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.turns.get(incidentId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    const tail = next.catch(() => undefined);
    this.turns.set(incidentId, tail);
    void tail.then(() => {
      if (this.turns.get(incidentId) === tail) this.turns.delete(incidentId);
    });
    return next;
  }

  /** В фоне, но по очереди дела: медленный Telegram не задерживает инцидент, а порядок сообщений сохраняется. */
  private send(incidentId: string, m: TelegramDispatch): void {
    const prev = this.sends.get(incidentId) ?? Promise.resolve();
    const next = prev.then(() => this.telegram.dispatch(m)).catch(() => undefined);
    this.sends.set(incidentId, next);
    void next.then(() => {
      if (this.sends.get(incidentId) === next) this.sends.delete(incidentId);
    });
  }

  /** Дождаться всех решений и отправок по делам — для тестов и остановки панели. */
  async settle(): Promise<void> {
    while (this.turns.size > 0 || this.sends.size > 0)
      await Promise.allSettled([...this.turns.values(), ...this.sends.values()]);
  }

  private arm(incidentId: string): void {
    this.disarm(incidentId);
    const timer = setTimeout(() => {
      this.timers.delete(incidentId);
      void this.turn(incidentId, () => this.flushOne(incidentId, { expired: true })).catch((err) =>
        this.log.warn(`Telegram: отложенное сообщение по делу ${incidentId}: ${(err as Error).message}`),
      );
    }, this.analysisWaitMs);
    timer.unref?.();
    this.timers.set(incidentId, timer);
  }

  private disarm(incidentId: string): void {
    const timer = this.timers.get(incidentId);
    if (timer) clearTimeout(timer);
    this.timers.delete(incidentId);
  }

  /**
   * Выпустить отложенное по делу, если пора. `given` — разбор только что закончился (вывод или null — не
   * получился), `expired` — время ожидания вышло. Без них (минутная задача, старт панели) смотрим на само
   * дело: разбор готов, прерван или ждали дольше положенного. Состояние дела перечитываем всегда: тревога
   * по закрытому делу уйти не должна.
   */
  private async flushOne(
    incidentId: string,
    opts: { given?: { verdict: string | null; confidence: string | null }; expired?: boolean } = {},
  ): Promise<void> {
    const held = await this.repo.peekTelegram(incidentId);
    if (!held) return;
    const state = await this.repo.incidentState(incidentId);
    if (state?.status === 'resolved') {
      // Закрыто только что — сообщение о закрытии уже в пути: оставляем отложенное ему (см. CLOSING_GRACE_MS).
      if (state.resolvedAt && Date.now() - state.resolvedAt.getTime() < CLOSING_GRACE_MS) return;
    } else if (state && !opts.given && !opts.expired) {
      const waiting = !state.analysis || state.analysis.status === 'running';
      if (waiting && Date.now() - held.createdAt.getTime() < this.analysisWaitMs) return;
    }
    const taken = await this.repo.takeTelegram(incidentId);
    this.disarm(incidentId);
    // Дела уже нет или оно закрыто — тревога опоздала, вместе с ней не нужны и события, стоявшие за ней.
    if (!taken || !state || state.status === 'resolved') return;
    const done = state.analysis?.status === 'done' ? state.analysis : null;
    const verdict = opts.given ? opts.given.verdict : (done?.verdict ?? null);
    const confidence = opts.given ? opts.given.confidence : (done?.confidence ?? null);
    this.send(incidentId, withVerdict(taken.alert, verdict, confidence));
    for (const m of taken.queued) this.send(incidentId, m);
  }

  /**
   * Разбор готов (или не получился — verdict null): отправить отложенное сообщение, дописав вывод Джарвиса
   * первым блоком, а за ним — события того же дела, которые его ждали. Ничего не ждало — ничего не делаем
   * (сообщение уже ушло или дело закрылось раньше).
   */
  async releaseAfterAnalysis(
    incidentId: string,
    verdict: string | null,
    confidence: string | null = null,
  ): Promise<void> {
    await this.turn(incidentId, () => this.flushOne(incidentId, { given: { verdict, confidence } })).catch(
      (err) =>
        this.log.warn(`Telegram: сообщение по делу ${incidentId} после разбора: ${(err as Error).message}`),
    );
  }

  /** Дело закрыли без сообщения (вручную в панели): тревога, которая ждала разбора, больше не нужна. */
  async dropDeferred(incidentId: string): Promise<void> {
    await this.turn(incidentId, async () => {
      await this.repo.takeTelegram(incidentId);
      this.disarm(incidentId);
    }).catch((err) =>
      this.log.warn(
        `Telegram: отложенное сообщение по делу ${incidentId} не снято: ${(err as Error).message}`,
      ),
    );
  }

  /**
   * Минутная задача и старт панели: отправить всё отложенное, чему пора. После перезапуска будильников в
   * памяти нет — сообщение уходит отсюда, когда разбор закончился, прерван или время ожидания истекло.
   */
  async flushDeferred(): Promise<void> {
    for (const row of await this.repo.pendingTelegram())
      await this.turn(row.incidentId, () => this.flushOne(row.incidentId)).catch((err) =>
        this.log.warn(`Telegram: отложенное сообщение по делу ${row.incidentId}: ${(err as Error).message}`),
      );
  }

  /**
   * Дело закрылось раньше, чем о нём сообщили: вместо пары «тревога → починилось» — одно тихое сообщение.
   * Название и сервер берём из несостоявшейся тревоги, длительность — от открытия дела.
   */
  private async shortOutage(
    held: PendingTelegram,
    m: TelegramDispatch,
    closed: Exclude<IncidentClosed, 'merged'> | null,
  ): Promise<TelegramDispatch> {
    const state = await this.repo.incidentState(held.incidentId).catch(() => null);
    const suffix = held.alert.server ? ` · ${held.alert.server.name}` : null;
    const what =
      suffix && held.alert.title.endsWith(suffix)
        ? held.alert.title.slice(0, -suffix.length)
        : held.alert.title;
    return {
      ...m,
      ...shortOutageMessage({
        what,
        lastedMs: Date.now() - (state?.openedAt ?? held.createdAt).getTime(),
        recovered: closed?.recovered ?? false,
        how: (closed ? closed.how : m.body) ?? null,
      }),
      server: held.alert.server ?? m.server ?? null,
      silent: true,
      // Вместо тревоги: проходит и по её тумблеру, даже если «Починилось» выключено.
      replaces: held.alert.event,
    };
  }

  /**
   * Сообщение по делу: отложить до разбора, поставить за отложенной тревогой или отправить. Пока тревога
   * ждёт разбора, остальные события дела её не обгоняют; дело закрылось — тревога отменяется.
   */
  private route(
    incidentId: string,
    m: TelegramDispatch,
    t: NonNullable<PushInput['telegram']>,
  ): Promise<void> {
    return this.turn(incidentId, async () => {
      if (t.awaitAnalysis) {
        try {
          await this.repo.deferTelegram(incidentId, m);
          this.arm(incidentId);
          return;
        } catch (err) {
          // Отложить не вышло (дела нет в базе) — потерять тревогу хуже, чем не дождаться разбора.
          this.log.warn(`Telegram: сообщение по делу ${incidentId} не отложено: ${(err as Error).message}`);
        }
      } else if (m.event === 'resolved') {
        const held = await this.repo.takeTelegram(incidentId).catch(() => null);
        if (held) {
          this.disarm(incidentId);
          // Дело влилось в другое — о сбое расскажет главное дело, отдельной вести не нужно.
          if (t.closed === 'merged') return;
          // О деле ещё ничего не присылали — говорим о коротком сбое. Уже писали (ждало только уточнение) —
          // обычное «Починилось» ответом на прежнее сообщение.
          if ((await this.telegram.lastMessageAt(incidentId).catch(() => null)) === null) {
            this.send(incidentId, await this.shortOutage(held, m, t.closed ?? null));
            return;
          }
        }
      } else if (await this.repo.queueTelegram(incidentId, m).catch(() => false)) return;
      this.send(incidentId, m);
    });
  }

  /** Серверное событие: тихо, без исключений наружу. */
  async push(input: PushInput): Promise<void> {
    if (input.telegram) {
      const t = input.telegram;
      const name = input.server?.name ?? 'сервер';
      const fill = (text: string) => text.replaceAll(SERVER_TOKEN, name);
      const incidentId = t.incidentId ?? null;
      const m: TelegramDispatch = {
        event: t.event,
        incidentId,
        kind: t.kind ?? null,
        serverKey: t.serverKey ?? input.server?.id ?? null,
        title: fill(input.title),
        body: input.body ? fill(input.body) : null,
        server:
          t.server ?? (input.server ? { name: input.server.name, host: input.server.host ?? null } : null),
        link: input.link ?? null,
        html: t.html ?? null,
        rich: t.rich ?? null,
        severity: t.severity ?? input.severity,
      };
      // Сообщения по делу идут по очереди дела (см. route): ждём только решения, сама отправка — в фоне.
      if (incidentId && !t.html)
        await this.route(incidentId, m, t).catch((err) =>
          this.log.warn(`Telegram: сообщение по делу ${incidentId}: ${(err as Error).message}`),
        );
      // В фоне: медленный Telegram не должен задерживать инцидент или обслуживание.
      else void this.telegram.dispatch(m);
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
