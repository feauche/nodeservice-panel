import type { IncomingMessage } from 'node:http';
import { Injectable, Logger } from '@nestjs/common';
import { TERMINAL_WS_PATH, type TerminalServerMsg, terminalClientMsgSchema } from '@nodeservice/shared';
import { WebSocket, WebSocketServer } from 'ws';

import { CookiesService } from '../../common/http/cookies.service.js';
import { closePreAuth, holdPreAuth, ownOrReject, PreAuthLimiter } from '../../infra/ws/ws-preauth.js';
import { WsUpgradeService } from '../../infra/ws/ws-upgrade.service.js';
import type { AuditActor } from '../audit/audit.context.js';
import { AuditService } from '../audit/audit.service.js';
import { AnonAuditLimiter } from '../auth/anon-audit.limiter.js';
import { SessionStore } from '../auth/session.store.js';
import { UsersRepository } from '../auth/users.repository.js';
import { TerminalService, type TerminalSession } from './terminal.service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Предел одного сообщения: с запасом на вставку большого файла в терминал, но не 100 МБ по умолчанию. */
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      // Битая кодировка (%E0%A4%A) — просто нет cookie: исключение оставило бы соединение без ответа.
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Шлюз веб-терминала (/ws/terminal): вход по session-cookie — при подключении и на каждом кадре
 * от браузера (экран заблокирован — ввод не принимаем, сессии нет — закрываем). Один сокет — одна PTY-сессия.
 */
@Injectable()
export class TerminalGateway {
  private readonly log = new Logger(TerminalGateway.name);
  private wss: WebSocketServer | null = null;
  /** Соединения, ещё не прошедшие проверку входа: не больше 5 с адреса и 50 всего (infra/ws/ws-preauth). */
  private readonly preAuth = new PreAuthLimiter();

  constructor(
    private readonly terminal: TerminalService,
    private readonly sessions: SessionStore,
    private readonly users: UsersRepository,
    private readonly cookies: CookiesService,
    private readonly wsUpgrade: WsUpgradeService,
    private readonly audit: AuditService,
    private readonly anonAudit: AnonAuditLimiter,
  ) {}

  register(): void {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
    this.wsUpgrade.register(TERMINAL_WS_PATH, (req, socket, head) => {
      const ip = this.wsUpgrade.clientIp(req);
      const open = (release: () => void) =>
        this.wss?.handleUpgrade(req, socket, head, (ws) => {
          // Сразу, до проверки входа: битый или слишком большой кадр приходит событием 'error', и без
          // слушателя это исключение мимо всех try/catch — панель падала от одного кадра без пароля.
          ws.on('error', () => {});
          void this.handle(ws, req, ip, release);
        });
      const release = holdPreAuth(this.preAuth, ip, socket);
      if (release) return open(release);
      // Прихожая занята (с этого адреса или вся): владельца с действующей сессией пускаем и так — иначе
      // поток соединений без входа с нескольких адресов закрывал бы ему терминал. Остальным — отказ 429.
      void ownOrReject(socket, () => this.signedIn(req)).then((own) => {
        if (own) open(() => {});
      });
    });
  }

  /** Вход, как его проверяет handle(): действующая сессия, экран не заблокирован. */
  private async signedIn(req: IncomingMessage): Promise<boolean> {
    const sid = readCookie(req.headers.cookie, this.cookies.names.session);
    const record = sid ? await this.sessions.get(sid) : null;
    return Boolean(record && !record.lockedAt);
  }

