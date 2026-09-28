import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  BLOCK_VERDICT_LABELS,
  NODE_ONLINE_DROP_MIN_BASELINE,
  NODE_ONLINE_DROP_PCT,
  type RemnawaveNode,
} from '@nodeservice/shared';
import { NotificationsService } from '../notifications/notifications.service.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { ServersService } from '../servers/servers.service.js';
import { IncidentsRepository } from './incidents.repository.js';
import { NodeBlockCheckService } from './node-block-check.service.js';

const TICK_MS = 60_000;
/** Не открывать новый инцидент по той же ноде чаще, чем раз во столько минут (в основном страховка для
 * нод без своего сервера в панели — у сопоставленных дубль и так не даст завести база данных). */
const COOLDOWN_MIN = 30;

interface Sample {
  online: number;
  checkedAt: string;
}

/** Просадка увидена, но ещё не открыта — ждёт подтверждения следующим снимком (см. коммент к checkNode). */
interface Candidate {
  baselineOnline: number;
}

/**
 * J10: аномалия онлайна ноды Remnawave (решения владельца 27.09.2026, уточнение 28.09.2026, поправка
 * 28.09.2026 про короткие просадки). Раз в минуту сравнивает свежий снимок Remnawave с предыдущим по
 * каждой ноде; сами данные обновляются реже (см. REMNAWAVE_SYNC_INTERVAL_MIN), поэтому по факту
 * сравнение идёт между двумя последними РАЗНЫМИ снимками — этого достаточно для порога «за 5 минут».
 * Резкое падение онлайна не открывает инцидент сразу: обычная перезагрузка сервера тоже на секунды
 * роняет онлайн до нуля и сама поднимается. Первое обнаружение — только кандидат; открываем инцидент,
 * лишь если следующий снимок этой же ноды снова подтверждает просадку (на практике — не раньше
 * следующего тика, то есть где-то через минуту, а не сразу). Если к тому моменту онлайн уже вернулся —
 * инцидент не заводим вовсе, тихо. Важность и заголовок открытого честно отражают результат встречной
 * проверки: подтвердилась блокировка — крит, проверка прошла чисто или не смогла отработать —
 * предупреждение без слова «блокировка» в заголовке.
 */
@Injectable()
export class NodeAnomalyJob {
  private readonly log = new Logger(NodeAnomalyJob.name);
  private readonly lastSample = new Map<string, Sample>();
  private readonly pending = new Map<string, Candidate>();
  private readonly cooldownUntil = new Map<string, number>();
  private busy = false;

  constructor(
    private readonly remnawave: RemnawaveService,
    private readonly servers: ServersService,
    private readonly incidents: IncidentsRepository,
    private readonly blockCheck: NodeBlockCheckService,
    private readonly notifications: NotificationsService,
  ) {}

