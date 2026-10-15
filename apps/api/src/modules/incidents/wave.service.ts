import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type IncidentEvent,
  type IncidentKind,
  type IncidentSnapshot,
  type RemnawaveNode,
  WAVE_KINDS,
  type WaveGroup,
  waveGroupOf,
} from '@nodeservice/shared';
import { localClock } from '../../common/local-time.js';
import { DEFAULT_TIME_ZONE, panelTimeZone } from '../../common/panel-time-zone.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import type { IncidentRow } from '../../infra/db/schema/index.js';
import { NotificationsService, type PushInput } from '../notifications/notifications.service.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { MonitoringStore } from '../settings/monitoring.store.js';
import { IncidentsRepository } from './incidents.repository.js';

type Fleet = NonNullable<IncidentSnapshot['fleet']>;
type Member = Fleet['members'][number];
type Wave = IncidentRow & { snapshot: IncidentSnapshot & { fleet: Fleet } };

/** Сообщение ноды: послать своё или его заменило сообщение волны. */
export type WaveVerdict = 'notify' | 'absorbed';

const isWaveKind = (kind: string) => (WAVE_KINDS as readonly string[]).includes(kind);
const isWave = (r: IncidentRow): r is Wave => r.kind === 'wave' && Boolean(r.snapshot?.fleet?.groupKey);
const event = (action: string, extra: Partial<IncidentEvent> = {}): IncidentEvent => ({
  at: new Date().toISOString(),
  by: 'auto',
  action,
  result: 'notify',
  ...extra,
});
/** «2 ноды», «5 нод». */
const nodesWord = (n: number) => {
  const m10 = n % 10,
    m100 = n % 100;
  return m10 === 1 && m100 !== 11
    ? 'нода'
    : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)
      ? 'ноды'
      : 'нод';
};
/** «нод провайдера Aeza» / «нод страны» — чья волна, словами. */
const whose = (f: Fleet) => (f.cause === 'country' ? 'нод страны' : 'нод провайдера');

/**
 * Волна (0.106.0, Н3): за короткое время упали несколько нод одного провайдера (у нод без провайдера — одной
 * страны). Вместо тревоги по каждой ноде — одно событие «Волна» и одно сообщение, которое дописывается новыми
 * нодами; в конце — одно «Волна закончилась». События нод остаются: на них держатся сценарии и история.
 */
