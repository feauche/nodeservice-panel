import { Injectable, Logger } from '@nestjs/common';
import {
  BLOCK_CHECK_ATTEMPTS,
  type BlockCheckResult,
  type BlockProbeResult,
  type BlockUncheckedReason,
  type Server,
} from '@nodeservice/shared';

import { normalizeAddress } from '../servers/addresses.js';
import { ServersService } from '../servers/servers.service.js';
import { SshService } from '../servers/ssh.service.js';
import {
  blindAttempt,
  blindReason,
  buildBlockCheckCommand,
  type CountryReach,
  combineVerdicts,
  isSafeBlockCheckTarget,
  type ProbeExclude,
  parseBlockCheckOutput,
  pickCountryProbes,
  pickForeignProbes,
  pickRuProbes,
  probeSaw,
  settleAttempts,
  settleEntry,
  withForeign,
} from './block-check.logic.js';
import type { UpstreamTarget } from './upstream-target.js';

/**
 * Записи панели, которые и есть проверяемая машина: названные вызывающим (сервер ноды, его вторые записи)
 * и все серверы с тем же адресом, что у цели, — их вызывающий мог и не знать.
 */
function selfIds(
  exclude: ProbeExclude,
  address: string | null,
  all: Pick<Server, 'id' | 'host'>[],
): string[] {
  const ids = new Set(typeof exclude === 'string' ? [exclude] : (exclude ?? []));
  if (address !== null) {
    const target = normalizeAddress(address);
    for (const s of all) if (normalizeAddress(s.host) === target) ids.add(s.id);
  }
  return [...ids];
}

/** Панель зашла на проверяющий сервер, но команда проверки не завершилась (таймаут, обрыв посреди команды). */
class ProbeRunError extends Error {}

