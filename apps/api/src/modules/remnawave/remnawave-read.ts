import { inboundNames } from './remnawave-client.js';
import { HIDDEN, sanitizeRemnawaveProfile } from './remnawave-sanitize.js';

/**
 * Чтение любых разделов Remnawave для Ассистента — только GET и задачи на чтение, без изменений. До модели доходит
 * безопасная выжимка: ключи, пароли, ссылки и короткие UUID подписок, почта, Telegram ID, HWID и IP-адреса клиентов
 * не передаются. По подключениям клиентов — только числа: сколько разных IP и когда их видели в последний раз.
 */

type Row = Record<string, unknown>;

/** Обращение к API Remnawave: путь без домена, ответ — поле response. Ошибки — как у клиента Remnawave. */
export interface RemnawaveReadIo {
  get(path: string): Promise<unknown>;
  post(path: string, body?: Row): Promise<unknown>;
  /** Пауза между опросами задачи; в тестах — мгновенная. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RemnawaveReadNode {
  uuid: string;
  name: string;
  countryCode?: string | null;
}

/** Разделы: что в них и какое право ключа нужно. Описание уходит в инструмент Ассистента. */
export const REMNAWAVE_READ_TOPICS = {
  users: {
    scope: 'users:read',
    about: 'пользователи: сколько по статусам, кто скоро истекает, кто давно не заходил, список с фильтрами',
  },
  user_traffic: {
    scope: 'bandwidth-stats:read',
    about: 'трафик пользователя за период по нодам и дням (username)',
  },
  user_connections: {
    scope: 'connections:read',
    about: 'подключения пользователя: на каких нодах, сколько разных IP, когда последний раз (username)',
  },
  user_subscription_history: {
    scope: 'users:read',
    about: 'последние открытия подписки пользователем: когда и каким приложением (username)',
  },
  user_nodes: {
    scope: 'users:read',
    about: 'какие ноды и подключения доступны пользователю через его сквады (username)',
  },
  user_metadata: { scope: 'metadata:read', about: 'метаданные пользователя (username)' },
  nodes_traffic: { scope: 'bandwidth-stats:read', about: 'трафик нод за период: итог и по дням' },
  node_users_traffic: {
    scope: 'bandwidth-stats:read',
    about: 'кто больше всех качает на ноде за период (node)',
  },
  node_connections: {
    scope: 'connections:read',
    about: 'подключения на ноде сейчас: сколько пользователей, у кого больше всего разных IP (node)',
  },
  node_geocheck: { scope: 'connections:read', about: 'как сервисы геолокации видят страну IP ноды (node)' },
  node_metadata: { scope: 'metadata:read', about: 'метаданные ноды (node)' },
  squad_traffic: {
    scope: 'bandwidth-stats:read',
    about: 'трафик пользователей внутреннего сквада за период (squad)',
  },
  devices: {
    scope: 'hwid:read',
    about: 'устройства: сколько всего, по платформам и приложениям, у кого больше всего устройств',
  },
  subscription_requests: {
    scope: 'subscription-request-history:read',
    about: 'открытия подписок: какими приложениями, по часам',
  },
  torrent_blocker: {
    scope: 'node-plugins:read',
    about: 'торрент-блокер: сколько срабатываний, на каких нодах и у каких пользователей',
  },
  node_plugins: { scope: 'node-plugins:read', about: 'плагины нод и общие списки' },
  node_integrations: { scope: 'node-integrations:read', about: 'интеграции нод' },
  infra_billing: {
    scope: 'infra-billing:read',
    about: 'оплаты серверов в самой Remnawave: провайдеры, ближайшие оплаты, история',
  },
  system: {
    scope: 'system:read',
    about:
      'сводка Remnawave: пользователи, онлайн, трафик за месяц и всего, итоги за 30 дней, здоровье самой панели, версия',
  },
  settings: { scope: 'remnawave-settings:read', about: 'настройки Remnawave и подписки (без секретов)' },
  hosts: {
    scope: 'hosts:read',
    about: 'все Host целиком: адрес, порт, SNI, путь, отпечаток, теги, выключен ли',
  },
  inbounds: {
    scope: 'config-profiles:read',
    about: 'все inbound всех профилей: тег, протокол, порт, сеть, защита',
  },
  tags: { scope: 'users:read', about: 'теги пользователей, нод и Host' },
} as const;

export type RemnawaveReadTopic = keyof typeof REMNAWAVE_READ_TOPICS;
export const isReadTopic = (v: unknown): v is RemnawaveReadTopic =>
  typeof v === 'string' && Object.hasOwn(REMNAWAVE_READ_TOPICS, v);

/**
 * Поля, которые раскрывают человека или его доступ: почта (и списки allowedEmails), Telegram ID (и allowedIds
 * входа через Telegram), телефон, HWID, ссылка и ключи подписки, IP клиента.
 */
const PERSONAL_FIELD =
  /email|telegramid|phone|^(?:hwids?|shortuuid|subscriptionurl|vlessuuid|trojanpassword|sspassword|allowedids|adminids|chatids?|requestip|clientip|remoteip|ipaddress|ips?|source)$/;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// Полный адрес IPv6 или сокращённый с «::». Время вида 12:30:45 сюда не попадает.
const IPV6 =
  /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|(?:\b(?:[0-9a-f]{1,4}:){1,6}|::)(?::[0-9a-f]{1,4}){1,6}\b|\b(?:[0-9a-f]{1,4}:){1,7}:/gi;

/** Сверх обычной чистки секретов: поля о людях и IPv4 в строках (для свободных данных: метаданные, история подписки). */
export function sanitizePersonal(value: unknown, field = '', depth = 0): unknown {
  const key = field.toLowerCase().replace(/[_-]/g, '');
  if (PERSONAL_FIELD.test(key)) return value === null || value === undefined ? value : HIDDEN;
  if (depth >= 10) return '[слишком глубокая структура]';
  if (typeof value === 'string')
    return (sanitizeRemnawaveProfile(value) as string)
      .replace(IPV4, '[IP скрыт]')
      .replace(IPV6, '[IP скрыт]');
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizePersonal(item, '', depth + 1));
  if (!value || typeof value !== 'object') return sanitizeRemnawaveProfile(value, field);
  return Object.fromEntries(
    Object.entries(value as Row)
      .slice(0, 100)
      .map(([name, item]) => [name, sanitizePersonal(sanitizeRemnawaveProfile(item, name), name, depth + 1)]),
  );
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : null;
const rows = (v: unknown): Row[] =>
  Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Row[]) : [];
