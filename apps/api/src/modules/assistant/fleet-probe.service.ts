import { Injectable, Logger } from '@nestjs/common';
import type { ReachabilityResult, Server } from '@nodeservice/shared';

import { ServersService } from '../servers/servers.service.js';
import { SshService } from '../servers/ssh.service.js';
import {
  CONTAINERS_COMMAND,
  certCommand,
  DISK_COMMAND,
  KERNEL_COMMAND,
  type LogsResult,
  logsCommand,
  nodeLogsCommand,
  PORTS_COMMAND,
  parseCert,
  parseContainers,
  parseDisk,
  parseKernel,
  parsePorts,
  prepareLogs,
} from './fleet-inspect.logic.js';
import {
  buildReachCommand,
  dnsSummary,
  isProbeHost,
  normalizePorts,
  PROCESSES_COMMAND,
  parsePs,
  parseReach,
  pickProbes,
  prepareNodeLogs,
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

  /** Хвост журнала контейнера ноды с маскированием секретов и адресов. */
  async nodeLogs(serverId: string, opts: { sinceMinutes?: number; lines?: number; contains?: string } = {}) {
    const res = await this.run(serverId, nodeLogsCommand(opts.sinceMinutes, opts.lines ?? 80));
    const base = prepareNodeLogs(res.stdout, res.code);
    if (!base.found) return base;
    const logs = prepareLogs(res.stdout, opts.contains);
    return { found: true, ...logs };
  }

  /** Контейнеры Docker: состояние, перезапуски, коды выхода, OOM. */
  async containers(serverId: string) {
    return parseContainers((await this.run(serverId, CONTAINERS_COMMAND)).stdout);
  }

  /** Кто какие порты слушает. */
  async ports(serverId: string) {
    return parsePorts((await this.run(serverId, PORTS_COMMAND)).stdout);
  }

  /** Занятость диска, тяжёлые каталоги, Docker и журнал systemd. */
  async disk(serverId: string) {
    return parseDisk((await this.run(serverId, DISK_COMMAND)).stdout);
  }

  /** События ядра: OOM, ошибки диска, conntrack. */
  async kernel(serverId: string) {
    return parseKernel((await this.run(serverId, KERNEL_COMMAND)).stdout);
  }

  /** Сертификат, который порт отдаёт на самом сервере. */
  async certificate(serverId: string, port: number, servername?: string) {
    return parseCert((await this.run(serverId, certCommand(port, servername))).stdout);
  }

  /** Журнал цели за период; null — цель неизвестна или имя контейнера недопустимо (команда не собиралась). */
  async logs(
    serverId: string,
    target: string,
    opts: { sinceMinutes?: number; lines?: number; container?: string; contains?: string },
  ): Promise<LogsResult | null> {
    const cmd = logsCommand(target, opts.sinceMinutes ?? 60, opts.lines ?? 80, opts.container);
    if (!cmd) return null;
    return prepareLogs((await this.run(serverId, cmd)).stdout, opts.contains);
  }
}