/** Проверка «из каждой страны»: что увидели и — если не увидел никто — почему. */
export interface CountryReachResult {
  results: CountryReach[];
  /** Почему список пуст; null — кто-то из проверяющих дошёл до цели. */
  blind: BlockUncheckedReason | null;
}

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
      // Сбой самой команды — не «панель не зашла на проверяющий»: причину в тексте называем свою.
      // Полная проверка может выполнить до 30 TLS-запросов (10 размеров × 3 повтора). Общий SSH-лимит
      // 20 секунд обрывал исправную, но медленную сеть раньше собственных таймаутов команды.
      const res = await session
        .exec(command, { timeoutMs: 150_000, label: 'проверка доступности ноды' })
        .catch((err: unknown) => {
          throw new ProbeRunError(err instanceof Error ? err.message : String(err));
        });
      return { stdout: res.stdout, code: res.code };
    } finally {
      session.end();
    }
  }

  /**
   * Большинство вердиктов повторных попыток с ОДНОГО и того же сервера; ничья решается по приоритету.
   * `portOnlyByDesign` — проверяем только порт намеренно (встречная проверка, вход, «жив ли сервер»), а не
   * потому, что имя маскировки неизвестно: в тексте пробы тогда нет оговорки про имя маскировки.
   */
  private async probeFrom(
    prober: Pick<Server, 'id' | 'name'>,
    address: string,
    port: number,
    sni: string | null,
    portOnlyByDesign = false,
  ): Promise<BlockProbeResult> {
    const command = buildBlockCheckCommand(address, port, sni);
    const attempts: BlockProbeResult[] = [];
    for (let i = 0; i < BLOCK_CHECK_ATTEMPTS; i += 1) {
      try {
        const { stdout } = await this.runOnce(prober.id, command);
        attempts.push(parseBlockCheckOutput(prober.name, stdout, portOnlyByDesign));
      } catch (err) {
        this.log.warn(`Проверка блокировки с «${prober.name}»: ${err instanceof Error ? err.message : err}`);
        const ran = err instanceof ProbeRunError;
        attempts.push({
          from: prober.name,
          verdict: 'unreachable',
          detail: ran
            ? err instanceof Error && /таймаут/i.test(err.message)
              ? 'Проверка на проверяющем сервере не уложилась в 150 секунд.'
              : 'Проверка на проверяющем сервере не завершилась.'
            : 'Не удалось подключиться к пробующему серверу.',
          stalledAtKb: null,
          error: ran ? 'run' : 'ssh',
        });
      }
    }
    // Ни одна попытка не дошла до цели — это «проверить не удалось», а не «порт закрыт».
    const winner = settleAttempts(attempts, sni === null) ?? blindAttempt(attempts);
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
    exclude: ProbeExclude,
    allServers: Server[],
    /** Порта нет потому, что Remnawave не ответила на запрос, — а не потому, что у ноды его нет. */
    inboundFailed = false,
    options: { targetKind?: 'node' | 'server'; portOnly?: boolean } = {},
  ): Promise<BlockCheckResult> {
    const targetKind = options.targetKind ?? 'node';
    const portOnly = options.portOnly ?? false;
    // Проверка не состоялась: проб нет, а причина названа — текст дела скажет, что именно помешало.
    const unchecked = (reason: BlockUncheckedReason, sniUsed: string | null): BlockCheckResult => ({
      targetKind,
      ...(port ? { port } : {}),
      nodeName,
      address,
      sniUsed,
      probes: [],
      foreign: [],
      verdict: 'unreachable',
      unchecked: reason,
      foreignUnchecked: null,
      entry: null,
    });
    if (!port) return unchecked(inboundFailed ? 'remnawave' : 'no_port', null);
    // Не только «нет данных», но и «данные не похожи на настоящий адрес/порт/имя»: Remnawave — внешний
    // источник, панель эти значения не проверяет на своей стороне.
    if (!isSafeBlockCheckTarget(address, port, sni || null)) return unchecked('bad_address', null);
    // Проверяемая машина в проверку не идёт — ни под какой своей записью: подключение к самой себе
    // не видят ни файрвол хостера, ни блокировщик.
    const self = selfIds(exclude, address, allServers);
    const probers = pickRuProbes(self, allServers);
    if (probers.length === 0) return unchecked('no_probers', sni || null);
    // Проверяющий, на который панель не зашла (или который не смог выполнить проверку), о ноде ничего
    // не знает — в вердикт не идёт.
    const tried = await Promise.all(
      probers.map((p) => this.probeFrom(p, address, port, sni || null, portOnly)),
    );
    const probes = tried.filter(probeSaw);
    if (probes.length === 0) return unchecked(blindReason(tried), sni || null);
    const ruVerdict = combineVerdicts(probes);
    // Тот же порт проверяем и из-за рубежа всегда, а не только когда он целиком молчит из России. Поэтому
    // первое сообщение об аномалии и последующий разбор Джарвиса опираются на одну географию: видно и
    // частичную фильтрацию, и нормальный зарубежный маршрут. За рубежом достаточно TCP, без TLS/SNI.
    let foreign: BlockProbeResult[] = [];
    // Почему встречной проверки нет: зарубежных серверов в парке нет — или они есть, но проверка с них
    // не получилась. «Проверить нечем» про второй случай было бы неправдой.
    let foreignUnchecked: BlockUncheckedReason | null = null;
    const abroad = pickForeignProbes(self, allServers);
    const triedAbroad = await Promise.all(abroad.map((p) => this.probeFrom(p, address, port, null, true)));
    foreign = triedAbroad.filter(probeSaw);
    if (foreign.length === 0)
      foreignUnchecked = abroad.length === 0 ? 'no_probers' : blindReason(triedAbroad);
    return {
      targetKind,
      port,
      nodeName,
      address,
      sniUsed: sni || null,
      probes,
      foreign,
      verdict: withForeign(ruVerdict, foreign),
      unchecked: null,
      foreignUnchecked,
      entry: null,
    };
  }

  /**
   * Сервер без Remnawave-ноды всё равно проверяем из России: целевой SSH-порт известен NodeService.
   * Это намеренная TCP-проверка, поэтому отсутствие SNI не выдаётся за недостающую маскировку ноды.
   */
  async checkServer(
    serverName: string,
    address: string,
    sshPort: number,
    exclude: ProbeExclude,
    allServers: Server[],
  ): Promise<BlockCheckResult> {
    return this.check(serverName, address, sshPort, null, exclude, allServers, false, {
      targetKind: 'server',
      portOnly: true,
    });
  }

  /**
   * Жив ли сервер: стучимся в его порт (обычно SSH) с одного сервера парка в каждой стране. Открыт хоть
   * откуда-то — сервер работает, закрыт путь из части сетей (блокировка или маршрут). Только TCP-порт.
   */
  async countryReach(
    address: string,
    port: number,
    exclude: ProbeExclude,
    allServers: Server[],
  ): Promise<CountryReachResult> {
    if (!isSafeBlockCheckTarget(address, port, null)) return { results: [], blind: 'bad_address' };
    const probers = pickCountryProbes(selfIds(exclude, address, allServers), allServers);
    if (probers.length === 0) return { results: [], blind: 'no_probers' };
    // Проверяющий, на который панель не зашла, в список не попадает: «не смогли проверить» ≠ «закрыт».
    const tried = await Promise.all(probers.map((p) => this.probeFrom(p, address, port, null, true)));
    const results = probers.flatMap((p, i) => {
      const r = tried[i] as BlockProbeResult;
      return probeSaw(r) ? [{ from: p.name, country: p.country.code, open: r.verdict === 'ok' }] : [];
    });
    // Проверяющие есть, а не дошёл никто: это не «проверить не с чего» — возможно, связь пропала у панели.
    return { results, blind: results.length === 0 ? blindReason(tried) : null };
  }

  /**
   * Вход сервера-выхода (свой мост или вход арендодателя): стучимся в его порт из России, без TLS — имени
   * маскировки чужого входа мы не знаем. Проверяющий, на который панель не зашла, не считается; одного
   * ответа хватает, чтобы вход считался открытым (см. settleEntry). Нечем проверить, адрес подозрительный
   * или никто не дошёл — проб нет: вход «проверить не удалось», без вывода о нём, но с настоящей причиной
   * (`unchecked`): мост с самого себя не проверяется, и при единственном российском сервере проверять не с чего.
   */
  async checkEntry(
    target: UpstreamTarget,
    exclude: ProbeExclude,
    allServers: Server[],
  ): Promise<NonNullable<BlockCheckResult['entry']>> {
    const address = `${target.host}:${target.port}`;
    const base = { label: target.label, address, owner: target.owner, rented: target.rented };
    const skipped = (reason: BlockUncheckedReason): NonNullable<BlockCheckResult['entry']> => ({
      ...base,
      probes: [],
      verdict: 'unreachable',
      unchecked: reason,
    });
    if (!isSafeBlockCheckTarget(target.host, target.port, null)) return skipped('bad_address');
    // С самого выхода вход не проверяем (это другой вопрос — «доходит ли выход до входа»), с самого входа —
    // тем более: мост под любой своей записью в панели отпадает.
    const self = new Set([
      ...selfIds(exclude, null, allServers),
      ...selfIds(target.serverId, target.host, allServers),
    ]);
    const probers = pickRuProbes([...self], allServers);
    if (probers.length === 0) return skipped('no_probers');
    const tried = await Promise.all(
      probers.map((p) => this.probeFrom(p, target.host, target.port, null, true)),
    );
    const { probes, verdict } = settleEntry(tried);
    if (probes.length === 0) return skipped(blindReason(tried));
    return { ...base, probes, verdict, unchecked: null };
  }
}
