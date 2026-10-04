import { createHash } from 'node:crypto';
import { type HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WATCHDOG_PROBLEM, type WatchdogStatus, type WatchdogTestResponse } from '@nodeservice/shared';
import { eq } from 'drizzle-orm';

import { problem } from '../../common/filters/problem-details.filter.js';
import type { Env } from '../../config/env.schema.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';
import { AuditService } from '../audit/audit.service.js';
import { TelegramService } from '../notifications/telegram/telegram.service.js';
import { ServersRepository } from '../servers/servers.repository.js';
import { ServersService } from '../servers/servers.service.js';
import { SshService, type SshTarget } from '../servers/ssh.service.js';
import {
  parseWatchdogOutput,
  WATCHDOG_INSTALL_COMMAND,
  WATCHDOG_INSTALL_LABEL,
  WATCHDOG_REMOVE_COMMAND,
  WATCHDOG_SCRIPT_REVISION,
  WATCHDOG_TEST_COMMAND,
  WATCHDOG_WAIT_MS,
  type WatchdogParams,
  watchdogEnvFile,
} from './watchdog.script.js';

/** Где стоит сторож — отдельным ключом app_meta (без миграции). */
const KEY = 'watchdog';

interface StoredWatchdog {
  serverId: string;
  /** Имя сервера на момент установки: если сервер удалят из панели, показываем его. */
  serverName: string;
  installedAt: string;
  /** Отпечаток того, с чем сторож поставлен (адрес, пояс, чаты, прокси): разошёлся с текущим — «поставьте заново». */
  fingerprint: string;
}

/** Адрес, до которого с другого сервера не достучаться: сторож считал бы панель лежащей всегда. */
function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '::1' ||
      host === '0.0.0.0' ||
      /^127\./.test(host)
    );
  } catch {
    return true;
  }
}

const fingerprint = (p: WatchdogParams): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        revision: WATCHDOG_SCRIPT_REVISION,
        url: p.url,
        tz: p.timeZone,
        chats: p.chats,
        proxy: p.proxy,
      }),
    )
    .digest('hex')
    .slice(0, 32);

/**
 * Сторож панели на сервере парка (вариант без внешних сервисов): панель по SSH ставит на выбранный сервер
 * скрипт и таймер systemd; дальше сторож живёт сам и пишет в Telegram напрямую. Панель помнит только, где и
 * когда его поставила, и с какими чатами, — чтобы подсказать «поставьте заново», когда они поменялись.
 */
