import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { Server, ServerInventory } from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';
import { ServersService } from '../servers/servers.service.js';
import { FleetProbeService } from './fleet-probe.service.js';

/** Снимок не старше этого считается свежим: раз в сутки хватает, чтобы заметить расхождение с профилем. */
const FRESH_MS = 23 * 60 * 60 * 1000;
const PAUSE_BETWEEN_MS = 1_500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Что показать человеку вместо технической ошибки SSH: статус 424, чтобы текст не подменялся общим для 5xx. */
function readable(err: unknown): string {
  if (err instanceof HttpException) {
    const body = err.getResponse();
    const detail = typeof body === 'object' && body ? (body as { detail?: string }).detail : undefined;
    if (detail) return detail;
  }
  return 'Сервер не ответил по SSH.';
}

/**
 * Снимок фактического состояния серверов (J3): по SSH читаем контейнеры и слушающие порты, чтобы сравнить с
 * профилем. Раз в сутки для всех серверов с рабочим SSH и по кнопке для одного. Только чтение.
 */
@Injectable()
export class FleetInventoryService {
  private readonly log = new Logger(FleetInventoryService.name);
  private running = false;

  constructor(
    private readonly servers: ServersService,
    private readonly probe: FleetProbeService,
  ) {}

  /** Обновить снимок одного сервера; ошибка SSH — понятным текстом со статусом 424. */
  async refresh(id: string): Promise<Server> {
    await this.servers.get(id);
    try {
      const [c, p] = await Promise.all([this.probe.containers(id), this.probe.ports(id)]);
      const inventory: Omit<ServerInventory, 'at'> = {
        docker: c.docker,
        containers: c.containers
          .slice(0, 60)
          .map((x) => ({ name: x.name, state: x.state, restarts: x.restarts })),
        ports: p.ports.slice(0, 120).map((x) => ({
          proto: x.proto,
          port: x.port,
          process: x.process,
          exposed: x.exposed,
        })),
      };
      return await this.servers.saveInventory(id, inventory);
    } catch (err) {
      this.log.warn(`Снимок сервера ${id} не получен: ${err instanceof Error ? err.message : String(err)}`);
      throw problem(HttpStatus.FAILED_DEPENDENCY, {
        detail: `Не удалось прочитать состояние сервера: ${readable(err)}`,
      });
    }
  }

  /** Раз в час проходим по серверам, у которых снимка нет или он старше суток. */
  @Interval(60 * 60 * 1000)
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    await this.refreshStale();
  }

  /** Один проход; вынесен из таймера ради тестов. Возвращает число обновлённых. */
  async refreshStale(now = Date.now()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let done = 0;
    try {
      for (const s of await this.servers.list()) {
        if (s.sshOk === false) continue;
        const age = s.inventory ? now - Date.parse(s.inventory.at) : Number.POSITIVE_INFINITY;
        if (age < FRESH_MS) continue;
        try {
          await this.refresh(s.id);
          done += 1;
        } catch {
          // причина уже в журнале приложения; следующий сервер не ждёт
        }
        await sleep(PAUSE_BETWEEN_MS);
      }
    } finally {
      this.running = false;
    }
    return done;
  }
}
