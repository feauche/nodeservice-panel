import type { IncomingMessage } from 'node:http';
import { Injectable, Logger } from '@nestjs/common';
import { TERMINAL_WS_PATH, type TerminalServerMsg, terminalClientMsgSchema } from '@nodeservice/shared';
import { WebSocket, WebSocketServer } from 'ws';

import { CookiesService } from '../../common/http/cookies.service.js';
import { WsUpgradeService } from '../../infra/ws/ws-upgrade.service.js';
import type { AuditActor } from '../audit/audit.context.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionStore } from '../auth/session.store.js';
import { UsersRepository } from '../auth/users.repository.js';
import { TerminalService, type TerminalSession } from './terminal.service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * Шлюз веб-терминала (/ws/terminal): аутентификация по session-cookie + свежий step-up
 * (тот же порог, что у HTTP-guard). Один сокет — одна PTY-сессия.
 */
@Injectable()
export class TerminalGateway {
  private readonly log = new Logger(TerminalGateway.name);
  private wss: WebSocketServer | null = null;

  constructor(
    private readonly terminal: TerminalService,
    private readonly sessions: SessionStore,
    private readonly users: UsersRepository,
    private readonly cookies: CookiesService,
    private readonly wsUpgrade: WsUpgradeService,
    private readonly audit: AuditService,
  ) {}

  register(): void {
    this.wss = new WebSocketServer({ noServer: true });
    this.wsUpgrade.register(TERMINAL_WS_PATH, (req, socket, head) => {
      this.wss?.handleUpgrade(req, socket, head, (ws) => void this.handle(ws, req));
    });
  }

  private async handle(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const url = new URL(req.url ?? '', 'http://localhost');
    const serverId = url.searchParams.get('server') ?? '';
    const cols = clampSize(url.searchParams.get('cols'), 80);
    const rows = clampSize(url.searchParams.get('rows'), 24);

    // Аутентификация: session-cookie → запись сессии → не заблокирована. Step-up не требуем.
    const sid = readCookie(req.headers.cookie, this.cookies.names.session);
    const record = sid ? await this.sessions.get(sid) : null;
    if (!record) return this.reject(ws, 4401, 'Требуется вход', { serverId });
    if (record.lockedAt)
      return this.reject(ws, 4403, 'Экран заблокирован', { serverId, userId: record.userId });
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

    this.send(ws, { t: 'y' });
    ws.on('message', (raw) => {
      const parsed = terminalClientMsgSchema.safeParse(safeJson(raw.toString()));
      if (!parsed.success) return;
      if (parsed.data.t === 'i') session.write(parsed.data.d);
      else session.resize(parsed.data.c, parsed.data.r);
    });
    ws.on('close', () => session.close());
    ws.on('error', () => session.close());
  }

  private reject(
    ws: WebSocket,
    code: number,
    message: string,
    denied?: { serverId: string; userId?: string },
  ): void {
    this.send(ws, { t: 'e', m: message });
    ws.close(code, message);
    // Отказ по входу/блокировке — в Журнал: терминал даёт root на сервере.
    if (denied) {
      void this.audit
        .record({
          action: 'server.terminal.denied',
          result: 'denied',
          severity: 'warn',
          ...(denied.userId ? { actor: { type: 'admin', id: denied.userId, display: 'Администратор' } } : {}),
          ...(UUID_RE.test(denied.serverId) ? { target: { type: 'server', id: denied.serverId } } : {}),
          metadata: { code, reason: message },
        })
        .catch(() => undefined);
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
