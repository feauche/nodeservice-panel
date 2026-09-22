import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { TERMINAL_IDLE_MS, TERMINAL_MAX_SESSIONS } from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';
import type { AuditActor } from '../audit/audit.context.js';
import { AuditService } from '../audit/audit.service.js';
import { ServersService } from '../servers/servers.service.js';
import type { SshShell } from '../servers/ssh.service.js';
import { SshService } from '../servers/ssh.service.js';

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
 * пишет в Журнал факт открытия/закрытия (без содержимого).
 */
@Injectable()
export class TerminalService {
  private readonly log = new Logger(TerminalService.name);
  private active = 0;

  constructor(
    private readonly servers: ServersService,
    private readonly ssh: SshService,
    private readonly audit: AuditService,
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

    shell.onData((chunk) => hooks.onOutput(chunk));
    shell.onClose((code) => finish(code));
    resetIdle();

    return {
      write: (data) => {
        resetIdle();
        shell.write(data);
      },
      resize: (cols, rows) => shell.resize(cols, rows),
      close: () => finish(null, 'закрыт пользователем'),
    };
  }
}
