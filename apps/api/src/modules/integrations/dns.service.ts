import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { IncidentEvent } from '@nodeservice/shared';
import { desc, eq, like } from 'drizzle-orm';
import { errorText } from '../../common/filters/problem-details.filter.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';
import { AuditService } from '../audit/audit.service.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { getJson } from '../remnawave/remnawave-client.js';
import { RemnawaveSettingsStore } from '../remnawave/remnawave-settings.store.js';
import { list, obj } from './dpi.service.js';
import { IntegrationsService } from './integrations.service.js';
export type DnsRecord = {
  id: string;
  provider: 'cloudflare' | 'regru';
  zone: string;
  zoneId: string;
  recordId: string;
  name: string;
  subname: string;
  type: string;
  content: string;
  ttl: number;
  nodes: { uuid: string; name: string; address: string }[];
};
@Injectable()
export class DnsService {
  private busy = false;
  private metadataLocks = new Map<string, Promise<void>>();
  private async updateMetadata<T>(key: string, update: () => Promise<T>): Promise<T> {
    const previous = this.metadataLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.metadataLocks.set(key, current);
    await previous;
    try {
      return await update();
    } finally {
      release();
      if (this.metadataLocks.get(key) === current) this.metadataLocks.delete(key);
    }
  }
  private locks = new Set<string>();
  private cache: { scope: string; at: number; data: Awaited<ReturnType<DnsService['load']>> } | null = null;
  constructor(
    @Inject(DB) private db: Db,
    private integrations: IntegrationsService,
    private store: RemnawaveSettingsStore,
    private remna: RemnawaveService,
    @Optional() private audit?: AuditService,
    @Optional() private incidents?: IncidentsService,
  ) {}
  /** Что уже написано в событие ноды по каждой записи: одна строка на состояние, а не на каждую минуту. */
  private noted = new Map<string, string>();
  /** Строка о DNS-записи в незакрытые события ноды; повтор того же состояния не пишется. */
  private async note(nodeUuid: string, key: string, e: Omit<IncidentEvent, 'at' | 'by' | 'result' | 'step'>) {
    const mark = `${nodeUuid}|${key}`,
      sign = `${e.action}|${e.detail ?? ''}`;
    if (!this.incidents || this.noted.get(mark) === sign) return;
    this.noted.set(mark, sign);
    if (this.noted.size > 500) this.noted.clear();
    await this.incidents
      .noteNode(nodeUuid, { at: new Date().toISOString(), by: 'auto', result: 'notify', step: 'dns', ...e })
      .catch(() => undefined);
  }
  private async read(key: string) {
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, key) });
    return row ? JSON.parse(row.value) : null;
  }
  private async write(key: string, value: unknown) {
    await this.db
      .insert(appMeta)
      .values({ key, value: JSON.stringify(value) })
      .onConflictDoUpdate({
        target: appMeta.key,
        set: { value: JSON.stringify(value), updatedAt: new Date() },
      });
  }
  private async scope() {
    const ids = await Promise.all(
      (['cloudflare', 'regru'] as const).map(async (p) =>
        (await this.integrations.status(p)).connected ? this.integrations.identity(p) : 'none',
      ),
    );
    return [await this.store.domain(), ...ids].join('.');
  }
  /**
   * Где лежат автозамена и связи «запись → нода»: по адресу панели Remnawave. До 0.94.0 ключ включал отпечаток
   * доступов провайдеров, и новый токен Cloudflare или отключённый REG.RU молча выключали автозамену. Записи и так
   * различаются провайдером, зоной и номером — чужой аккаунт с ними не совпадёт.
   */
  private async keyFor(kind: 'settings' | 'links') {
    const domain = await this.store.domain();
    const key = `dns.${kind}.${domain}`;
    if ((await this.read(key)) === null) await this.carryOver(kind, domain, key);
    return key;
  }
  /** Перенос со старых ключей: настройки — последние по времени, связи — все вместе (свежие поверх старых). */
  private async carryOver(kind: 'settings' | 'links', domain: string | null, key: string) {
    const rows = await this.db
      .select()
      .from(appMeta)
      .where(like(appMeta.key, `dns.${kind}.${domain}.%`))
      .orderBy(desc(appMeta.updatedAt));
    const [latest] = rows;
    if (!latest) return;
    const value =
      kind === 'settings'
        ? JSON.parse(latest.value)
        : Object.assign({}, ...rows.reverse().map((r) => JSON.parse(r.value)));
    await this.write(key, value);
  }
  async settings(): Promise<{ automaticNodes: string[]; automaticRecords: string[] }> {
    return { automaticNodes: [], automaticRecords: [], ...(await this.read(await this.keyFor('settings'))) };
  }
  private automatic(settings: { automaticNodes: string[]; automaticRecords: string[] }, record: DnsRecord) {
    return (
      settings.automaticRecords.includes(record.id) ||
      record.nodes.some((n) => settings.automaticNodes.includes(n.uuid))
    );
  }
  async setSettings(recordId: string, enabled: boolean) {
    const scope = await this.scope();
    const data = await this.overview();
    this.audit?.extend({
      metadata: {
        domain: data.records.find((r) => r.id === recordId)?.name ?? '—',
        autoreplace: enabled ? 'включена' : 'выключена',
      },
    });
    if (
      enabled &&
      !data.records.some((r) => r.id === recordId && ['A', 'AAAA'].includes(r.type) && r.nodes.length === 1)
    )
      throw new BadRequestException('Выберите A/AAAA-запись с одной связанной нодой.');
    const status = await this.remna.status();
    const key = await this.keyFor('settings');
    const settings = await this.updateMetadata(key, async () => {
      if (scope !== (await this.scope()))
        throw new BadRequestException('Подключение изменилось. Обновите список.');
      const current = await this.settings();
      if (current.automaticNodes.length && data.errors.length)
        throw new BadRequestException('Дождитесь загрузки всех DNS-провайдеров.');
      const ids = new Set([
        ...current.automaticRecords,
        ...data.records.filter((r) => this.automatic(current, r)).map((r) => r.id),
      ]);
      if (enabled) ids.add(recordId);
      else ids.delete(recordId);
      const next = { automaticNodes: [], automaticRecords: [...ids] };
      await this.write(key, next);
      return next;
    });
    const addressKey = `dns.addresses.${status.domain}`;
    await this.updateMetadata(addressKey, async () => {
      const previous = (await this.read(addressKey)) ?? {};
      await this.write(addressKey, {
        ...Object.fromEntries(status.nodes.map((n) => [n.uuid, n.address])),
        ...previous,
      });
    });
    this.cache = null;
    return settings;
  }
  async history() {
    const rows = await this.db
      .select()
      .from(appMeta)
      .where(like(appMeta.key, 'dns.event.%'))
      .orderBy(desc(appMeta.updatedAt))
      .limit(200);
    return { items: rows.map((r) => JSON.parse(r.value)) };
  }
  private async log(row: unknown) {
    await this.write(`dns.event.${randomUUID()}`, { at: new Date().toISOString(), ...obj(row) });
  }
  private async pages(path: string) {
    const all: Record<string, unknown>[] = [];
    for (let page = 1; page <= 100; page++) {
      const d = await this.integrations.providerRequest(
        'cloudflare',
        `${path + (path.includes('?') ? '&' : '?')}per_page=100&page=${page}`,
      );
      if (d.success !== true)
        throw new BadRequestException(
          'Cloudflare отклонил чтение. Проверьте Zone Read и DNS Read для нужных зон.',
        );
      all.push(...list(d.result));
      const total = Number(obj(d.result_info).total_pages ?? 1);
      if (page >= total) return all;
    }
    throw new BadRequestException('Слишком много страниц Cloudflare. Сузьте доступ токена к нужным зонам.');
  }
  private async load() {
    const c = await this.store.credentials();
    if (!c) throw new BadRequestException('Сначала подключите Remnawave.');
    const status = await this.remna.status();
    const raw = await getJson(`https://${c.domain}/api/hosts`, c.apiKey);
    const hosts = list(obj(raw.response).hosts ?? raw.response).filter(
      (h) => typeof h.address === 'string' && !isIP(String(h.address)),
    );
    const inferredKey = await this.keyFor('links');
    const inferred = (await this.read(inferredKey)) ?? {};
    const nextInferred = { ...inferred };
    const names = new Map<string, string[]>();
    for (const h of hosts) {
      const name = String(h.address).toLowerCase().replace(/\.$/, '');
      const ids = Array.isArray(h.nodes)
        ? h.nodes.map((n) => (typeof n === 'string' ? n : String(obj(n).uuid)))
        : [];
      names.set(name, [...new Set([...(names.get(name) ?? []), ...ids])]);
    }
    const records: DnsRecord[] = [];
    const errors: string[] = [];
    const domains: { name: string; provider: string; hosts: string[] }[] = [];
    for (const provider of ['cloudflare', 'regru'] as const) {
      if (!(await this.integrations.status(provider)).connected) continue;
      try {
        const zones =
          provider === 'cloudflare'
            ? await this.pages('/zones')
            : list((await this.integrations.reg('service/get_list', { servtype: 'domain' })).services);
        for (const z of zones) {
          const zone = String(z.name ?? z.dname ?? '').toLowerCase();
          const matches = [...names.keys()].filter((n) => n === zone || n.endsWith(`.${zone}`));

          const zoneId = String(z.id ?? zone);
          domains.push({ name: zone, provider, hosts: matches });
          const rows =
            provider === 'cloudflare'
              ? await this.pages(`/zones/${encodeURIComponent(zoneId)}/dns_records`)
              : list(
                  (await this.integrations.reg('zone/get_resource_records', { domains: [{ dname: zone }] }))
                    .domains,
                ).flatMap((d) => list(d.rrs));
          for (const r of rows) {
            const type = String(r.type ?? r.rectype).toUpperCase();
            const subname = String(r.subname ?? '@');
            const name =
              provider === 'cloudflare'
                ? String(r.name).toLowerCase()
                : subname === '@' || subname === ''
                  ? zone
                  : `${subname}.${zone}`;

            const content = String(r.content ?? '');
            const recordId = String(r.id ?? [subname, type, content].join(':'));
            const binding = [provider, zoneId, recordId].join('|');
            const explicit = names.get(name) ?? [];
            const sameAddress = ['A', 'AAAA'].includes(type)
              ? status.nodes.filter((n) => n.address === content)
              : [];
            const linked = inferred[binding]
              ? [inferred[binding]]
              : explicit.length
                ? explicit
                : sameAddress.length === 1
                  ? [sameAddress[0]?.uuid]
                  : [];
            if (!explicit.length && !inferred[binding] && linked.length === 1)
              nextInferred[binding] = linked[0];
            records.push({
              id: [provider, zoneId, recordId].join('|'),
              provider,
              zone,
              zoneId,
              recordId,
              name,
              subname,
              type,
              content,
              ttl: Number(r.ttl ?? 600),
              nodes: status.nodes
                .filter((n) => linked.includes(n.uuid))
                .map((n) => ({ uuid: n.uuid, name: n.name, address: n.address })),
            });
          }
        }
      } catch {
        errors.push(
          provider === 'cloudflare'
            ? 'Cloudflare: не удалось прочитать зоны или записи. Проверьте Zone Read и DNS Read.'
            : 'REG.RU: не удалось прочитать домены или записи. Проверьте доступ к API.',
        );
      }
    }
    if (JSON.stringify(inferred) !== JSON.stringify(nextInferred))
      await this.updateMetadata(inferredKey, async () => {
        await this.write(inferredKey, { ...nextInferred, ...((await this.read(inferredKey)) ?? {}) });
      });
    return {
      domains,
      records,
      unmanaged: [...names.keys()].filter((n) => !domains.some((d) => d.hosts.includes(n))),
      errors,
      checkedAt: new Date().toISOString(),
    };
  }
  async overview(force = false) {
    const scope = await this.scope();
    let cache = this.cache;
    if (force || !cache || cache.scope !== scope || Date.now() - cache.at > 30000)
      cache = { scope, at: Date.now(), data: await this.load() };
    if (scope !== (await this.scope()))
      throw new BadRequestException('Подключение изменилось. Обновите страницу.');
    this.cache = cache;
    return { ...cache.data, settings: await this.settings() };
  }
  async apply(
    body: { recordId: string; nodeUuid: string; expected: string },
    automatic = false,
    expectedScope?: string,
  ) {
    if (this.locks.has(body.recordId))
      throw new BadRequestException('Эта запись уже обновляется. Дождитесь результата.');
    this.locks.add(body.recordId);
    try {
      return await this.applyLocked(body, automatic, expectedScope);
    } finally {
      this.locks.delete(body.recordId);
    }
  }
  private async applyLocked(
    body: { recordId: string; nodeUuid: string; expected: string },
    automatic: boolean,
    expectedScope?: string,
  ) {
    const scope = expectedScope ?? (await this.scope());
    if (scope !== (await this.scope()))
      throw new BadRequestException('Подключение изменилось. Обновите список.');
    const data = await this.overview(true);
    const record = data.records.find((r) => r.id === body.recordId);
    const node = automatic
      ? record?.nodes.find((n) => n.uuid === body.nodeUuid)
      : (await this.remna.status()).nodes.find((n) => n.uuid === body.nodeUuid);
    if (!record || !node) throw new BadRequestException('Связь записи и ноды изменилась. Обновите список.');
    if (record.content !== body.expected)
      throw new BadRequestException('DNS-запись уже изменилась. Обновите список перед заменой.');
    if (!['A', 'AAAA'].includes(record.type))
      throw new BadRequestException('Замена IP доступна только для A/AAAA.');
    if (!isIP(node.address) || isIP(node.address) !== (record.type === 'A' ? 4 : 6))
      throw new BadRequestException('Адрес ноды должен соответствовать типу A / AAAA.');
    const session = await this.integrations.session(record.provider);
    if (scope !== (await this.scope()))
      throw new BadRequestException('Подключение изменилось. Обновите список.');
    if (automatic && !this.automatic(await this.settings(), record))
      throw new BadRequestException('Автоматическое обновление этой записи выключено.');
    const remember = async () => {
      const key = await this.keyFor('links');
      const id =
        record.provider === 'cloudflare'
          ? record.id
          : [record.provider, record.zoneId, [record.subname, record.type, node.address].join(':')].join('|');
      await this.updateMetadata(key, async () => {
        const links = (await this.read(key)) ?? {};
        await this.write(key, { ...links, [id]: node.uuid });
      });
      if (id !== record.id) {
        const settingsKey = await this.keyFor('settings');
        await this.updateMetadata(settingsKey, async () => {
          const settings = { automaticNodes: [], automaticRecords: [], ...(await this.read(settingsKey)) };
          if (settings.automaticRecords.includes(record.id)) {
            settings.automaticRecords = settings.automaticRecords.map((value: string) =>
              value === record.id ? id : value,
            );
            await this.write(settingsKey, settings);
          }
        });
      }
      this.cache = null;
    };
    // Что и где поменяли — для «Журнала» (адреса и имя ноды, без внутренних номеров записи).
    const what = { domain: record.name, from: record.content, to: node.address, nodeName: node.name };
    if (node.address === record.content) {
      await remember();
      return { changed: false, ...what };
    }
    let partial = false;
    const change = {
      domain: record.name,
      provider: record.provider,
      old: record.content,
      next: node.address,
      automatic,
    };
    try {
      if (record.provider === 'cloudflare') {
        const result = await this.integrations.providerRequest(
          'cloudflare',
          '/zones/' +
            encodeURIComponent(record.zoneId) +
            '/dns_records/' +
            encodeURIComponent(record.recordId),
          'PATCH',
          { content: node.address },
          undefined,
          session,
        );
        if (result.success !== true) throw new Error('Provider refused');
      } else {
        if (
          !data.records.some(
            (r) =>
              r.provider === record.provider &&
              r.name === record.name &&
              r.type === record.type &&
              r.content === node.address,
          )
        )
          await this.integrations.reg(
            record.type === 'A' ? 'zone/add_alias' : 'zone/add_aaaa',
            {
              domains: [{ dname: record.zone }],
              subdomain: record.subname,
              ipaddr: node.address,
              ttl: record.ttl,
            },
            session,
          );
        const verified = await this.overview(true);
        if (
          !verified.records.some(
            (r) =>
              r.provider === record.provider &&
              r.name === record.name &&
              r.type === record.type &&
              r.content === node.address,
          )
        )
          throw new BadRequestException(
            'Новая запись не подтверждена. Старая запись сохранена. Проверьте REG.RU.',
          );
        try {
          await this.integrations.reg(
            'zone/remove_record',
            {
              domains: [{ dname: record.zone }],
              subdomain: record.subname,
              record_type: record.type,
              content: record.content,
            },
            session,
          );
        } catch {
          partial = true;
          throw new BadRequestException(
            'Новая запись добавлена, старая не удалена. Проверьте обе записи в REG.RU перед повтором.',
          );
        }
      }
      await remember();
      await this.log({ ...change, status: 'success' });
      this.cache = null;
      if (!automatic)
        await this.note(node.uuid, record.id, {
          action: `DNS-запись ${record.name} обновлена вручную`,
          tone: 'ok',
          detail: `${record.content} → ${node.address}`,
        });
      return { changed: true, ...what };
    } catch (e) {
      await this.log({ ...change, status: partial ? 'partial' : 'error' });
      this.cache = null;
      throw e;
    }
  }
  @Interval(60000) async tick() {
    if (process.env.NODE_ENV !== 'test') await this.runTick();
  }
  /**
   * Раз в минуту: адрес ноды в Remnawave сменился — записи с автозаменой обновляются, и каждый шаг (запись уже на
   * новом адресе, обновлена, не вышло, автозамена не включена) пишется в незакрытое событие этой ноды.
   */
  async runTick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const status = await this.remna.status();
      if (!status.connected || status.error) return;
      const scope = await this.scope();
      const settings = await this.settings();
      const key = `dns.addresses.${status.domain}`;
      const previous = (await this.read(key)) ?? {};
      const next = { ...previous };
      for (const n of status.nodes) {
        const old = previous[n.uuid];
        if (old && old !== n.address) {
          if (scope !== (await this.scope())) break;
          const data = await this.overview(true);
          if (data.errors.length) {
            await this.note(n.uuid, 'read', {
              action: 'Не удалось прочитать DNS-записи ноды',
              tone: 'crit',
              detail: `${data.errors.join(' ')} Повторю через минуту.`,
              link: { label: 'Открыть DNS-интеграции', to: '/integrations/dns' },
            });
            continue;
          }
          const linked = data.records.filter(
            (r) => ['A', 'AAAA'].includes(r.type) && r.nodes.some((node) => node.uuid === n.uuid),
          );
          if (!linked.length && data.domains.length)
            await this.note(n.uuid, 'none', {
              action: 'В подключённых DNS-сервисах нет записей этой ноды',
              tone: 'info',
            });
          let failed = false;
          for (const r of linked) {
            const open = {
              label: 'Открыть запись в DNS-интеграциях',
              to: '/integrations/dns',
              search: { record: r.id },
            };
            if (r.content === n.address) {
              await this.note(n.uuid, r.id, {
                action: `DNS-запись ${r.name} уже ведёт на новый адрес`,
                tone: 'ok',
              });
              continue;
            }
            if (r.content !== old) {
              await this.note(n.uuid, r.id, {
                action: `DNS-запись ${r.name} ведёт на другой адрес: ${r.content}`,
                tone: 'warn',
                detail: 'Это не прежний и не новый адрес ноды — проверьте, нужна ли запись.',
                link: open,
              });
              continue;
            }
            if (!this.automatic(settings, r) || !r.nodes.every((node) => node.address === n.address)) {
              await this.note(n.uuid, r.id, {
                action: `DNS-запись ${r.name} ведёт на старый адрес`,
                tone: 'warn',
                detail: `Автозамена для этой записи не включена. Замените ${old} на ${n.address} вручную или включите автозамену — дальше событие закроется само.`,
                link: open,
              });
              continue;
            }
            try {
              await this.apply({ recordId: r.id, nodeUuid: n.uuid, expected: r.content }, true, scope);
              await this.note(n.uuid, r.id, {
                action: `DNS-запись ${r.name} обновлена автоматически`,
                tone: 'ok',
                detail: `${old} → ${n.address}`,
              });
            } catch (e) {
              failed = true;
              const why = errorText(e);
              await this.note(n.uuid, r.id, {
                action: `Не удалось обновить DNS-запись ${r.name}`,
                tone: 'crit',
                detail: `${/[А-Яа-яЁё]/.test(why) ? why : 'DNS-сервис отклонил изменение.'} Повторю через минуту; запись можно заменить вручную.`,
                link: open,
              });
            }
          }
          if (failed) continue;
        }
        next[n.uuid] = n.address;
      }
      await this.write(key, next);
    } catch {
    } finally {
      this.busy = false;
    }
  }
}
