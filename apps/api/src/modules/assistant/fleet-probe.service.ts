import { Injectable, Logger } from '@nestjs/common';
import type { ReachabilityResult, Server } from '@nodeservice/shared';

import { ServersService } from '../servers/servers.service.js';
import { SshService } from '../servers/ssh.service.js';
import {
  buildReachCommand,
  dnsSummary,
  isProbeHost,
  normalizePorts,
  PROCESSES_COMMAND,
  parsePs,
  parseReach,
  pickProbes,
  type ReachProbe,
  summarizeReach,
} from './fleet-probe.logic.js';

/** Проверка одного и того же адреса чаще, чем раз в это время, отдаёт прежний результат. */
const CACHE_MS = process.env.NODE_ENV === 'test' ? 0 : 30_000;

/** Что проверяющие видят снаружи парка; ограничение честно называется в самом результате. */
const NOT_USER_VIEW =
  'Проверка идёт с других серверов парка, а не из сети пользователей. Если у части пользователей не работает, а отсюда всё открыто, причина может быть в блокировке для их провайдера или региона: отсюда это не видно.';

/**
 * Чтение с серверов парка по SSH (только чтение, уровень T0): доступность адреса снаружи с
 * независимых серверов и осмотр процессов. Ничего не меняет и не пишет на серверах.
 */
@Injectable()
export class FleetProbeService {
  private readonly log = new Logger(FleetProbeService.name);
  private readonly cache = new Map<string, { at: number; result: ReachabilityResult }>();

  constructor(
    private readonly servers: ServersService,
    private readonly ssh: SshService,
  ) {}

  private async run(serverId: string, command: string): Promise<{ stdout: string; code: number }> {
    const { target } = await this.servers.sshTargetFor(serverId);
    const session = await this.ssh.connect(target);
    try {
      const res = await session.exec(command);
      return { stdout: res.stdout, code: res.code };
    } finally {
      session.end();
    }
  }

  async reachability(target: Server, all: Server[], portsRaw: unknown): Promise<ReachabilityResult> {
    const address = `${target.host}`;
    const ports = normalizePorts(portsRaw, target.port);
    const key = `${target.id}:${ports.join(',')}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;

    const notes: string[] = [NOT_USER_VIEW];
    if (!isProbeHost(target.host)) {
      const result: ReachabilityResult = {
        target: { name: target.name, address },
        probes: [],
        ports: [],
        dns: { answers: [], consistent: true },
        notes: ['Адрес сервера (IPv6 или нестандартный) для такой проверки не подходит.'],
      };
      return result;
    }
    const chosen = pickProbes(target, all);
    if (chosen.length === 0)
      return {
        target: { name: target.name, address },
        probes: [],
        ports: [],
        dns: { answers: [], consistent: true },
        notes: ['Нет других серверов парка с рабочим SSH: проверить снаружи не с чего.', NOT_USER_VIEW],
      };
    if (chosen.length < 2) notes.unshift('Независимых проверяющих меньше двух: вывод слабый.');

    const command = buildReachCommand(target.host, ports);
    const probes: ReachProbe[] = await Promise.all(
      chosen.map(async (s): Promise<ReachProbe> => {
        try {
          const res = await this.run(s.id, command);
          const parsed = parseReach(res.stdout, ports);
          return {
            from: s.name,
            ok: parsed.ports.length > 0,
            error: parsed.ports.length > 0 ? null : 'Проверка не вернула результата.',
            ...parsed,
          };
        } catch (err) {
          this.log.warn(`Проверка доступности с «${s.name}»: ${err instanceof Error ? err.message : err}`);
          return {
            from: s.name,
            ok: false,
            error: 'Не удалось подключиться к проверяющему серверу.',
            ports: [],
            dns: null,
          };
        }
      }),
    );
    if (probes.some((p) => !p.ok)) notes.unshift('Часть проверяющих не ответила: учтены только ответившие.');
    const result: ReachabilityResult = {
      target: { name: target.name, address },
      probes,
      ports: summarizeReach(probes, ports),
      dns: dnsSummary(probes),
      notes,
    };
    if (!result.dns.consistent)
      result.notes.unshift(
        `DNS отвечает по-разному у разных проверяющих (${result.dns.answers.join(', ')}): возможна подмена или сбой резолвера.`,
      );
    this.cache.set(key, { at: Date.now(), result });
    return result;
  }

  /** Самые тяжёлые процессы по CPU и памяти: только имена и цифры, командные строки не читаются. */
  async processes(serverId: string) {
    const res = await this.run(serverId, PROCESSES_COMMAND);
    const parsed = parsePs(res.stdout);
    return { ...parsed, empty: parsed.cpu.length === 0 && parsed.mem.length === 0 };
  }
}
