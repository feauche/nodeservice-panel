import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { TERMINAL_IDLE_MS, TERMINAL_MAX_SESSIONS } from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';
import type { AuditActor } from '../audit/audit.context.js';
import { AuditService } from '../audit/audit.service.js';
import { ServersService } from '../servers/servers.service.js';
import type { SshShell } from '../servers/ssh.service.js';
import { SshService } from '../servers/ssh.service.js';
import { TerminalSessionsRepository } from './terminal-sessions.repository.js';

/** Запись вывода: копим в памяти и дописываем в БД пачками, чтобы не бить базу на каждый байт. */
const RECORD_FLUSH_MS = 1500;
const RECORD_FLUSH_BYTES = 32 * 1024;

/** Пара функций для общения шлюза с сессией. */
export interface TerminalHooks {
  onOutput: (chunk: string) => void;
  onExit: (code: number | null) => void;
}

export interface TerminalSession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/**
 * Веб-терминал: открывает PTY по SSH, следит за лимитом одновременных сессий и простоем,
 * пишет в Журнал факт открытия/закрытия, а вывод сессии сохраняет в историю терминала
 * (ввод не пишется — пароли с выключенным эхом в запись не попадают).
 */
@Injectable()
export class TerminalService {
  private readonly log = new Logger(TerminalService.name);
  private active = 0;

  constructor(
    private readonly servers: ServersService,
    private readonly ssh: SshService,
    private readonly audit: AuditService,
    private readonly history: TerminalSessionsRepository,
  ) {}

  async open(
    serverId: string,
    actor: AuditActor,
    size: { cols: number; rows: number },
    hooks: TerminalHooks,
  ): Promise<TerminalSession> {
    if (this.active >= TERMINAL_MAX_SESSIONS)
      throw problem(HttpStatus.TOO_MANY_REQUESTS, {
        detail: `Слишком много открытых терминалов (лимит ${TERMINAL_MAX_SESSIONS}). Закрой один и повтори.`,
      });
    const { target, name } = await this.servers.sshTargetFor(serverId);
    let shell: SshShell;
    try {
      shell = await this.ssh.openShell(target, size);
    } catch (err) {
      // Ошибку отдадим шлюзу текстом — она уйдёт клиенту как {t:'e'}.
      throw err;
    }
    this.active += 1;
    const openedAt = Date.now();

    // Запись сессии: провал записи не должен ронять сам терминал.
    let recordId: string | null = null;
    try {
      await this.history.prune();
      recordId = await this.history.start({
        serverId,
        actorId: actor.type === 'admin' ? (actor.id ?? null) : null,
        actorDisplay: actor.display ?? null,
        cols: size.cols,
        rows: size.rows,
      });
    } catch (err) {
      this.log.warn(`История терминала недоступна: ${(err as Error).message}`);
    }
    let pending = '';
    let pendingBytes = 0;
    let flushTimer: NodeJS.Timeout | null = null;
    let flushing: Promise<void> = Promise.resolve();
    const flush = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!recordId || pending.length === 0) return flushing;
      const chunk = pending;
      const bytes = pendingBytes;
      pending = '';
      pendingBytes = 0;
      const id = recordId;
      flushing = flushing
        .then(() => this.history.append(id, chunk, bytes))
        .catch((err) => this.log.warn(`История терминала: не записан кусок: ${(err as Error).message}`));
      return flushing;
    };
    const record = (chunk: string) => {
      if (!recordId) return;
      pending += chunk;
      pendingBytes += Buffer.byteLength(chunk);
      if (pendingBytes >= RECORD_FLUSH_BYTES) void flush();
      else if (!flushTimer) flushTimer = setTimeout(() => void flush(), RECORD_FLUSH_MS);
    };

    await this.audit.record({
      action: 'server.terminal.open',
      actor,
      target: { type: 'server', id: serverId, display: name },
      metadata: { host: `${target.host}:${target.port}` },
    });

    let closed = false;
    let idle: NodeJS.Timeout;
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => finish(null, 'простой'), TERMINAL_IDLE_MS);
    };
    const finish = (code: number | null, reason?: string) => {
      if (closed) return;
      closed = true;
      clearTimeout(idle);
      this.active -= 1;
      shell.close();
      hooks.onExit(code);
      if (recordId) {
        const id = recordId;
        void flush()
          .then(() => this.history.finish(id, code, reason ?? null))
          .catch((err) => this.log.warn(`История терминала: сессия не закрыта: ${(err as Error).message}`));
      }
      void this.audit.record({
        action: 'server.terminal.close',
        actor,
        target: { type: 'server', id: serverId, display: name },
        metadata: {
          seconds: Math.round((Date.now() - openedAt) / 1000),
          ...(reason ? { reason } : {}),
        },
      });
    };

    shell.onData((chunk) => {
      hooks.onOutput(chunk);
      record(chunk);
    });
    shell.onClose((code) => finish(code));
    resetIdle();

    return {
      write: (data) => {
        resetIdle();
        shell.write(data);
      },
      resize: (cols, rows) => {
        shell.resize(cols, rows);
        if (recordId) void this.history.resize(recordId, cols, rows).catch(() => undefined);
      },
      close: () => finish(null, 'закрыт пользователем'),
    };
  }
}