const obj = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {});

/** «12,3 ГБ» — чтобы модели не пересчитывать байты. */
export function bytesText(bytes: number | null): string | null {
  if (bytes === null) return null;
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'];
  let v = Math.abs(bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${bytes < 0 ? '-' : ''}${v.toLocaleString('ru-RU', { maximumFractionDigits: v < 10 ? 2 : 1 })} ${units[i]}`;
}

/** Период в днях (1–90, по умолчанию 7): даты для статистики трафика и ISO для итогов. */
export function periodOf(days: unknown, now = new Date()) {
  const n = Math.min(90, Math.max(1, Math.round(num(days) ?? 7)));
  const end = new Date(now);
  const start = new Date(now.getTime() - n * 86_400_000);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return {
    days: n,
    start: day(start),
    end: day(end),
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

const limitOf = (v: unknown, fallback = 20, max = 50) =>
  Math.min(max, Math.max(1, Math.round(num(v) ?? fallback)));

/** Нода по UUID, точному имени (без регистра) или единственному совпадению части имени. */
export function findNode(nodes: RemnawaveReadNode[], query: unknown): RemnawaveReadNode | string {
  const q = text(query).trim();
  if (!q) return 'Укажите ноду (node): имя или UUID.';
  const lower = q.toLowerCase();
  const exact = nodes.find((n) => n.uuid === q || n.name.toLowerCase() === lower);
  if (exact) return exact;
  const part = nodes.filter((n) => n.name.toLowerCase().includes(lower));
  if (part.length === 1 && part[0]) return part[0];
  return part.length
    ? `Имя «${q}» подходит нескольким нодам: ${part
        .slice(0, 5)
        .map((n) => n.name)
        .join(', ')}. Уточните.`
    : `Ноды «${q}» нет. Возьмите имя из get_remnawave_status.`;
}

interface ReadCtx {
  io: RemnawaveReadIo;
  nodes: RemnawaveReadNode[];
  now?: Date;
}

/**
 * Имена пользователей часто собраны из Telegram ID («123456789», «user_123456789»): длинное число в имени
 * показывается последними 4 цифрами — «•••6789». По такому имени пользователь находится (userId).
 */
const MASK = '•••';
export const maskName = (name: string): string => name.replace(/\d{6,}/g, (d) => `${MASK}${d.slice(-4)}`);

/** Все пользователи по курсору Remnawave: до 20 страниц по 500; truncated — прочитаны не все. */
async function streamUsers(
  io: RemnawaveReadIo,
  query = new URLSearchParams({ size: '500' }),
): Promise<{ users: Row[]; truncated: boolean }> {
  const users: Row[] = [];
  for (let page = 0; page < 20; page++) {
    const r = obj(await io.get(`/api/users/stream?${query}`));
    users.push(...rows(r.users));
    const next = typeof r.nextCursor === 'number' ? String(r.nextCursor) : text(r.nextCursor);
    if (r.hasMore !== true || !next) return { users, truncated: false };
    query.set('cursor', next);
  }
  return { users, truncated: true };
}

/** Полное имя и id по показанному «•••6789»: ровно одно совпадение — найден, иначе объяснение. */
export async function resolveMaskedName(
  io: RemnawaveReadIo,
  masked: string,
): Promise<{ id: number; username: string } | string> {
  const { users } = await streamUsers(io);
  const found = users.filter((u) => maskName(text(u.username)) === masked);
  const id = found.length === 1 ? num(found[0]?.id) : null;
  if (id !== null) return { id, username: text(found[0]?.username) };
  return found.length > 1
    ? `Имя «${masked}» подходит нескольким пользователям (${found.length}) — нужно полное имя.`
    : `Пользователя «${masked}» нет.`;
}

/** Пользователь по имени → числовой id (по нему Remnawave 3.x отдаёт трафик, подключения, историю). */
async function userId(ctx: ReadCtx, username: unknown): Promise<{ id: number; username: string } | string> {
  const name = text(username).trim();
  if (!name) return 'Укажите пользователя (username) точно как в Remnawave.';
  if (name.includes(MASK)) {
    const found = await resolveMaskedName(ctx.io, name);
    return typeof found === 'string' ? found : { id: found.id, username: name };
  }
  const user = obj(await ctx.io.get(`/api/users/by-username/${encodeURIComponent(name)}`).catch(() => null));
  const id = num(user.id);
  if (id === null) return `Пользователя «${name}» нет. Имя ищется точно, с регистром.`;
  return { id, username: maskName(text(user.username) || name) };
}

/** Нет записи (Remnawave отвечает 404, например «Metadata not found») — null вместо ошибки. */
const orMissing = (p: Promise<unknown>) =>
  p.catch((err: unknown) => {
    if ((err as { status?: unknown } | null)?.status === 404) return null;
    throw err;
  });

/** Задача Remnawave на чтение (подключения, геопроверка): запуск и опрос итога до 25 секунд. */
async function job(ctx: ReadCtx, start: string, result: (jobId: string) => string): Promise<Row | string> {
  const started = obj(await ctx.io.post(start));
  const jobId = text(started.jobId);
  if (!jobId) return 'Remnawave не вернула номер задачи.';
  const sleep = ctx.io.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let i = 0; i < 17; i++) {
    const r = obj(await ctx.io.get(result(jobId)));
    if (r.isFailed === true) return 'Задача Remnawave не выполнилась (нода не ответила или выключена).';
    if (r.isCompleted === true) return obj(r.result);
    await sleep(1500);
  }
  return 'Remnawave не успела собрать данные за 25 секунд — попробуйте ещё раз чуть позже.';
}

const lastSeen = (ips: Row[]) =>
  ips
    .map((ip) => text(ip.lastSeen))
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

const nodeNames = (ctx: ReadCtx) => new Map(ctx.nodes.map((n) => [n.uuid, n.name]));

/** Безопасная строка пользователя: без почты, Telegram ID, ссылок и ключей. */
function userBrief(u: Row, names: Map<string, string>) {
  const traffic = obj(u.userTraffic);
  const lastNode = text(traffic.lastConnectedNodeUuid);
  return {
    username: maskName(text(u.username)),
    status: text(u.status) || null,
    expireAt: text(u.expireAt) || null,
    used: bytesText(num(traffic.usedTrafficBytes ?? u.usedTrafficBytes)),
    usedBytes: num(traffic.usedTrafficBytes ?? u.usedTrafficBytes),
    limit: num(u.trafficLimitBytes) ? bytesText(num(u.trafficLimitBytes)) : 'без лимита',
    lifetime: bytesText(num(traffic.lifetimeUsedTrafficBytes ?? u.lifetimeUsedTrafficBytes)),
    onlineAt: text(traffic.onlineAt ?? u.onlineAt) || null,
    lastNode: lastNode ? (names.get(lastNode) ?? null) : null,
    squads: rows(u.activeInternalSquads)
      .map((s) => text(s.name))
      .filter(Boolean),
    tag: text(u.tag) || null,
    devicesLimit: num(u.hwidDeviceLimit),
    createdAt: text(u.createdAt) || null,
  };
}

type Topic = (ctx: ReadCtx, args: Row) => Promise<Row | string>;

const TOPICS: Record<RemnawaveReadTopic, Topic> = {
  async users(ctx, args) {
    const status = text(args.status).toUpperCase();
    const query = new URLSearchParams({ size: '500' });
    if (['ACTIVE', 'DISABLED', 'LIMITED', 'EXPIRED'].includes(status)) query.set('status', status);
    if (text(args.tag)) query.set('tag', text(args.tag));
    const { users: all, truncated } = await streamUsers(ctx.io, query);
    const now = (ctx.now ?? new Date()).getTime();
    const names = nodeNames(ctx);
    const briefs = all.map((u) => ({ ...userBrief(u, names), fullName: text(u.username).toLowerCase() }));
    const within = (iso: string | null, days: number) =>
      !!iso && Date.parse(iso) >= now && Date.parse(iso) - now <= days * 86_400_000;
    const byStatus: Record<string, number> = {};
    for (const u of briefs) byStatus[u.status ?? '—'] = (byStatus[u.status ?? '—'] ?? 0) + 1;
    let list = briefs;
    const search = text(args.search).trim().toLowerCase();
    // Ищется и по полному имени (владелец пишет его целиком), и по показанному «•••6789».
    if (search)
      list = list.filter((u) => u.fullName.includes(search) || u.username.toLowerCase().includes(search));
    const expiring = num(args.expiringDays);
    if (expiring !== null) list = list.filter((u) => within(u.expireAt, expiring));
    const inactive = num(args.inactiveDays);
    if (inactive !== null)
      list = list.filter((u) => !u.onlineAt || now - Date.parse(u.onlineAt) > inactive * 86_400_000);
    const sort = text(args.sort);
    const by = {
      traffic: (u: (typeof briefs)[number]) => u.usedBytes ?? 0,
      expire: (u: (typeof briefs)[number]) =>
        -(u.expireAt ? Date.parse(u.expireAt) : Number.MAX_SAFE_INTEGER),
      online: (u: (typeof briefs)[number]) => (u.onlineAt ? Date.parse(u.onlineAt) : 0),
      created: (u: (typeof briefs)[number]) => (u.createdAt ? Date.parse(u.createdAt) : 0),
    }[sort as 'traffic' | 'expire' | 'online' | 'created'];
    if (by) list = [...list].sort((a, b) => by(b) - by(a));
    const limit = limitOf(args.limit);
    return {
      total: briefs.length,
      ...(truncated
        ? { truncated: `Прочитаны первые ${briefs.length} пользователей, остальные не вошли.` }
        : {}),
      byStatus,
      expiringIn3Days: briefs.filter((u) => within(u.expireAt, 3)).length,
      expiringIn7Days: briefs.filter((u) => within(u.expireAt, 7)).length,
      onlineLast24h: briefs.filter((u) => u.onlineAt && now - Date.parse(u.onlineAt) <= 86_400_000).length,
      neverConnected: briefs.filter((u) => !u.onlineAt).length,
      matched: list.length,
      users: list.slice(0, limit).map(({ usedBytes, fullName, ...u }) => u),
      hint: 'byStatus: ACTIVE — работает, DISABLED — выключен, LIMITED — кончился трафик, EXPIRED — истёк срок. users — до limit строк после фильтров (search, status, tag, expiringDays, inactiveDays) и сортировки sort (traffic, expire, online, created). Длинные числа в именах (обычно Telegram ID) показаны последними 4 цифрами: «•••6789» — так и называй пользователя и так передавай в username.',
    };
  },

  async user_traffic(ctx, args) {
    const user = await userId(ctx, args.username);
    if (typeof user === 'string') return user;
    const p = periodOf(args.days, ctx.now);
    const r = obj(
      await ctx.io.get(
        `/api/bandwidth-stats/users/${user.id}?start=${p.start}&end=${p.end}&topNodesLimit=20`,
      ),
    );
    return {
      username: user.username,
      period: `${p.start} — ${p.end} (${p.days} дн.)`,
      byNode: rows(r.topNodes).map((n) => ({
        node: text(n.name),
        country: text(n.countryCode) || null,
        total: bytesText(num(n.total)),
      })),
      byDay: (Array.isArray(r.categories) ? r.categories : []).map((d, i) => ({
        day: String(d),
        total: bytesText(rows(r.series).reduce((sum, s) => sum + (num((s.data as unknown[])?.[i]) ?? 0), 0)),
      })),
    };
  },

  async user_connections(ctx, args) {
    const user = await userId(ctx, args.username);
    if (typeof user === 'string') return user;
    const r = await job(ctx, `/api/connections/by-user/${user.id}`, (id) => `/api/connections/by-user/${id}`);
    if (typeof r === 'string') return r;
    const nodes = rows(r.nodes).map((n) => {
      const ips = rows(n.ips);
      return {
        node: text(n.nodeName),
        country: text(n.countryCode) || null,
        differentIps: ips.length,
        lastSeen: lastSeen(ips),
      };
    });
    const unique = new Set(rows(r.nodes).flatMap((n) => rows(n.ips).map((ip) => text(ip.ip))));
    return {
      username: user.username,
      differentIps: unique.size,
      nodes,
      hint: 'Сколько разных IP видели ноды за последнее время. Много IP с разных стран одновременно — возможно, подпиской пользуются несколько человек; один IP — обычное дело. Сами адреса не передаются.',
    };
  },

  async user_subscription_history(ctx, args) {
    const user = await userId(ctx, args.username);
    if (typeof user === 'string') return user;
    const r = obj(await ctx.io.get(`/api/users/${user.id}/subscription-request-history`));
    const records = rows(r.records);
    const byApp: Record<string, number> = {};
    for (const x of records) {
      const app = (sanitizePersonal(text(x.userAgent).slice(0, 80)) as string) || 'неизвестно';
      byApp[app] = (byApp[app] ?? 0) + 1;
    }
    return {
      username: user.username,
      total: num(r.total) ?? records.length,
      differentIps: new Set(records.map((x) => text(x.requestIp)).filter(Boolean)).size,
      byApp,
      recent: records.slice(0, 12).map((x) => ({
        at: text(x.requestAt) || null,
        app: (sanitizePersonal(text(x.userAgent).slice(0, 120)) as string) || null,
        result: text(x.srrResponseType) || null,
        rule: text(x.srrRuleName) || null,
      })),
    };
  },

  async user_nodes(ctx, args) {
    const user = await userId(ctx, args.username);
    if (typeof user === 'string') return user;
    const r = obj(await ctx.io.get(`/api/users/${user.id}/accessible-nodes`));
    return {
      username: user.username,
      nodes: rows(r.activeNodes).map((n) => ({
        node: text(n.nodeName),
        country: text(n.countryCode) || null,
        profile: text(n.configProfileName) || null,
        squads: rows(n.activeSquads).map((s) => ({
          squad: text(s.squadName),
          inbounds: Array.isArray(s.activeInbounds)
            ? s.activeInbounds.map((i) => (typeof i === 'string' ? i : text(obj(i).tag)))
            : [],
        })),
      })),
    };
  },

  async user_metadata(ctx, args) {
    const user = await userId(ctx, args.username);
    if (typeof user === 'string') return user;
    const meta = await orMissing(ctx.io.get(`/api/metadata/user/${user.id}`));
    return meta === null
      ? { username: user.username, metadata: null, note: 'Метаданных у пользователя нет.' }
      : { username: user.username, metadata: sanitizePersonal(meta) as Row };
  },

  async nodes_traffic(ctx, args) {
    const p = periodOf(args.days, ctx.now);
    const r = obj(
      await ctx.io.get(`/api/bandwidth-stats/nodes?start=${p.start}&end=${p.end}&topNodesLimit=50`),
    );
    const categories = Array.isArray(r.categories) ? r.categories.map(String) : [];
    return {
      period: `${p.start} — ${p.end} (${p.days} дн.)`,
      byNode: rows(rows(r.series).length ? r.series : r.topNodes).map((n) => ({
        node: text(n.name),
        country: text(n.countryCode) || null,
        total: bytesText(num(n.total)),
      })),
      byDay: categories.map((d, i) => ({
        day: d,
        total: bytesText(rows(r.series).reduce((sum, s) => sum + (num((s.data as unknown[])?.[i]) ?? 0), 0)),
      })),
    };
  },

  async node_users_traffic(ctx, args) {
    const node = findNode(ctx.nodes, args.node);
    if (typeof node === 'string') return node;
    const p = periodOf(args.days, ctx.now);
    const limit = limitOf(args.limit);
    const r = obj(
      await ctx.io.get(
        `/api/bandwidth-stats/nodes/${node.uuid}/users?start=${p.start}&end=${p.end}&topUsersLimit=${limit}`,
      ),
    );
    return {
      node: node.name,
      period: `${p.start} — ${p.end} (${p.days} дн.)`,
      topUsers: rows(r.topUsers).map((u) => ({
        username: maskName(text(u.username)),
        total: bytesText(num(u.total)),
      })),
    };
  },

  async node_connections(ctx, args) {
    const node = findNode(ctx.nodes, args.node);
    if (typeof node === 'string') return node;
    const r = await job(
      ctx,
      `/api/connections/by-node/${node.uuid}`,
      (id) => `/api/connections/by-node/${id}`,
    );
    if (typeof r === 'string') return r;
    const users = rows(r.users).map((u) => ({ id: num(u.userId), ips: rows(u.ips) }));
    const top = [...users].sort((a, b) => b.ips.length - a.ips.length).slice(0, 10);
    // Имена — только для верхних десяти, по одному запросу на пользователя.
    const named = await Promise.all(
      top.map(async (u) => {
        const row = u.id === null ? {} : obj(await ctx.io.get(`/api/users/${u.id}`).catch(() => null));
        return {
          username: maskName(text(row.username)) || `#${u.id ?? '?'}`,
          differentIps: u.ips.length,
          lastSeen: lastSeen(u.ips),
        };
      }),
    );
    return {
      node: node.name,
      users: users.length,
      differentIps: new Set(users.flatMap((u) => u.ips.map((ip) => text(ip.ip)))).size,
      usersWithManyIps: users.filter((u) => u.ips.length >= 3).length,
      topByIps: named,
      hint: 'Пользователи, которых нода видит подключёнными, и сколько у каждого разных IP. Адреса не передаются.',
    };
  },

  async node_geocheck(ctx, args) {
    const node = findNode(ctx.nodes, args.node);
    if (typeof node === 'string') return node;
    const r = await job(
      ctx,
      `/api/connections/geocheck/${node.uuid}`,
      (id) => `/api/connections/geocheck/${id}`,
    );
    if (typeof r === 'string') return r;
    // Полный отчёт — десятки тысяч знаков (трассировки, адреса проверок): модели нужна выжимка.
    const raw = obj(r.rawReport);
    const identity = obj(raw.identity);
    const rep = obj(raw.reputation);
    const geo = obj(raw.geo);
    const checks = obj(raw.connectivity_checks);
    const conn = obj(raw.connectivity);
    const seen = (list: unknown) =>
      rows(list).map((g) => ({
        name: text(g.name),
        value: text(obj(g.ipv4).value) || null,
        country: text(obj(g.ipv4).country) || null,
      }));
    return sanitizeRemnawaveProfile({
      node: node.name,
      success: r.success === true,
      message: text(r.message) || null,
      network: {
        asn: num(identity.asn),
        provider: text(identity.as_name) || null,
        org: text(identity.org) || null,
        registeredIn: text(identity.as_country) || null,
      },
      reputation: {
        type: text(rep.type) || null,
        risk: num(rep.risk),
        flags: Array.isArray(rep.flags) ? rep.flags.map(String) : [],
        proxy: rep.proxy === true,
        vpn: rep.vpn === true,
        hosting: rep.hosting === true,
        tor: rep.tor === true,
        country: text(rep.country_code) || null,
        city: text(rep.city) || null,
        devicesInSubnet: num(rep.devices_in_subnet),
      },
      consensus: rows(obj(raw.consensus).ipv4).map((c) => ({
        country: text(c.country),
        code: text(c.code),
        percent: num(c.percent),
      })),
      geoip: seen(geo.geoip),
      services: seen(geo.services),
      cdn: seen(geo.cdn),
      availability: [...rows(raw.stash_checks), ...rows(raw.ai_endpoints)].map((x) => ({
        name: text(x.name),
        state: text(x.state) || null,
        detail: text(x.detail) || null,
      })),
      connectivity: {
        clean: checks.clean === true,
        plainHttpBlocked: checks.plain_http_blocked === true,
        score: num(conn.score),
        routes: obj(conn.breakdown),
      },
      hint: 'consensus — какую страну видят у IP ноды сервисы геолокации, в процентах; geoip — что пишет каждый из них. services — что видят Google, YouTube, ChatGPT, Netflix и другие (value — код страны или ответ проверки, например «no»). availability — доступны ли сервисы с этого IP (blocked — закрыт, detail — почему, например «unsupported country»). reputation — тип адреса (хостинг или домашний), риск и флаги.',
    }) as Row;
  },

  async node_metadata(ctx, args) {
    const node = findNode(ctx.nodes, args.node);
    if (typeof node === 'string') return node;
    const meta = await orMissing(ctx.io.get(`/api/metadata/node/${node.uuid}`));
    return meta === null
      ? { node: node.name, metadata: null, note: 'Метаданных у ноды нет.' }
      : { node: node.name, metadata: sanitizePersonal(meta) as Row };
  },

  async squad_traffic(ctx, args) {
    const name = text(args.squad).trim().toLowerCase();
    if (!name) return 'Укажите внутренний сквад (squad) по имени.';
    const list = rows(obj(await ctx.io.get('/api/internal-squads')).internalSquads);
    const squad =
      list.find((s) => text(s.name).toLowerCase() === name) ??
      list.find((s) => text(s.name).toLowerCase().includes(name));
    if (!squad) return `Внутреннего сквада «${text(args.squad)}» нет.`;
    const p = periodOf(args.days, ctx.now);
    const limit = limitOf(args.limit);
    const r = obj(
      await ctx.io.get(
        `/api/bandwidth-stats/internal-squads/${text(squad.uuid)}/usage?start=${p.start}&end=${p.end}&limit=${limit}`,
      ),
    );
    const top = rows(r.users).slice(0, limit);
    const named = await Promise.all(
      top.map(async (u) => {
        const row = obj(await ctx.io.get(`/api/users/${num(u.id)}`).catch(() => null));
        return {
          username: maskName(text(row.username)) || `#${num(u.id) ?? '?'}`,
          total: bytesText(num(u.totalBytes)),
        };
      }),
    );
    return { squad: text(squad.name), period: `${p.start} — ${p.end} (${p.days} дн.)`, topUsers: named };
  },

  async devices(ctx) {
    const [stats, top] = await Promise.all([
      ctx.io.get('/api/hwid/devices/stats'),
      ctx.io.get('/api/hwid/devices/top-users?start=0&size=15'),
    ]);
    const s = obj(stats);
    return {
      totals: obj(s.stats),
      byPlatform: rows(s.byPlatform).map((p) => ({
        platform: text(p.platform),
        count: num(p.count),
        byApp: rows(p.byApp).map((a) => ({ app: text(a.app), count: num(a.count) })),
      })),
      topUsers: rows(obj(top).users).map((u) => ({
        username: maskName(text(u.username)),
        devices: num(u.devicesCount),
      })),
      hint: 'Сами идентификаторы устройств (HWID) не передаются.',
    };
  },

  async subscription_requests(ctx) {
    const s = obj(await ctx.io.get('/api/subscription-request-history/stats'));
    return {
      byApp: rows(s.byParsedApp).map((a) => ({ app: text(a.app), count: num(a.count) })),
      lastHours: rows(s.hourlyRequestStats)
        .slice(-48)
        .map((h) => ({ at: text(h.dateTime), requests: num(h.requestCount) })),
    };
  },

  async torrent_blocker(ctx) {
    const [stats, reports] = await Promise.all([
      ctx.io.get('/api/node-plugins/torrent-blocker/stats'),
      ctx.io.get('/api/node-plugins/torrent-blocker?start=0&size=100').catch(() => null),
    ]);
    const s = obj(stats);
    const byUser = new Map<string, { reports: number; last: string; nodes: Set<string> }>();
    for (const r of rows(obj(reports).records)) {
      const name = maskName(text(obj(r.user).username)) || `#${num(r.userId) ?? '?'}`;
      const entry = byUser.get(name) ?? { reports: 0, last: '', nodes: new Set<string>() };
      entry.reports += 1;
      if (text(r.createdAt) > entry.last) entry.last = text(r.createdAt);
      if (text(obj(r.node).name)) entry.nodes.add(text(obj(r.node).name));
      byUser.set(name, entry);
    }
    return {
      stats: obj(s.stats),
      topUsers: rows(s.topUsers).map((u) => ({
        username: maskName(text(u.username)),
        reports: num(u.total),
      })),
      topNodes: rows(s.topNodes).map((n) => ({ node: text(n.name), reports: num(n.total) })),
      recentByUser: [...byUser].slice(0, 20).map(([username, e]) => ({
        username,
        reports: e.reports,
        lastAt: e.last || null,
        nodes: [...e.nodes],
      })),
      hint: 'Срабатывания торрент-блокера: кто и где качал торренты. IP и адреса назначения не передаются.',
    };
  },

  async node_plugins(ctx) {
    const [plugins, lists] = await Promise.all([
      ctx.io.get('/api/node-plugins'),
      ctx.io.get('/api/node-plugins/shared-lists').catch(() => null),
    ]);
    return {
      plugins: sanitizeRemnawaveProfile(plugins) as Row,
      sharedLists: sanitizeRemnawaveProfile(lists) as Row,
    };
  },

  async node_integrations(ctx) {
    return { integrations: sanitizeRemnawaveProfile(await ctx.io.get('/api/node-integrations')) as Row };
  },

  async infra_billing(ctx) {
    const [providers, nodes, history] = await Promise.all([
      ctx.io.get('/api/infra-billing/providers'),
      ctx.io.get('/api/infra-billing/nodes'),
      ctx.io.get('/api/infra-billing/history?start=0&size=30'),
    ]);
    const n = obj(nodes);
    return {
      providers: rows(obj(providers).providers ?? providers).map((p) => ({
        name: text(p.name),
        site: text(p.loginUrl) || null,
        paidTotal: num(obj(p.billingHistory).totalAmount),
        bills: num(obj(p.billingHistory).totalBills),
        nodes: rows(p.billingNodes)
          .map((b) => text(b.name))
          .filter(Boolean),
      })),
      stats: obj(n.stats),
      upcoming: rows(n.billingNodes)
        .map((b) => ({
          node: text(obj(b.node).name) || text(b.name),
          country: text(obj(b.node).countryCode) || null,
          provider: text(obj(b.provider).name) || null,
          nextBillingAt: text(b.nextBillingAt) || null,
        }))
        .sort((a, b) => (a.nextBillingAt ?? '').localeCompare(b.nextBillingAt ?? '')),
      withoutBilling: rows(n.availableBillingNodes).map((x) => text(x.name)),
      history: rows(obj(history).records).map((h) => ({
        provider: text(obj(h.provider).name) || null,
        amount: num(h.amount),
        billedAt: text(h.billedAt) || null,
      })),
      hint: 'Это оплаты, записанные в самой Remnawave («Infra billing»), а не в биллинге этой панели (get_billing).',
    };
  },

  async system(ctx) {
    const p = periodOf(30, ctx.now);
    const [stats, recap, digest, health, meta, http, bandwidth] = await Promise.all(
      [
        '/api/system/stats',
        '/api/system/stats/recap',
        `/api/system/stats/digest?start=${encodeURIComponent(p.startIso)}&end=${encodeURIComponent(p.endIso)}`,
        '/api/system/health',
        '/api/system/metadata',
        '/api/system/stats/http',
        '/api/system/stats/bandwidth',
      ].map((path) => ctx.io.get(path).catch(() => null)),
    );
    const runtime = rows(obj(health).runtimeMetrics).map((m) => ({
      instance: text(m.instanceType) || null,
      memory: bytesText(num(m.rss)),
      eventLoopDelayMs: num(m.eventLoopDelayMs),
      uptimeSec: num(m.uptime),
    }));
    return {
      stats: sanitizeRemnawaveProfile(stats) as Row,
      recap: sanitizeRemnawaveProfile(recap) as Row,
      last30Days: sanitizeRemnawaveProfile(digest) as Row,
      bandwidth: sanitizeRemnawaveProfile(bandwidth) as Row,
      health: runtime,
      version: sanitizeRemnawaveProfile(meta) as Row,
      busiestRoutes: rows(obj(http).routes)
        .sort((a, b) => (num(b.count) ?? 0) - (num(a.count) ?? 0))
        .slice(0, 10)
        .map((r) => ({ route: `${text(r.method)} ${text(r.route)}`, count: num(r.count) })),
    };
  },

  async settings(ctx) {
    const [panel, subscription, pages] = await Promise.all([
      ctx.io.get('/api/remnawave-settings').catch(() => null),
      ctx.io.get('/api/subscription-settings').catch(() => null),
      ctx.io.get('/api/subscription-page-configs').catch(() => null),
    ]);
    return {
      remnawave: sanitizePersonal(panel) as Row,
      subscription: sanitizePersonal(subscription) as Row,
      subscriptionPages: rows(obj(pages).configs ?? pages)
        .map((c) => text(c.name))
        .filter(Boolean),
      hint: 'Секреты (ключи, токены, пароли, client secret) скрыты.',
    };
  },

  async hosts(ctx) {
    const [hosts, inbounds, tags] = await Promise.all([
      ctx.io.get('/api/hosts'),
      ctx.io.get('/api/config-profiles/inbounds').catch(() => null),
      ctx.io.get('/api/hosts/tags').catch(() => null),
    ]);
    const names = nodeNames(ctx);
    const inboundTags = new Map(rows(obj(inbounds).inbounds).map((i) => [text(i.uuid), text(i.tag)]));
    const list = rows(Array.isArray(hosts) ? hosts : obj(hosts).hosts);
    return {
      total: list.length,
      hosts: list.slice(0, 200).map((h) => {
        const { uuid, nodes, inbound, xrayJsonTemplateUuid, ...rest } = h;
        return {
          ...(sanitizeRemnawaveProfile(rest) as Row),
          inbound: inboundTags.get(text(obj(inbound).configProfileInboundUuid)) || null,
          nodes: (Array.isArray(nodes) ? nodes : []).map((n) => names.get(text(n)) ?? 'нода не найдена'),
        };
      }),
      tags: sanitizeRemnawaveProfile(obj(tags).tags ?? null),
    };
  },

  async inbounds(ctx) {
    const list = rows(obj(await ctx.io.get('/api/config-profiles/inbounds')).inbounds);
    return {
      total: list.length,
      inbounds: list.slice(0, 200).map((i) => ({
        tag: text(i.tag),
        type: text(i.type) || null,
        network: text(i.network) || null,
        security: text(i.security) || null,
        port: num(i.port),
        sni: inboundNames(i.rawInbound),
        squads: Array.isArray(i.activeSquads) ? i.activeSquads.length : 0,
      })),
      hint: 'sni — имена Reality (serverNames) или TLS (serverName). squads — в скольких внутренних сквадах выдан inbound.',
    };
  },

  async tags(ctx) {
    const [users, nodes, hosts] = await Promise.all(
      ['/api/users/tags', '/api/nodes/tags', '/api/hosts/tags'].map((p) => ctx.io.get(p).catch(() => null)),
    );
    return {
      users: sanitizeRemnawaveProfile(users) as Row,
      nodes: sanitizeRemnawaveProfile(nodes) as Row,
      hosts: sanitizeRemnawaveProfile(hosts) as Row,
    };
  },
};

/** Прочитать раздел. Ошибки чтения (нет права, нет такого раздела в версии) оборачивает вызывающий. */
export async function readRemnawaveTopic(topic: RemnawaveReadTopic, args: Row, ctx: ReadCtx): Promise<Row> {
  const out = await TOPICS[topic](ctx, args);
  return typeof out === 'string' ? { error: out } : out;
}