  /** release — освободить место соединения без входа: вход проверен (закрытие освобождает само). */
  private async handle(ws: WebSocket, req: IncomingMessage, ip: string, release: () => void): Promise<void> {
    const url = new URL(req.url ?? '', 'http://localhost');
    const serverId = url.searchParams.get('server') ?? '';
    const cols = clampSize(url.searchParams.get('cols'), 80);
    const rows = clampSize(url.searchParams.get('rows'), 24);

    // Аутентификация: session-cookie → запись сессии → не заблокирована. Step-up не требуем.
    const sid = readCookie(req.headers.cookie, this.cookies.names.session);
    const record = sid ? await this.sessions.get(sid) : null;
    if (!record) return this.reject(ws, 4401, 'Требуется вход', { serverId, ip });
    if (record.lockedAt)
      return this.reject(ws, 4403, 'Экран заблокирован', { serverId, ip, userId: record.userId });
    // Вход проверен — место среди соединений без входа больше не занимаем.
    release();
    if (!UUID_RE.test(serverId)) return this.reject(ws, 4400, 'Не указан сервер');

    const login = (await this.users.findById(record.userId))?.login;
    const actor: AuditActor = {
      type: 'admin',
      id: record.userId,
      display: login ?? 'Администратор',
    };

    let session: TerminalSession;
    try {
      session = await this.terminal.open(
        serverId,
        actor,
        { cols, rows },
        {
          onOutput: (d) => this.send(ws, { t: 'o', d }),
          onExit: (code) => {
            this.send(ws, { t: 'x', code });
            ws.close(1000, 'exit');
          },
        },
      );
    } catch (err) {
      const detail =
        (err as { response?: { detail?: string } })?.response?.detail ??
        (err as Error)?.message ??
        'Не удалось открыть терминал';
      this.send(ws, { t: 'e', m: detail });
      ws.close(1011, 'open-failed');
      return;
    }
    // Пока открывался терминал, браузер мог уйти: сессию на сервере закрываем, иначе она останется висеть.
    if (ws.readyState !== WebSocket.OPEN) {
      session.close();
      return;
    }

    this.send(ws, { t: 'y' });
    // Сессию панели проверяем на каждом кадре, а не только при подключении: окно терминала переживает
    // экран блокировки (браузер его лишь прячет), и без проверки открытый сокет принимал бы ввод
    // в root-оболочку без пароля. Кадры идут цепочкой, чтобы проверка не перемешала нажатия.
    let frames: Promise<void> = Promise.resolve();
    ws.on('message', (raw) => {
      const parsed = terminalClientMsgSchema.safeParse(safeJson(raw.toString()));
      if (!parsed.success) return;
      const msg = parsed.data;
      frames = frames
        .then(async () => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const current = await this.sessions.get(record.id);
          if (!current) {
            // Выход, истёк срок, «Завершить сессию» с другого устройства: терминал этой сессии закрываем.
            ws.close(4401, 'Требуется вход');
            session.close('сессия панели завершена');
            return;
          }
          if (msg.t === 'r') session.resize(msg.c, msg.r);
          // Экран заблокирован: вывод идёт дальше, ввод — только после пароля (отброшенное не копится).
          else if (!current.lockedAt) session.write(msg.d);
        })
        .catch((err) => {
          // Не смогли проверить сессию — кадр не пропускаем, как и HTTP-запрос без проверки входа.
          this.log.warn(`Терминал: кадр отброшен, сессия панели не проверена: ${(err as Error).message}`);
        });
    });
    ws.on('close', () => session.close());
  }

  private reject(
    ws: WebSocket,
    code: number,
    message: string,
    denied?: { serverId: string; ip: string; userId?: string },
  ): void {
    this.send(ws, { t: 'e', m: message });
    // Отказ до входа: молчащий на закрытие клиент не держит место в прихожей 30 секунд.
    if (denied) closePreAuth(ws, code, message);
    else ws.close(code, message);
    // Отказ по входу/блокировке — в Журнал: терминал даёт root на сервере.
    if (denied) {
      const entry = {
        action: 'server.terminal.denied',
        result: 'denied' as const,
        severity: 'warn' as const,
        ip: denied.ip,
        ...(denied.userId
          ? { actor: { type: 'admin' as const, id: denied.userId, display: 'Администратор' } }
          : {}),
        ...(UUID_RE.test(denied.serverId) ? { target: { type: 'server', id: denied.serverId } } : {}),
        metadata: { code, reason: message },
      };
      // Без входа постучаться может кто угодно: такие отказы — через общий предел записей в минуту,
      // иначе поток попыток заполнял бы Журнал, из которого ничего не удалить.
      void (
        denied.userId ? this.audit.record(entry) : this.anonAudit.record('request', denied.ip, entry)
      ).catch(() => undefined);
    }
  }

  private send(ws: WebSocket, msg: TerminalServerMsg): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
}

function clampSize(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : fallback;
}
function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