@Injectable()
export class WaveService {
  private readonly log = new Logger(WaveService.name);
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly repo: IncidentsRepository,
    private readonly notifications: NotificationsService,
    private readonly remna: RemnawaveService,
    private readonly settings: MonitoringStore,
  ) {}

  private async clock() {
    const zone = (await panelTimeZone(this.db).catch(() => null)) ?? DEFAULT_TIME_ZONE;
    return (iso: string) => localClock(new Date(iso), zone);
  }

  /** Открытые волны и ноды в них (ещё не поднявшиеся) — для сценариев с исключением «нода в волне». */
  async nodesInWave(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const w of (await this.repo.list('open')).filter(isWave))
      for (const m of w.snapshot.fleet.members) if (m.nodeUuid && !m.upAt) out.set(m.nodeUuid, w.id);
    return out;
  }

  /**
   * Новое событие ноды. Есть открытая волна её группы — нода входит в неё, сообщение волны дописывается. Нет — а в
   * группе за окно упали ещё ноды (вместе не меньше порога) — начинается волна: одно сообщение вместо своего.
   */
  async onNodeOpened(node: RemnawaveNode, row: IncidentRow): Promise<WaveVerdict> {
    if (!isWaveKind(row.kind)) return 'notify';
    const cfg = await this.settings.get();
    if (!cfg.waveEnabled) return 'notify';
    const group = waveGroupOf(node);
    if (!group) return 'notify';
    const open = await this.repo.list('open');
    const wave = open.filter(isWave).find((w) => w.snapshot.fleet.groupKey === group.key);
    if (wave) return this.join(wave, node, row);
    const status = await this.remna.status();
    const byUuid = new Map(status.nodes.map((n) => [n.uuid, n]));
    const since = Date.now() - cfg.waveWindowMinutes * 60_000;
    // По ноде — её самое раннее открытое событие волны за окно: с него она «упала».
    const first = new Map<string, IncidentRow>([[node.uuid, row]]);
    for (const r of open) {
      if (!r.nodeUuid || !isWaveKind(r.kind) || r.openedAt.getTime() < since) continue;
      const n = byUuid.get(r.nodeUuid);
      if (!n || waveGroupOf(n)?.key !== group.key) continue;
      const prev = first.get(r.nodeUuid);
      if (!prev || r.openedAt < prev.openedAt) first.set(r.nodeUuid, r);
    }
    if (first.size < cfg.waveMinNodes) return 'notify';
    const total = status.nodes.filter((n) => !n.isDisabled && waveGroupOf(n)?.key === group.key).length;
    return this.form(
      group,
      [...first.values()],
      byUuid,
      Math.max(total, first.size),
      cfg.waveWindowMinutes,
      node,
      row,
    );
  }

  private member(r: IncidentRow, n: RemnawaveNode | undefined): Member {
    return {
      serverId: null,
      nodeUuid: r.nodeUuid,
      name: n?.name ?? r.serverName,
      baseline: null,
      incidentId: r.id,
      countryCode: n?.countryCode ?? null,
      downAt: r.openedAt.toISOString(),
      upAt: null,
    };
  }

  private async form(
    group: WaveGroup,
    rows: IncidentRow[],
    byUuid: Map<string, RemnawaveNode>,
    total: number,
    windowMinutes: number,
    node: RemnawaveNode,
    row: IncidentRow,
  ): Promise<WaveVerdict> {
    const members = rows
      .sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime())
      .map((r) => this.member(r, byUuid.get(r.nodeUuid ?? '')));
    const fleet: Fleet = {
      cause: group.cause,
      groupKey: group.key,
      groupLabel: group.label,
      members,
      total,
      formedAt: new Date().toISOString(),
    };
    const clock = await this.clock();
    const created = await this.repo.open({
      serverId: null,
      serverName: group.label,
      kind: 'wave' as IncidentKind,
      severity: 'crit',
      title: `Волна · ${group.label}`,
      detail: `За ${windowMinutes} мин упали ${members.length} из ${total} ${whose(fleet)} «${group.label}». ${fleet.cause === 'country' ? 'Похоже на общий сбой в этой стране.' : 'Похоже на сбой у провайдера, а не у самих нод.'}`,
      timeline: members.map((m, i) => ({
        at: m.downAt ?? new Date().toISOString(),
        by: 'auto' as const,
        action: i < members.length - 1 ? `${m.name} не на связи` : `${m.name} не на связи — началась волна`,
        result: 'notify' as const,
        tone: 'crit' as const,
        ...(i === members.length - 1
          ? {
              detail: `${members.length} ${nodesWord(members.length)} ${fleet.cause === 'country' ? 'страны' : 'провайдера'} за ${windowMinutes} мин: одно сообщение вместо отдельных.`,
            }
          : {}),
      })),
      snapshot: {
        cpu: null,
        mem: null,
        disk: null,
        node: null,
        agentStatus: null,
        agentVersion: null,
        fleet,
      },
    });
    if (!created) {
      // Волну этой группы только что завела параллельная обработка — входим в неё.
      const again = (await this.repo.list('open'))
        .filter(isWave)
        .find((w) => w.snapshot.fleet.groupKey === group.key);
      return again ? this.join(again, node, row) : 'notify';
    }
    for (const m of members)
      if (m.incidentId) await this.repo.appendTimeline(m.incidentId, this.joinedLine(group.label));
    await this.notifications.push(this.message(created.id, fleet, clock, windowMinutes));
    return 'absorbed';
  }

  private joinedLine(label: string): IncidentEvent {
    return event(`Входит в волну · ${label}`, {
      tone: 'info',
      detail:
        'Упали сразу несколько нод провайдера: по ноде отдельных сообщений нет — только об окончании волны.',
    });
  }

  /** Нода входит в открытую волну (или снова упала, уже будучи в ней). Сообщение волны дописывается. */
  private async join(wave: Wave, node: RemnawaveNode, row: IncidentRow): Promise<WaveVerdict> {
    const fleet = structuredClone(wave.snapshot.fleet);
    const known = fleet.members.find((m) => m.nodeUuid === node.uuid);
    if (known && !known.upAt) {
      // Второе событие той же лежащей ноды (например, порт после потери связи): нового в волне нет.
      await this.repo.appendTimeline(row.id, this.joinedLine(fleet.groupLabel ?? ''));
      return 'absorbed';
    }
    if (known) Object.assign(known, { incidentId: row.id, downAt: row.openedAt.toISOString(), upAt: null });
    else fleet.members.push(this.member(row, node));
    fleet.total = Math.max(fleet.total ?? 0, fleet.members.length);
    await this.repo.update(wave.id, { snapshot: { ...wave.snapshot, fleet } });
    await this.repo.appendTimeline(
      wave.id,
      event(known ? `${node.name} снова не на связи` : `${node.name} не на связи — добавлена в волну`, {
        tone: 'crit',
      }),
    );
    await this.repo.appendTimeline(row.id, this.joinedLine(fleet.groupLabel ?? ''));
    const clock = await this.clock();
    const cfg = await this.settings.get();
    const down = fleet.members.filter((m) => !m.upAt).length;
    await this.notifications.editIncident(this.message(wave.id, fleet, clock, cfg.waveWindowMinutes), {
      severity: 'crit',
      title: 'Ещё нода в волне',
      body: `${node.name} · с ${clock(row.openedAt.toISOString())}. Теперь не на связи ${down} из ${fleet.total}.`,
      telegram: { event: 'incident_crit', incidentId: wave.id, kind: 'wave', icon: '➕' },
    });
    return 'absorbed';
  }

  /** Сообщение волны: сколько из скольких, ноды со временем, что это значит. Его же правим, дописывая ноды. */
  private message(
    waveId: string,
    fleet: Fleet,
    clock: (iso: string) => string,
    windowMinutes: number,
  ): PushInput {
    const down = fleet.members.filter((m) => !m.upAt).length;
    const lines = fleet.members.map(
      (m) =>
        `• ${m.name} · с ${clock(m.downAt ?? '')}${m.upAt ? ` — снова на связи в ${clock(m.upAt)}` : ''}`,
    );
    const cause =
      fleet.cause === 'country'
        ? 'Похоже на общий сбой в этой стране: у нод не указан провайдер, поэтому они собраны по стране.'
        : 'Похоже на сбой у провайдера, а не у самих нод.';
    return {
      severity: 'crit',
      title: `Волна · ${fleet.groupLabel}`,
      body: [
        `Не на связи ${down} из ${fleet.total ?? fleet.members.length} ${whose(fleet)} (за ${windowMinutes} мин):`,
        ...lines,
        '',
        `${cause} По каждой ноде волны отдельных сообщений не будет — только об окончании волны.`,
        'Волна — когда за короткое время падают сразу несколько нод одного провайдера.',
      ].join('\n'),
      link: { to: `/incidents/${waveId}`, label: 'Открыть волну' },
      telegram: {
        event: 'incident_crit',
        incidentId: waveId,
        kind: 'wave',
        serverKey: `wave:${fleet.groupKey}`,
        server: null,
        awaitAnalysis: false,
        icon: '🌊',
        plain: true,
      },
    };
  }

  /**
   * Событие ноды закрылось. Нода в открытой волне — её «Восстановление» не шлём: в волне отмечаем, что она поднялась,
   * а когда поднимутся все — одно «Волна закончилась».
   */
  async onNodeResolved(row: IncidentRow): Promise<WaveVerdict> {
    if (!row.nodeUuid || !isWaveKind(row.kind)) return 'notify';
    const open = await this.repo.list('open');
    const wave = open
      .filter(isWave)
      .find((w) => w.snapshot.fleet.members.some((m) => m.nodeUuid === row.nodeUuid));
    if (!wave) return 'notify';
    await this.reconcile(wave, open);
    return 'absorbed';
  }

  /** Раз в проход наблюдения: волны, чьи ноды поднялись любым путём (вручную, обслуживание), — закрыть. */
  async reconcileAll(): Promise<void> {
    const open = await this.repo.list('open');
    for (const w of open.filter(isWave)) await this.reconcile(w, open);
  }

  private async reconcile(wave: Wave, open: IncidentRow[]): Promise<void> {
    const fleet = structuredClone(wave.snapshot.fleet);
    const now = new Date().toISOString();
    const risen: string[] = [];
    for (const m of fleet.members) {
      if (m.upAt || !m.nodeUuid) continue;
      const down = open.some(
        (r) => r.nodeUuid === m.nodeUuid && isWaveKind(r.kind) && r.status !== 'resolved',
      );
      if (down) continue;
      m.upAt = now;
      risen.push(m.name);
    }
    if (risen.length === 0) return;
    await this.repo.update(wave.id, { snapshot: { ...wave.snapshot, fleet } });
    for (const name of risen)
      await this.repo.appendTimeline(wave.id, event(`${name} снова на связи`, { tone: 'ok' }));
    if (fleet.members.some((m) => !m.upAt)) return;
    await this.finish(wave, fleet);
  }

  private async finish(wave: Wave, fleet: Fleet): Promise<void> {
    const clock = await this.clock();
    const started = Math.min(
      ...fleet.members.map((m) => Date.parse(m.downAt ?? wave.openedAt.toISOString())),
    );
    await this.repo.appendTimeline(
      wave.id,
      event('Все ноды снова на связи — волна закончилась', { tone: 'ok', step: 'close', result: 'resolved' }),
    );
    await this.repo.update(wave.id, { status: 'resolved', resolvedAt: new Date(), resolvedBy: 'auto' });
    await this.notifications.push({
      severity: 'ok',
      title: 'Волна закончилась',
      body: [
        `Все ноды волны «${fleet.groupLabel}» снова на связи: ${fleet.members.length} ${nodesWord(fleet.members.length)}.`,
        ...fleet.members.map((m) => `• ${m.name} — ${clock(m.downAt ?? '')}–${clock(m.upAt ?? '')}`),
      ].join('\n'),
      link: { to: `/incidents/${wave.id}`, label: 'Открыть волну' },
      telegram: {
        event: 'resolved',
        incidentId: wave.id,
        kind: 'wave',
        serverKey: `wave:${fleet.groupKey}`,
        server: null,
        lastedMs: Math.max(0, Date.now() - started),
        closed: { recovered: true },
        plain: true,
      },
    });
    this.log.log(`Волна «${fleet.groupLabel}» закончилась: ${fleet.members.length} нод`);
  }

  /** Сценарий с исключением «нода в волне» не сработал — видно в карточке волны (одна запись на сценарий и ноду). */
  async noteSkipped(
    waveId: string,
    entry: { ruleId: string; ruleName: string; nodeUuid: string },
  ): Promise<void> {
    const wave = await this.repo.findById(waveId);
    if (!wave?.snapshot?.fleet) return;
    const fleet = structuredClone(wave.snapshot.fleet);
    const skipped = fleet.skipped ?? [];
    if (skipped.some((s) => s.ruleId === entry.ruleId && s.nodeUuid === entry.nodeUuid)) return;
    fleet.skipped = [...skipped, entry];
    await this.repo.update(waveId, { snapshot: { ...wave.snapshot, fleet } });
  }
}
