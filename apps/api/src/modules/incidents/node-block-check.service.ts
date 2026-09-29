import { Injectable, Logger } from '@nestjs/common';
import {
  BLOCK_CHECK_ATTEMPTS,
  type BlockCheckResult,
  type BlockProbeResult,
  type Server,
} from '@nodeservice/shared';

import { ServersService } from '../servers/servers.service.js';
import { SshService } from '../servers/ssh.service.js';
import {
  buildBlockCheckCommand,
  type CountryReach,
  combineVerdicts,
  isSafeBlockCheckTarget,
  parseBlockCheckOutput,
  pickCountryProbes,
  pickForeignProbes,
  pickRuProbes,
  settleAttempts,
  withForeign,
} from './block-check.logic.js';
import type { UpstreamTarget } from './upstream-target.js';

/**
 * J10: запускает проверку блокировки ноды (ТСПУ / «блок 16–20 КБ») с других серверов парка в
 * России по SSH — тем же способом, что и check_reachability, никакого нового агента не нужно.
 * Один обрыв соединения ненадёжен (бывают случайные RST) — каждый пробующий сервер повторяет
 * проверку несколько раз, вердикт этого сервера берётся по большинству его же попыток.
 */
@Injectable()
export class NodeBlockCheckService {
  private readonly log = new Logger(NodeBlockCheckService.name);

  constructor(
    private readonly servers: ServersService,
    private readonly ssh: SshService,
  ) {}

  private async runOnce(serverId: string, command: string): Promise<{ stdout: string; code: number }> {
    const { target } = await this.servers.sshTargetFor(serverId);
    const session = await this.ssh.connect(target);
    try {
      const res = await session.exec(command);
      return { stdout: res.stdout, code: res.code };
    } finally {
      session.end();
    }
  }

  /** Большинство вердиктов повторных попыток с ОДНОГО и того же сервера; ничья решается по приоритету. */
  private async probeFrom(
    prober: Pick<Server, 'id' | 'name'>,
    address: string,
    port: number,
    sni: string | null,
  ): Promise<BlockProbeResult> {
    const command = buildBlockCheckCommand(address, port, sni);
    const attempts: BlockProbeResult[] = [];
    for (let i = 0; i < BLOCK_CHECK_ATTEMPTS; i += 1) {
      try {
        const { stdout } = await this.runOnce(prober.id, command);
        attempts.push(parseBlockCheckOutput(prober.name, stdout));
      } catch (err) {
        this.log.warn(`Проверка блокировки с «${prober.name}»: ${err instanceof Error ? err.message : err}`);
        attempts.push({
          from: prober.name,
          verdict: 'unreachable',
          detail: 'Не удалось подключиться к пробующему серверу.',
          stalledAtKb: null,
          error: 'ssh',
        });
      }
    }
    // Ни одна попытка не дошла до цели — это «проверить не удалось», а не «порт закрыт».
    const winner = settleAttempts(attempts, sni === null) ?? (attempts[0] as BlockProbeResult);
    return { ...winner, from: prober.name };
  }

  /**
   * Полная проверка ноды: выбрать до трёх серверов парка в России (не саму ноду), прогнать с каждого
   * по несколько раз, вернуть общий вердикт. `sni: null` — у ноды не Reality (или не удалось разобрать
   * маскировку): проверяем только доступность порта (`sniUsed: null` в ответе). Без порта проверка
   * невозможна технически — пустой результат.
   */
  async check(
    nodeName: string,
    address: string,
    port: number | null,
    sni: string | null,
    excludeServerId: string | null,
    allServers: Server[],
  ): Promise<BlockCheckResult> {
    // Второе условие — не только «нет данных», но и «данные не похожи на настоящий адрес/порт/имя»:
    // Remnawave — внешний источник, панель эти значения не проверяет на своей стороне.
    if (!port || !isSafeBlockCheckTarget(address, port, sni || null))
      return {
        nodeName,
        address,
        sniUsed: null,
        probes: [],
        foreign: [],
        verdict: 'unreachable',
        entry: null,
      };
    const probers = pickRuProbes(excludeServerId, allServers);
    if (probers.length === 0)
      return {
        nodeName,
        address,
        sniUsed: sni || null,
        probes: [],
        foreign: [],
        verdict: 'unreachable',
        entry: null,
      };
    // Проверяющий, на который панель не зашла, о ноде ничего не знает — в вердикт не идёт.
    const probes = (
      await Promise.all(probers.map((p) => this.probeFrom(p, address, port, sni || null)))
    ).filter((p) => p.error !== 'ssh');
    if (probes.length === 0)
      return {
        nodeName,
        address,
        sniUsed: sni || null,
        probes: [],
        foreign: [],
        verdict: 'unreachable',
        entry: null,
      };
    const ruVerdict = combineVerdicts(probes);
    // Из России порт молчит — тот же вопрос, что владелец решает руками («по SSH из России не заходит,
    // а через VPN заходит»): стучимся в тот же порт с зарубежных серверов парка. Только порт, без TLS.
    const foreign =
      ruVerdict === 'unreachable'
        ? await Promise.all(
            pickForeignProbes(excludeServerId, allServers).map((p) => this.probeFrom(p, address, port, null)),
          ).then((r) => r.filter((p) => p.error !== 'ssh'))
        : [];
    return {
      nodeName,
      address,
      sniUsed: sni || null,
      probes,
      foreign,
      verdict: withForeign(ruVerdict, foreign),
      entry: null,
    };
  }

  /**
   * Жив ли сервер: стучимся в его порт (обычно SSH) с одного сервера парка в каждой стране. Открыт хоть
   * откуда-то — сервер работает, закрыт путь из части сетей (блокировка или маршрут). Только TCP-порт.
   */
  async countryReach(
    address: string,
    port: number,
    excludeServerId: string | null,
    allServers: Server[],
  ): Promise<CountryReach[]> {
    if (!isSafeBlockCheckTarget(address, port, null)) return [];
    const probers = pickCountryProbes(excludeServerId, allServers);
    // Проверяющий, на который панель не зашла, в список не попадает: «не смогли проверить» ≠ «закрыт».
    const results = await Promise.all(
      probers.map(async (p) => {
        const r = await this.probeFrom(p, address, port, null);
        return r.error === 'ssh' ? null : { from: p.name, country: p.country.code, open: r.verdict === 'ok' };
      }),
    );
    return results.filter((r): r is CountryReach => r !== null);
  }

  /**
   * Вход сервера-выхода (свой мост или вход арендодателя): стучимся в его порт из России, без TLS — имени
   * маскировки чужого входа мы не знаем. Нечем проверить или адрес подозрительный — null.
   */
  async checkEntry(
    target: UpstreamTarget,
    excludeServerId: string | null,
    allServers: Server[],
  ): Promise<NonNullable<BlockCheckResult['entry']>> {
    const address = `${target.host}:${target.port}`;
    const probers = isSafeBlockCheckTarget(target.host, target.port, null)
      ? pickRuProbes(excludeServerId, allServers).filter((p) => p.id !== target.serverId)
      : [];
    const probes = await Promise.all(probers.map((p) => this.probeFrom(p, target.host, target.port, null)));
    return {
      label: target.label,
      address,
      owner: target.owner,
      probes,
      verdict: probes.length > 0 ? combineVerdicts(probes) : 'unreachable',
    };
  }
}