  @Interval(TICK_MS)
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    await this.run();
  }

  async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const status = await this.remnawave.status();
      if (!status.connected || !status.checkedAt) return;
      for (const node of status.nodes) await this.checkNode(node, status.checkedAt);
    } catch (err) {
      this.log.warn(`Тик аномалии онлайна: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.busy = false;
    }
  }

  private async checkNode(node: RemnawaveNode, checkedAt: string): Promise<void> {
    const prev = this.lastSample.get(node.uuid);
    const online = node.usersOnline ?? 0;
    // Тот же снимок Remnawave (данные ещё не обновились) — сравнивать пока не с чем, ждём следующего.
    if (prev && prev.checkedAt === checkedAt) return;
    this.lastSample.set(node.uuid, { online, checkedAt });

    const candidate = this.pending.get(node.uuid);
    if (candidate) {
      this.pending.delete(node.uuid);
      const stillDown = online < candidate.baselineOnline * (1 - NODE_ONLINE_DROP_PCT / 100);
      if (stillDown) {
        const until = this.cooldownUntil.get(node.uuid) ?? 0;
        if (Date.now() >= until) {
          this.cooldownUntil.set(node.uuid, Date.now() + COOLDOWN_MIN * 60_000);
          await this.investigate(node, candidate.baselineOnline, online).catch((err) =>
            this.log.warn(
              `Проверка блокировки ноды «${node.name}»: ${err instanceof Error ? err.message : err}`,
            ),
          );
        }
        return;
      }
      // Поднялось само на следующей же проверке — инцидент не заводим, идём дальше как обычно.
    }

    if (!prev || prev.online < NODE_ONLINE_DROP_MIN_BASELINE) return;
    const dropPct = ((prev.online - online) / prev.online) * 100;
    if (dropPct < NODE_ONLINE_DROP_PCT) return;
    // Не открываем сразу — ждём подтверждения следующим снимком (см. коммент к классу).
    this.pending.set(node.uuid, { baselineOnline: prev.online });
  }

  private async investigate(node: RemnawaveNode, before: number, after: number): Promise<void> {
    const allServers = await this.servers.list();
    const matched = allServers.find((s) => s.host === node.address) ?? null;
    const inbound = await this.remnawave.nodeInbound(node.uuid);
    const result = await this.blockCheck.check(
      node.name,
      node.address,
      inbound?.port ?? null,
      inbound?.sni ?? null,
      matched?.id ?? null,
      allServers,
    );
    const dropLine = `Онлайн ноды «${node.name}» упал с ${before} до ${after} (это ${Math.round(((before - after) / before) * 100)} %) за короткое время.`;
    // «Подтвердилось» — хоть один пробующий сервер реально дозвонился и нашёл что-то, кроме «всё в
    // порядке» (сюда же честный «порт не отвечает» с настоящей пробы, не только ТСПУ/16–20 КБ).
    const confirmed = result.probes.length > 0 && result.verdict !== 'ok';
    let title: string;
    let detail: string;
    if (result.probes.length === 0) {
      title = `Резко упал онлайн, проверить не удалось · ${node.name}`;
      detail = inbound?.port
        ? `${dropLine} Проверить не удалось: нет ни одного российского сервера парка с рабочим SSH для встречной проверки.`
        : `${dropLine} Проверить не удалось: в Remnawave не нашёлся порт подключения этой ноды.`;
    } else if (result.sniUsed === null) {
      // Имя маскировки неизвестно — проверили только порт. «Недоступен» — честный вывод, «отвечает» — нет
      // вывода о блокировке (ТСПУ пропускает сам порт и режет уже рукопожатие или объём данных).
      const fromList = result.probes.map((p) => p.from).join(', ');
      title = confirmed
        ? `${BLOCK_VERDICT_LABELS[result.verdict]} · ${node.name}`
        : `Резко упал онлайн, порт отвечает · ${node.name}`;
      detail = confirmed
        ? `${dropLine} С российских серверов парка (${fromList}) порт ноды не отвечает совсем.`
        : `${dropLine} С серверов парка (${fromList}) порт ноды отвечает. Проверить блокировку ТСПУ и «16–20 КБ» не удалось: в Remnawave не нашлось имени маскировки этой ноды.`;
    } else {
      const fromList = result.probes.map((p) => p.from).join(', ');
      const perProbe = result.probes.map((p) => `${p.from} — ${p.detail}`).join('; ');
      title = confirmed
        ? `${BLOCK_VERDICT_LABELS[result.verdict]} · ${node.name}`
        : `Резко упал онлайн, блокировка не подтвердилась · ${node.name}`;
      detail = `${dropLine} Проверено с серверов парка: ${fromList}. Вывод: ${BLOCK_VERDICT_LABELS[result.verdict]}. Подробности по каждому серверу: ${perProbe}.`;
    }
    // Встречная проверка из-за рубежа: называем прямо, что показала — это главный довод за или против.
    if (result.foreign.length > 0) {
      const alive = result.foreign.filter((p) => p.verdict === 'ok').map((p) => p.from);
      const dead = result.foreign.filter((p) => p.verdict !== 'ok').map((p) => p.from);
      detail +=
        result.verdict === 'ip_block'
          ? ` Из-за рубежа порт отвечает (${alive.join(', ')}): сервер жив, закрыт именно путь из России — похоже на блокировку IP. Обычно помогает только смена IP.`
          : ` Из-за рубежа порт тоже не отвечает (${dead.join(', ')}): сервер, скорее всего, выключен, отключён хостером или арендодателем, либо закрыт firewall.`;
    }
    const row = await this.incidents.open({
      serverId: matched?.id ?? null,
      serverName: matched?.name ?? node.name,
      kind: 'node_blocked',
      severity: confirmed ? 'crit' : 'warn',
      title,
      detail,
      timeline: [{ at: new Date().toISOString(), by: 'auto', action: 'Обнаружено', result: 'detect' }],
    });
    // Раньше такой инцидент писался только в базу: ни колокольчика, ни Telegram. Сообщаем как обычный.
    if (row)
      await this.notifications.push({
        severity: confirmed ? 'crit' : 'warn',
        title,
        body: detail,
        // Сервер привязываем, только если нода есть в NodeService: у уведомления ссылка на запись сервера.
        server: matched ? { id: matched.id, name: matched.name, host: node.address } : null,
        link: { to: `/incidents/${row.id}`, label: 'Открыть инцидент' },
        telegram: { event: confirmed ? 'incident_crit' : 'incident_warn', incidentId: row.id },
      });
  }
}
