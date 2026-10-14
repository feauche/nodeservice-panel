import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type NodeConnections,
  REMNAWAVE_CERT_CHECK_INTERVAL_MIN,
  REMNAWAVE_PROBLEM,
  type RemnawaveConnectRequest,
  type RemnawaveStatus,
} from '@nodeservice/shared';

import { errorText, problem } from '../../common/filters/problem-details.filter.js';
import type { Env } from '../../config/env.schema.js';
import { AuditService } from '../audit/audit.service.js';
import { EventsService } from '../events/events.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { NodeRatesStore } from './node-rates.store.js';
import {
  getJson,
  REMNAWAVE_CLIENT,
  RemnawaveApiError,
  type RemnawaveClient,
  type RemnawaveNodeInbound,
} from './remnawave-client.js';
import { RemnawaveSettingsStore } from './remnawave-settings.store.js';
import { expandSnippets, type RemnawaveSnippet, snippetRefs } from './remnawave-snippets.js';

/** Remnawave не отвечает столько подряд — сообщение в Telegram и колокольчик. */
const REMNAWAVE_OUTAGE_NOTIFY_MS = 2 * 60_000;
/** Статусы нод одной строкой: на связи, выключена, подключается. Онлайн и метрики сюда не входят. */
export function nodeStatusKey(
  nodes: { uuid: string; isConnected: boolean; isDisabled: boolean; isConnecting?: boolean }[],
): string {
  return nodes
    .map((n) => `${n.uuid}:${Number(n.isConnected)}${Number(n.isDisabled)}${Number(Boolean(n.isConnecting))}`)
    .sort()
    .join('|');
}

const HIDDEN = '[скрыто]';
const SECRET_FIELDS = new Set([
  'accesskey',
  'apikey',
  'auth',
  'authorization',
  'certificate',
  'certificates',
  'email',
  'id',
  'key',
  'password',
  'passwd',
  'presharedkey',
  'privatekey',
  'publickey',
  'secret',
  'secretkey',
  'seed',
  'mldsa65seed',
  'shortid',
  'shortids',
  'token',
  'uuid',
]);
const PRIVATE_LISTS = new Set(['clients', 'users']);

/** Конфиг Remnawave недоверенный и может содержать доступы: до LLM доходит только безопасная копия. */
export function sanitizeRemnawaveProfile(value: unknown, field = '', depth = 0): unknown {
  const key = field.toLowerCase().replace(/[_-]/g, '');
  if (PRIVATE_LISTS.has(key) && Array.isArray(value)) return { hidden: true, count: value.length };
  if (SECRET_FIELDS.has(key)) return value === null || value === undefined ? value : HIDDEN;
  if (depth >= 12) return '[слишком глубокая структура]';
  if (typeof value === 'string') {
    if (/^(?:vless|vmess|trojan|ss|hysteria2|hy2):\/\//i.test(value)) return HIDDEN;
    const clean = value
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, HIDDEN)
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, HIDDEN);
    return clean.length > 2_000 ? `${clean.slice(0, 2_000)}…` : clean;
  }
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => sanitizeRemnawaveProfile(item, '', depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([name, item]) => [name, sanitizeRemnawaveProfile(item, name, depth + 1)]),
  );
}

/** YAML-шаблон подписки (Mihomo, Clash, Stash) — строки «ключ: значение» с паролями и ключами скрываются. */
export function sanitizeTemplateYaml(yaml: string): string {
  return yaml
    .split('\n')
    .slice(0, 600)
    .map((line) =>
      line.replace(
        /^(\s*-?\s*(?:password|passwd|uuid|private-key|privatekey|public-key|short-id|token|secret|auth|auth-str|psk|pre-shared-key|obfs-password|server-key)\s*:\s*).+$/i,
        `$1${HIDDEN}`,
      ),
    )
    .map((line) => sanitizeRemnawaveProfile(line) as string)
    .join('\n');
}