@Injectable()
export class WatchdogService {
  private readonly log = new Logger(WatchdogService.name);
  /** Публичный адрес панели. Свойством: сквозные тесты подставляют внешний (у них PUBLIC_URL — localhost). */
  panelUrl: string;
  /** Одно действие со сторожем за раз: две установки подряд разошлись бы с тем, что записано в панели. */
  private busy = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    config: ConfigService<Env, true>,
    private readonly servers: ServersService,
    private readonly serversRepo: ServersRepository,
    private readonly ssh: SshService,
    private readonly telegram: TelegramService,
    private readonly audit: AuditService,
  ) {
    this.panelUrl = config.get('PUBLIC_URL');
  }

  private async load(): Promise<StoredWatchdog | null> {
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, KEY) });
    if (!row) return null;
    try {
      const v = JSON.parse(row.value) as Partial<StoredWatchdog>;
      return v.serverId && v.installedAt ? (v as StoredWatchdog) : null;
    } catch {
      return null;
    }
  }

  private async save(v: StoredWatchdog | null): Promise<void> {
    if (!v) {
      await this.db.delete(appMeta).where(eq(appMeta.key, KEY));
      return;
    }
    const value = JSON.stringify(v);
    await this.db
      .insert(appMeta)
      .values({ key: KEY, value })
      .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: new Date() } });
  }

  /** С чем сторож встанет сейчас: адрес готовности, пояс и чаты из «Уведомлений». */
  private async params(serverName: string): Promise<WatchdogParams> {
    const chats = await this.telegram.destinations();
    return {
      url: new URL('/api/health/ready', this.panelUrl).toString(),
      serverName,
      timeZone: await this.telegram.timeZone(),
      chats: chats.map((d) => ({ token: d.token, chatId: d.chatId, topic: d.topic })),
      proxy: chats[0]?.proxy ?? null,
    };
  }

  /** Почему поставить сторожа нельзя; null — можно. */
  private async blocker(): Promise<string | null> {
    if (isLocalUrl(this.panelUrl))
      return 'Панель открыта по локальному адресу — сторожу с другого сервера до неё не достучаться. Сторож работает, когда у панели есть свой домен.';
    if ((await this.telegram.destinations()).length === 0)
      return 'Сначала добавьте чат Telegram выше и сохраните: сторожу некуда будет писать.';
    return null;
  }

  async status(): Promise<WatchdogStatus> {
    const [stored, blocker] = await Promise.all([this.load(), this.blocker()]);
    if (!stored) return { installed: null, blocker };
    const row = await this.serversRepo.findById(stored.serverId);
    const now = fingerprint(await this.params(stored.serverName));
    return {
      installed: {
        serverId: stored.serverId,
        serverName: row?.name ?? stored.serverName,
        installedAt: stored.installedAt,
        serverGone: !row,
        outdated: now !== stored.fingerprint,
      },
      blocker,
    };
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy)
      throw problem(HttpStatus.CONFLICT, { detail: 'Со сторожем уже идёт действие — дождитесь окончания.' });
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }

  private async run(
    target: SshTarget,
    command: string,
    opts: { input?: string; timeoutMs?: number; label?: string } = {},
  ) {
    const session = await this.ssh.connect(target);
    try {
      return await session.exec(command, opts);
    } finally {
      session.end();
    }
  }

  /**
   * Команда на сервере не удалась. Своя причина по-русски (строка @@error) — владельцу и в Журнал; вывод
   * программ на сервере (часто английский) — только в лог.
   */
  private failed(
    what: string,
    reason: string | undefined,
    out: { code: number; stdout: string; stderr: string },
  ): HttpException {
    if (!reason) this.log.warn(`${what}: код ${out.code}: ${(out.stderr || out.stdout).trim().slice(-300)}`);
    const detail = reason || `${what}: команда на сервере завершилась с ошибкой (код ${out.code}).`;
    this.audit.extend({ metadata: { reason: detail } });
    return problem(HttpStatus.BAD_GATEWAY, { type: WATCHDOG_PROBLEM.failed, detail });
  }

  /** Поставить сторожа на сервер (или поставить заново там же — с текущими чатами). */
  install(serverId: string): Promise<WatchdogStatus> {
    return this.exclusive(async () => {
      const blocker = await this.blocker();
      if (blocker) throw problem(HttpStatus.CONFLICT, { type: WATCHDOG_PROBLEM.blocked, detail: blocker });
      const stored = await this.load();
      if (stored && stored.serverId !== serverId) {
        const other = await this.serversRepo.findById(stored.serverId);
        throw problem(HttpStatus.CONFLICT, {
          type: WATCHDOG_PROBLEM.blocked,
          detail: `Сторож уже стоит на сервере «${other?.name ?? stored.serverName}». Сначала уберите его там: сторож нужен один.`,
        });
      }
      const { target, name } = await this.servers.sshTargetFor(serverId);
      this.audit.extend({ target: { type: 'server', id: serverId, display: name } });
      const params = await this.params(name);
      const out = await this.run(target, WATCHDOG_INSTALL_COMMAND, {
        input: watchdogEnvFile(params),
        timeoutMs: WATCHDOG_WAIT_MS.install,
        label: WATCHDOG_INSTALL_LABEL,
      });
      const res = parseWatchdogOutput(out.stdout);
      if (res.installed !== '1') throw this.failed('Сторож не поставился', res.error, out);
      await this.save({
        serverId,
        serverName: name,
        installedAt: new Date().toISOString(),
        fingerprint: fingerprint(params),
      });
      // Токены в Журнал не пишем — только куда поставлен и сколько чатов знает.
      this.audit.extend({ metadata: { server: name, chats: params.chats.length, again: Boolean(stored) } });
      return this.status();
    });
  }

  /**
   * Убрать сторожа. Сервер удалён из панели — зайти на него нельзя: забываем запись (сторож на нём, если
   * сервер ещё работает, продолжит проверять панель — об этом говорит интерфейс).
   */
  remove(): Promise<WatchdogStatus> {
    return this.exclusive(async () => {
      const stored = await this.load();
      if (!stored) return this.status();
      const row = await this.serversRepo.findById(stored.serverId);
      if (row) {
        const { target, name } = await this.servers.sshTargetFor(row.id);
        this.audit.extend({ target: { type: 'server', id: row.id, display: name } });
        const out = await this.run(target, WATCHDOG_REMOVE_COMMAND, {
          timeoutMs: WATCHDOG_WAIT_MS.remove,
          label: 'снятие сторожа панели',
        });
        const res = parseWatchdogOutput(out.stdout);
        if (res.removed !== '1') throw this.failed('Сторож не убран', res.error, out);
        this.audit.extend({ metadata: { server: name } });
      } else {
        this.audit.extend({ metadata: { server: stored.serverName, serverGone: true } });
      }
      await this.save(null);
      return this.status();
    });
  }

  /** «Проверить сторожа»: сам сторож присылает тестовое сообщение и говорит, видит ли панель. */
  test(): Promise<WatchdogTestResponse> {
    return this.exclusive(async () => {
      const stored = await this.load();
      if (!stored)
        throw problem(HttpStatus.CONFLICT, {
          type: WATCHDOG_PROBLEM.blocked,
          detail: 'Сторож ещё не поставлен.',
        });
      const row = await this.serversRepo.findById(stored.serverId);
      if (!row)
        throw problem(HttpStatus.CONFLICT, {
          type: WATCHDOG_PROBLEM.blocked,
          detail: `Сервера «${stored.serverName}» больше нет в панели — проверить сторожа на нём нельзя.`,
        });
      const { target, name } = await this.servers.sshTargetFor(row.id);
      this.audit.extend({ target: { type: 'server', id: row.id, display: name } });
      const params = await this.params(name);
      const currentFingerprint = fingerprint(params);
      // Старый сторож не знает новый Rich Message API или старые настройки чатов. Кнопка
      // проверки сначала безопасно заменяет его, чтобы тест проверял текущую версию.
      if (stored.fingerprint !== currentFingerprint) {
        const installed = await this.run(target, WATCHDOG_INSTALL_COMMAND, {
          input: watchdogEnvFile(params),
          timeoutMs: WATCHDOG_WAIT_MS.install,
          label: WATCHDOG_INSTALL_LABEL,
        });
        const installResult = parseWatchdogOutput(installed.stdout);
        if (installResult.installed !== '1')
          throw this.failed('Сторож не обновился', installResult.error, installed);
        await this.save({ ...stored, serverName: name, fingerprint: currentFingerprint });
      }
      const out = await this.run(target, WATCHDOG_TEST_COMMAND, {
        timeoutMs: WATCHDOG_WAIT_MS.test,
        label: 'проверка сторожа панели',
      });
      const res = parseWatchdogOutput(out.stdout);
      let result: WatchdogTestResponse;
      if (res.missing === '1')
        result = {
          ok: false,
          detail: `Сторожа на сервере «${name}» нет — его убрали вручную или сервер переустановили. Поставьте сторожа заново.`,
        };
      else if (res.timer === '0')
        result = {
          ok: false,
          detail: `Сторож на сервере «${name}» установлен, но его расписание остановлено. Поставьте сторожа заново.`,
        };
      else if (res.sent === undefined) throw this.failed('Сторож не ответил', res.error, out);
      else {
        const sent = res.sent === '1';
        const sees = res.panel === 'ok';
        const seen = res.panel || 'нет ответа';
        result = {
          ok: sent && sees,
          detail:
            sent && sees
              ? `Сторож на сервере «${name}» на месте: тестовое сообщение отправлено, панель с этого сервера отвечает.`
              : sent
                ? `Тестовое сообщение отправлено, но панель с сервера «${name}» сейчас не отвечает (${seen}). Через три минуты сторож сочтёт это сбоем — проверьте, открывается ли панель по своему адресу.`
                : sees
                  ? `Сторож на месте и панель видит, но тестовое сообщение до Telegram не дошло: с сервера «${name}» Telegram может быть недоступен. Лучше поставить сторожа на сервер за рубежом.`
                  : `Тестовое сообщение до Telegram не дошло, и панель с сервера «${name}» не отвечает (${seen}).`,
        };
      }
      this.audit.extend({ metadata: { server: name, ok: result.ok, detail: result.detail } });
      return result;
    });
  }
}