/** Права ключа, без которых часть данных Remnawave не прочитать: причина по-русски. */
function readError(err: unknown, what: string, scope: string): string {
  if (err instanceof RemnawaveApiError && err.status === 403)
    return `Нет права читать ${what}: добавьте ключу Remnawave право ${scope} («Ноды» → «Настроить подключение» → «Права ключа»).`;
  if (err instanceof RemnawaveApiError && err.status === 404)
    return `Эта версия Remnawave не отдаёт ${what} (сниппеты и внешние сквады появились в Remnawave 2.2).`;
  if (err instanceof RemnawaveApiError && err.kind === 'unauthorized')
    return 'Remnawave не приняла ключ: он неверный, отозван или просрочен.';
  return err instanceof Error ? err.message : `Не удалось прочитать ${what}.`;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? (value.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : [];

function profileTags(row: Record<string, unknown>): string[] {
  return Array.isArray(row.tags)
    ? row.tags
        .map((tag) => (typeof tag === 'string' ? tag : text((tag as Record<string, unknown>)?.name)))
        .filter(Boolean)
        .slice(0, 20)
    : [];
}

function inboundBrief(row: Record<string, unknown>): Record<string, unknown> {
  const stream = (row.streamSettings ?? {}) as Record<string, unknown>;
  return {
    tag: text(row.tag) || null,
    protocol: text(row.protocol) || text(row.type) || null,
    port: typeof row.port === 'number' ? row.port : null,
    network: text(row.network) || text(stream.network) || null,
    security: text(row.security) || text(stream.security) || null,
  };
}

function nodeProfileBrief(row: Record<string, unknown>): Record<string, unknown> {
  const config = (row.config ?? {}) as Record<string, unknown>;
  const inbounds = records(config.inbounds).length ? records(config.inbounds) : records(row.inbounds);
  return {
    name: text(row.name) || 'Без имени',
    tags: profileTags(row),
    inbounds: inbounds.map(inboundBrief),
    nodes: records(row.nodes)
      .map((node) => text(node.name))
      .filter(Boolean),
    updatedAt: text(row.updatedAt) || null,
  };
}

function templateBrief(row: Record<string, unknown>): Record<string, unknown> {
  return {
    name: text(row.name) || 'Без имени',
    tags: profileTags(row),
    type: text(row.templateType) || 'XRAY_JSON',
    updatedAt: text(row.updatedAt) || null,
  };
}

@Injectable()
export class RemnawaveService {
  private readonly log = new Logger(RemnawaveService.name);
  /** Когда последний раз проверяли сертификат панели (0 — ещё не проверяли после запуска). */
  private certCheckedAt = 0;

  constructor(
    private readonly store: RemnawaveSettingsStore,
    @Inject(REMNAWAVE_CLIENT) private readonly client: RemnawaveClient,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
    private readonly notifications: NotificationsService,
    @Optional() private readonly events?: EventsService,
    @Optional() private readonly rates?: NodeRatesStore,
  ) {}
  /** Идущая перепроверка: второй вызов ждёт её, а не запускает параллельную запись снимка. */
  private syncing: Promise<void> | null = null;

  /** J10: SNI и порт ноды для проверки блокировки — только когда проверка реально запускается. */
  async nodeInbound(nodeUuid: string): Promise<RemnawaveNodeInbound | null> {
    const creds = await this.store.credentials();
    if (!creds) return null;
    try {
      return await this.client.findNodeInbound(creds.domain, creds.apiKey, nodeUuid);
    } catch (err) {
      this.log.warn(`Инбаунд ноды ${nodeUuid}: ${err instanceof Error ? err.message : err}`);
      // Запрос не прошёл — порт неизвестен. Причина «в Remnawave не нашёлся порт» здесь была бы неправдой.
      return { sni: null, port: null, protocol: null, network: null, failed: true };
    }
  }

  /**
   * Подключения ноды с портами и именами SNI — для проверок снаружи (BS Checker из события и из формы).
   * Нет ключа или нода пропала — пустой список; Remnawave не ответила — failed, а не «подключений нет».
   */
  async nodeConnections(nodeUuid: string): Promise<NodeConnections> {
    const creds = await this.store.credentials();
    if (!creds) return { items: [], primary: null, failed: false };
    try {
      const found = await this.client.listNodeConnections(creds.domain, creds.apiKey, nodeUuid);
      return { items: found?.items ?? [], primary: found?.primary ?? null, failed: false };
    } catch (err) {
      this.log.warn(`Подключения ноды ${nodeUuid}: ${err instanceof Error ? err.message : err}`);
      return { items: [], primary: null, failed: true };
    }
  }

  /**
   * Каталог или безопасное содержимое для Ассистента: профили нод (сниппеты раскрыты, как при сборке конфига ноды),
   * сниппеты, шаблоны подписки всех видов. Никаких изменений в Remnawave; секреты скрыты до передачи модели.
   */
  async profilesForAssistant(input: { kind?: unknown; profile?: unknown }): Promise<Record<string, unknown>> {
    const creds = await this.store.credentials();
    if (!creds)
      return {
        connected: false,
        error: 'Remnawave не подключена. Подключить можно в «Ноды» → «Настроить подключение».',
      };

    try {
      const [catalog, snippetsRead] = await Promise.all([
        this.client.listProfiles(creds.domain, creds.apiKey),
        this.client.listSnippets(creds.domain, creds.apiKey).then(
          (list) => ({ list, error: null as string | null }),
          (err: unknown) => ({
            list: [] as RemnawaveSnippet[],
            error: readError(err, 'сниппеты', 'snippets:read'),
          }),
        ),
      ]);
      const snippets = snippetsRead.list;
      const templates = catalog.templates ?? catalog.xrayJson;
      const kinds = ['node', 'snippet', 'template', 'xray_json'] as const;
      const requestedKind = kinds.find((k) => k === input.kind) ?? null;
      const selector = typeof input.profile === 'string' ? input.profile.trim() : '';
      const usedBy = (name: string) =>
        catalog.node
          .filter((row) => snippetRefs(row.config).includes(name))
          .map((row) => text(row.name) || 'Без имени');
      if (!selector)
        return {
          connected: true,
          nodeProfiles: catalog.node.map((row) => ({
            ...nodeProfileBrief(row),
            snippets: snippetRefs(row.config),
          })),
          snippets: snippets.map((sn) => ({
            name: sn.name,
            items: Array.isArray(sn.snippet) ? sn.snippet.length : 1,
            usedBy: usedBy(sn.name),
          })),
          ...(snippetsRead.error ? { snippetsError: snippetsRead.error } : {}),
          subscriptionTemplates: templates.map(templateBrief),
          note: 'Это каталог без секретов. Чтобы прочитать одно целиком, вызовите инструмент снова с kind и profile. node — конфигурация Xray на нодах (сниппеты в ней раскрыты, вставленное помечено _fromSnippet); snippet — общий кусок конфига; template — шаблон подписки клиента (xray_json — только Xray JSON).',
        };

      const choices = [
        ...(requestedKind && requestedKind !== 'node'
          ? []
          : catalog.node.map((row) => ({ kind: 'node' as const, row }))),
        ...(requestedKind && requestedKind !== 'snippet'
          ? []
          : snippets.map((sn) => ({
              kind: 'snippet' as const,
              row: { name: sn.name } as Record<string, unknown>,
            }))),
        ...(requestedKind && requestedKind !== 'template' && requestedKind !== 'xray_json'
          ? []
          : (requestedKind === 'xray_json' ? catalog.xrayJson : templates).map((row) => ({
              kind: 'template' as const,
              row,
            }))),
      ];
      const query = selector.toLowerCase();
      const exact = choices.filter(
        ({ row }) => text(row.uuid).toLowerCase() === query || text(row.name).toLowerCase() === query,
      );
      const matches = exact.length
        ? exact
        : choices.filter(({ row }) => text(row.name).toLowerCase().includes(query));
      if (matches.length !== 1)
        return {
          connected: true,
          error:
            matches.length === 0
              ? `«${selector}» не найдено среди профилей, сниппетов и шаблонов.`
              : `Название «${selector}» неоднозначно. Уточните полное имя и вид (kind).`,
          available: choices
            .slice(0, 80)
            .map(({ kind, row }) => ({ kind, name: text(row.name) || 'Без имени' })),
        };

      const selected = matches[0] as { kind: 'node' | 'snippet' | 'template'; row: Record<string, unknown> };
      if (selected.kind === 'snippet') {
        const sn = snippets.find((x) => x.name === text(selected.row.name)) as RemnawaveSnippet;
        return {
          connected: true,
          kind: 'snippet',
          name: sn.name,
          usedBy: usedBy(sn.name),
          content: sanitizeRemnawaveProfile(sn.snippet),
          how: 'Профиль ссылается на сниппет объектом {"snippet": "имя"} в outbounds, routing.rules или routing.balancers: Remnawave ставит его содержимое на место ссылки при сборке конфига ноды. Корневой список "snippets" дописывает ключи сниппета в корень конфига.',
          safety: 'Только чтение. Ключи, пароли, UUID и токены скрыты.',
        };
      }
      const uuid = text(selected.row.uuid);
      if (!uuid)
        return {
          connected: true,
          error: 'Remnawave вернула запись без идентификатора; прочитать её нельзя.',
        };
      const full = await this.client.getProfile(
        creds.domain,
        creds.apiKey,
        selected.kind === 'node' ? 'node' : 'xray_json',
        uuid,
      );
      if (selected.kind === 'node') {
        const expanded = expandSnippets(full.config ?? full, snippets);
        return {
          connected: true,
          kind: 'node',
          name: text(full.name) || text(selected.row.name) || 'Без имени',
          tags: profileTags(full),
          config: sanitizeRemnawaveProfile(expanded.config),
          snippetsUsed: expanded.used,
          ...(expanded.missing.length
            ? {
                missingSnippets: expanded.missing,
                missingNote:
                  'Этих сниппетов нет в Remnawave: при сборке конфига ноды она молча выбрасывает такие ссылки — соответствующих выходов или правил на ноде нет.',
              }
            : {}),
          ...(snippetsRead.error ? { snippetsError: snippetsRead.error } : {}),
          safety:
            'Только чтение. Сниппеты раскрыты, вставленное помечено _fromSnippet. UUID пользователей, email, ключи, пароли, токены, сертификаты и списки клиентов скрыты.',
        };
      }
      const type = text(full.templateType) || text(selected.row.templateType) || 'XRAY_JSON';
      let content: unknown;
      if (typeof full.templateJson === 'string') {
        try {
          content = sanitizeRemnawaveProfile(JSON.parse(full.templateJson));
        } catch {
          content = '[Remnawave вернула шаблон не в формате JSON; содержимое скрыто]';
        }
      } else if (full.templateJson && typeof full.templateJson === 'object') {
        content = sanitizeRemnawaveProfile(full.templateJson);
      } else if (typeof full.encodedTemplateYaml === 'string') {
        content = sanitizeTemplateYaml(Buffer.from(full.encodedTemplateYaml, 'base64').toString('utf8'));
      } else {
        content = null;
      }
      return {
        connected: true,
        kind: 'template',
        type,
        name: text(full.name) || text(selected.row.name) || 'Без имени',
        tags: profileTags(full),
        config: content,
        safety: 'Только чтение. Пароли, ключи, UUID и токены скрыты.',
      };
    } catch (err) {
      if (err instanceof RemnawaveApiError && err.kind === 'unauthorized')
        return {
          connected: true,
          error:
            'Remnawave запретила чтение профилей. Токен мог быть отозван либо ему не хватает прав чтения list/get для config-profiles и subscription-template.',
        };
      return {
        connected: true,
        error: err instanceof Error ? err.message : 'Не удалось прочитать профили Remnawave.',
      };
    }
  }

  /** Сквады Remnawave для Ассистента: кому какие инбаунды выданы и сколько в группе людей. Без rawInbound и секретов. */
  async squadsForAssistant(): Promise<Record<string, unknown>> {
    const creds = await this.store.credentials();
    if (!creds) return { connected: false, error: 'Remnawave не подключена.' };
    try {
      const squads = await this.client.listSquads(creds.domain, creds.apiKey);
      const info = (row: Record<string, unknown>) => (row.info ?? {}) as Record<string, unknown>;
      return {
        connected: true,
        internal: squads.internal.slice(0, 100).map((row) => ({
          name: text(row.name) || 'Без имени',
          tags: profileTags(row),
          members: typeof info(row).membersCount === 'number' ? info(row).membersCount : null,
          inbounds: records(row.inbounds).map((ib) => ({
            tag: text(ib.tag) || null,
            type: text(ib.type) || null,
            network: text(ib.network) || null,
            security: text(ib.security) || null,
            port: typeof ib.port === 'number' ? ib.port : null,
          })),
        })),
        external: squads.external.slice(0, 100).map((row) => ({
          name: text(row.name) || 'Без имени',
          tags: profileTags(row),
          members: typeof info(row).membersCount === 'number' ? info(row).membersCount : null,
          templates: records(row.templates)
            .map((t) => text(t.templateType))
            .filter(Boolean),
          settings: sanitizeRemnawaveProfile({
            subscriptionSettings: row.subscriptionSettings ?? null,
            hostOverrides: row.hostOverrides ?? null,
            hwidSettings: row.hwidSettings ?? null,
            customRemarks: row.customRemarks ?? null,
          }),
        })),
        note: 'Внутренний сквад — какие инбаунды (подключения) выданы группе пользователей; у пользователя может быть несколько. Внешний сквад — шаблоны и настройки подписки группы.',
      };
    } catch (err) {
      return {
        connected: true,
        error: readError(err, 'сквады', 'internal-squads:read и external-squads:read'),
      };
    }
  }

  /**
   * Пользователь Remnawave по имени для Ассистента (вариант A владельца): статус, срок, трафик, сквады, устройства,
   * когда был онлайн. Ссылка подписки, ключи, пароли, UUID, почта и Telegram ID не передаются — белый список полей.
   */
  async userForAssistant(username: unknown): Promise<Record<string, unknown>> {
    const name = typeof username === 'string' ? username.trim() : '';
    if (!name) return { error: 'Укажите имя пользователя (username) так, как оно записано в Remnawave.' };
    const creds = await this.store.credentials();
    if (!creds) return { connected: false, error: 'Remnawave не подключена.' };
    try {
      const user = await this.client.userByUsername(creds.domain, creds.apiKey, name);
      if (!user)
        return {
          connected: true,
          found: false,
          error: `Пользователя «${name}» нет. Имя ищется точно — уточните его у владельца (как в Remnawave, с регистром).`,
        };
      const traffic = (user.userTraffic ?? {}) as Record<string, unknown>;
      const lastNode = (user.lastConnectedNode ?? {}) as Record<string, unknown>;
      const num = (v: unknown) =>
        typeof v === 'number'
          ? v
          : typeof v === 'string' && v !== '' && Number.isFinite(Number(v))
            ? Number(v)
            : null;
      // Remnawave 3.x называет идентификатор пользователя id (число), раньше — uuid (строка).
      const userUuid =
        text(user.uuid) ||
        (typeof user.id === 'number' || typeof user.id === 'string' ? String(user.id) : '');
      const lastNodeUuid = text(traffic.lastConnectedNodeUuid);
      const lastNodeName =
        text(lastNode.nodeName) ||
        (lastNodeUuid
          ? ((await this.status()).nodes.find((n) => n.uuid === lastNodeUuid)?.name ?? null)
          : null);
      const [devices, squads] = await Promise.all([
        userUuid ? this.client.userDevices(creds.domain, creds.apiKey, userUuid) : Promise.resolve(null),
        user.externalSquadUuid
          ? this.client.listSquads(creds.domain, creds.apiKey).catch(() => null)
          : Promise.resolve(null),
      ]);
      const external = squads?.external.find((sq) => text(sq.uuid) === text(user.externalSquadUuid));
      return {
        connected: true,
        found: true,
        user: {
          username: text(user.username),
          status: text(user.status) || null,
          expireAt: text(user.expireAt) || null,
          createdAt: text(user.createdAt) || null,
          trafficLimitBytes: num(user.trafficLimitBytes),
          trafficLimitStrategy: text(user.trafficLimitStrategy) || null,
          usedTrafficBytes: num(traffic.usedTrafficBytes ?? user.usedTrafficBytes),
          lifetimeUsedTrafficBytes: num(traffic.lifetimeUsedTrafficBytes ?? user.lifetimeUsedTrafficBytes),
          onlineAt: text(traffic.onlineAt ?? user.onlineAt) || null,
          firstConnectedAt: text(traffic.firstConnectedAt ?? user.firstConnectedAt) || null,
          lastConnectedNode: lastNodeName || null,
          subLastOpenedAt: text(user.subLastOpenedAt) || null,
          subLastUserAgent: (sanitizeRemnawaveProfile(text(user.subLastUserAgent)) as string) || null,
          internalSquads: records(user.activeInternalSquads)
            .map((sq) => text(sq.name))
            .filter(Boolean),
          externalSquad: external ? text(external.name) || null : null,
          hwidDeviceLimit: num(user.hwidDeviceLimit),
          hwidDevices: devices,
          tag: text(user.tag) || null,
          description: (sanitizeRemnawaveProfile(text(user.description)) as string) || null,
        },
        hint: 'trafficLimitBytes 0 — без лимита. status: ACTIVE — работает, DISABLED — выключен, LIMITED — исчерпан трафик, EXPIRED — истёк срок. hwidDevices null — устройства не прочитаны (нет права hwid:read).',
        safety: 'Ссылка подписки, ключи, пароли, UUID, почта и Telegram ID пользователя не передаются.',
      };
    } catch (err) {
      return { connected: true, error: readError(err, 'пользователей', 'users:read') };
    }
  }

  async status(): Promise<RemnawaveStatus> {
    const domain = await this.store.domain();
    if (!domain)
      return {
        connected: false,
        domain: null,
        checkedAt: null,
        lastAttemptAt: null,
        error: null,
        stats: null,
        nodes: [],
        cert: null,
      };
    const snap = await this.store.snapshot();
    return {
      connected: true,
      domain,
      checkedAt: snap?.checkedAt ?? null,
      lastAttemptAt: snap?.lastAttemptAt ?? snap?.checkedAt ?? null,
      error: snap?.error ?? null,
      stats: snap?.stats ?? null,
      // Скорость — за последнюю минуту по счётчикам ноды (как на графике), а не секундный снимок Remnawave.
      nodes: (snap?.nodes ?? []).map((n) => (this.rates ? this.rates.apply(domain, n) : n)),
      cert: snap?.cert ?? null,
    };
  }

  /** Первое подключение: проверяем домен и токен по-настоящему, сохраняем только при успехе. */
  async connect(req: RemnawaveConnectRequest): Promise<RemnawaveStatus> {
    const { domain, apiKey } = req;
    const { stats, nodes } = await this.fetchOrThrow(domain, apiKey);
    const cert = await this.client.checkCertificate(domain);
    const checkedAt = new Date().toISOString();
    await this.store.connect(domain, apiKey, {
      checkedAt,
      lastAttemptAt: checkedAt,
      failureSince: null,
      outageNotified: false,
      error: null,
      stats,
      nodes,
      cert,
    });
    await this.audit.record({
      action: 'remnawave.connected',
      target: { type: 'settings', id: 'remnawave', display: domain },
      metadata: { domain, nodes: nodes.length, users: stats.users.total },
    });
    return this.status();
  }

  /** Кнопка «Обновить»: свежие данные по уже сохранённому домену и токену. */
  async refresh(): Promise<RemnawaveStatus> {
    const creds = await this.store.credentials();
    if (!creds)
      throw problem(HttpStatus.CONFLICT, {
        type: REMNAWAVE_PROBLEM.notConnected,
        detail: 'Remnawave не подключена.',
      });
    await this.sync(creds.domain, creds.apiKey);
    return this.status();
  }

  async disconnect(): Promise<void> {
    const domain = await this.store.domain();
    await this.store.disconnect();
    if (domain)
      await this.audit.record({
        action: 'remnawave.disconnected',
        target: { type: 'settings', id: 'remnawave', display: domain },
      });
  }

  /** Плановая перепроверка (джоба): тихо пишет ошибку в снимок, не роняет и не шумит в Журнале на каждый тик. */
  async syncQuiet(timeoutMs?: number): Promise<void> {
    this.syncing ??= this.syncQuietOnce(timeoutMs).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }
  /**
   * Живая сверка, пока панель открыта: один лёгкий запрос нод. Статус какой-то ноды в Remnawave уже другой —
   * сразу полная перепроверка, и открытые страницы узнают об этом без ожидания своего опроса.
   */
  async liveCheck(timeoutMs: number): Promise<void> {
    const creds = await this.store.credentials();
    const snapshot = await this.store.snapshot();
    if (!creds || !snapshot || snapshot.error || this.syncing) return;
    try {
      const raw = await getJson(`https://${creds.domain}/api/nodes`, creds.apiKey, undefined, timeoutMs);
      const live = Array.isArray(raw.response) ? (raw.response as Record<string, unknown>[]) : [];
      if (!live.length) return;
      if (
        nodeStatusKey(
          live.map((n) => ({
            uuid: String(n.uuid),
            isConnected: Boolean(n.isConnected),
            isDisabled: Boolean(n.isDisabled),
            isConnecting: Boolean(n.isConnecting),
          })),
        ) !== nodeStatusKey(snapshot.nodes)
      )
        await this.syncQuiet(timeoutMs);
    } catch {
      /* Сверка — подсказка; ошибку связи покажет плановая перепроверка. */
    }
  }
  private async syncQuietOnce(timeoutMs?: number): Promise<void> {
    const creds = await this.store.credentials();
    if (!creds) return;
    const before = await this.store.snapshot();
    const wasOk = before ? !before.error : true;
    try {
      await this.sync(creds.domain, creds.apiKey, timeoutMs);
      const after = await this.store.snapshot();
      // Нода упала или поднялась — открытые страницы перечитают ноды сразу, а не через свои 15 секунд.
      if (after && nodeStatusKey(after.nodes) !== nodeStatusKey(before?.nodes ?? []))
        this.events?.emit({ type: 'nodes', data: { at: after.checkedAt ?? new Date().toISOString() } });
    } catch (err) {
      const message = errorText(err);
      const attemptedAt = new Date().toISOString();
      const failureSince = before?.failureSince ?? attemptedAt;
      // Две минуты подряд без ответа — сообщаем: обновление Remnawave обычно укладывается в минуту.
      const shouldNotify =
        !before?.outageNotified &&
        Date.parse(attemptedAt) - Date.parse(failureSince) >= REMNAWAVE_OUTAGE_NOTIFY_MS;
      await this.store.updateSnapshot({
        checkedAt: before?.checkedAt ?? attemptedAt,
        lastAttemptAt: attemptedAt,
        failureSince,
        outageNotified: before?.outageNotified || shouldNotify,
        error: message,
        stats: before?.stats ?? null,
        nodes: before?.nodes ?? [],
        cert: before?.cert ?? null,
      });
      if (wasOk)
        await this.audit.record({
          action: 'remnawave.unreachable',
          severity: 'warn',
          target: { type: 'settings', id: 'remnawave', display: creds.domain },
          metadata: { error: message },
        });
      if (shouldNotify)
        await this.notifications
          .push({
            severity: 'warn',
            title: 'Remnawave не отвечает',
            body: `Больше двух минут панель не может прочитать ${creds.domain}. Онлайн нод и резкие падения сейчас не отслеживаются. Причина: ${message}`,
            link: { to: '/nodes', label: 'Открыть Remnawave' },
            telegram: { event: 'panel_health' },
          })
          .catch((notifyErr) =>
            this.log.warn(`Оповещение о Remnawave не отправлено: ${errorText(notifyErr)}`),
          );
      this.log.warn(`Remnawave (${creds.domain}) недоступна: ${message}`);
      return;
    }
    if (!wasOk) {
      await this.audit.record({
        action: 'remnawave.reconnected',
        target: { type: 'settings', id: 'remnawave', display: creds.domain },
      });
      if (before?.outageNotified)
        await this.notifications
          .push({
            severity: 'ok',
            title: 'Remnawave снова отвечает',
            body: `Связь с ${creds.domain} восстановлена. Онлайн нод и падения снова отслеживаются по свежим данным.`,
            link: { to: '/nodes', label: 'Открыть Remnawave' },
            telegram: { event: 'panel_health' },
          })
          .catch((notifyErr) =>
            this.log.warn(`Оповещение о восстановлении Remnawave не отправлено: ${errorText(notifyErr)}`),
          );
    }
  }

  private async sync(domain: string, apiKey: string, timeoutMs?: number): Promise<void> {
    const { stats, nodes } = await this.fetchOrThrow(domain, apiKey, timeoutMs);
    // Онлайн нод читаем раз в минуту, а сертификат — раз в полчаса: он меняется раз в месяцы.
    const before = await this.store.snapshot();
    const fresh = Date.now() - this.certCheckedAt < REMNAWAVE_CERT_CHECK_INTERVAL_MIN * 60_000;
    const cert = fresh && before?.cert ? before.cert : await this.client.checkCertificate(domain);
    if (!fresh || !before?.cert) this.certCheckedAt = Date.now();
    const checkedAt = new Date().toISOString();
    await this.store.updateSnapshot({
      checkedAt,
      lastAttemptAt: checkedAt,
      failureSince: null,
      outageNotified: false,
      error: null,
      stats,
      nodes,
      cert,
    });
  }

  private async fetchOrThrow(domain: string, apiKey: string, timeoutMs?: number) {
    try {
      return await this.client.fetch(domain, apiKey, timeoutMs);
    } catch (err) {
      if (err instanceof RemnawaveApiError) {
        if (err.kind === 'unauthorized')
          throw problem(HttpStatus.BAD_REQUEST, {
            type: REMNAWAVE_PROBLEM.unauthorized,
            detail: err.message,
          });
        throw problem(HttpStatus.BAD_GATEWAY, {
          type: REMNAWAVE_PROBLEM.domainUnreachable,
          detail: err.message,
        });
      }
      throw err;
    }
  }
}
