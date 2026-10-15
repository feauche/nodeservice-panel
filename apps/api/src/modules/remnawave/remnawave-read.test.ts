import { describe, expect, it } from 'vitest';
import {
  findNode,
  isReadTopic,
  maskName,
  periodOf,
  REMNAWAVE_READ_TOPICS,
  type RemnawaveReadIo,
  type RemnawaveReadTopic,
  readRemnawaveTopic,
  sanitizePersonal,
} from './remnawave-read.js';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const NODES = [
  { uuid: 'node-fi', name: 'Финляндия - 1', countryCode: 'FI' },
  { uuid: 'node-fi2', name: 'Финляндия - 2', countryCode: 'FI' },
  { uuid: 'node-us', name: 'США', countryCode: 'US' },
];
const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

/** Личное, что встречается в ответах Remnawave и не должно дойти до модели. */
const PRIVATE = [
  'vasya@example.com',
  '123456789',
  'https://sub.example.com/abcDEF123',
  'abcDEF123',
  '0192c000-0000-7000-8000-0000000000bb',
  'trojan-secret',
  'ss-secret',
  '203.0.113.5',
  '198.51.100.7',
  '2a01:4f8::1',
  'hwid-iphone-1',
];

const USER = (over: Record<string, unknown> = {}) => ({
  id: 1,
  shortUuid: 'abcDEF123',
  username: 'vasya',
  status: 'ACTIVE',
  trafficLimitBytes: 0,
  expireAt: iso(2 * DAY),
  telegramId: 123456789,
  email: 'vasya@example.com',
  description: 'звонить 203.0.113.5',
  tag: null,
  hwidDeviceLimit: 3,
  trojanPassword: 'trojan-secret',
  vlessUuid: '0192c000-0000-7000-8000-0000000000bb',
  ssPassword: 'ss-secret',
  subscriptionUrl: 'https://sub.example.com/abcDEF123',
  createdAt: iso(-100 * DAY),
  activeInternalSquads: [{ uuid: 'sq-1', name: 'Основной' }],
  userTraffic: {
    usedTrafficBytes: 5 * 1024 ** 3,
    lifetimeUsedTrafficBytes: 50 * 1024 ** 3,
    onlineAt: iso(-60_000),
    lastConnectedNodeUuid: 'node-fi',
  },
  ...over,
});

type Answer = unknown | ((path: string, n: number) => unknown);

/** Remnawave на бумаге: ответ по пути (точному или по началу), учёт всех запросов. */
function fakeIo(routes: Record<string, Answer>) {
  const calls: Array<{ method: 'GET' | 'POST'; path: string }> = [];
  const seen = new Map<string, number>();
  const sleeps: number[] = [];
  const answer = (method: 'GET' | 'POST', path: string) => {
    calls.push({ method, path });
    const key = `${method} ${path}`;
    const route =
      Object.keys(routes).find((r) => r === key) ??
      Object.keys(routes)
        .filter((r) => key.startsWith(r))
        .sort((a, b) => b.length - a.length)[0];
    if (!route) throw new Error(`нет ответа на ${key}`);
    const n = (seen.get(route) ?? 0) + 1;
    seen.set(route, n);
    const value = routes[route];
    const out = typeof value === 'function' ? (value as (p: string, n: number) => unknown)(path, n) : value;
    if (out instanceof Error) throw out;
    return out;
  };
  const io: RemnawaveReadIo = {
    get: async (path) => answer('GET', path),
    post: async (path) => answer('POST', path),
    sleep: async (ms) => void sleeps.push(ms),
  };
  return { io, calls, sleeps };
}

const read = (topic: RemnawaveReadTopic, args: Record<string, unknown>, io: RemnawaveReadIo) =>
  readRemnawaveTopic(topic, args, { io, nodes: NODES, now: NOW });

const expectNothingPrivate = (out: unknown) => {
  const text = JSON.stringify(out);
  for (const secret of PRIVATE) expect(text).not.toContain(secret);
};

describe('Ассистент читает Remnawave: пользователи', () => {
  const users = [
    USER(),
    USER({
      id: 2,
      username: 'petya',
      status: 'EXPIRED',
      expireAt: iso(-3 * DAY),
      userTraffic: { usedTrafficBytes: 20 * 1024 ** 3, onlineAt: iso(-40 * DAY) },
    }),
    USER({
      id: 3,
      username: 'masha',
      status: 'ACTIVE',
      expireAt: iso(6 * DAY),
      userTraffic: { usedTrafficBytes: 1024 ** 3, onlineAt: null },
    }),
  ];

  it('читает все страницы и считает по статусам и срокам; личного в ответе нет', async () => {
    const { io, calls } = fakeIo({
      'GET /api/users/stream': (path: string) =>
        path.includes('cursor=')
          ? { users: users.slice(2), hasMore: false, nextCursor: null }
          : { users: users.slice(0, 2), hasMore: true, nextCursor: 2 },
    });
    const out = await read('users', {}, io);
    // Курсор Remnawave может прийти числом — вторая страница всё равно читается.
    expect(calls.map((c) => c.path)).toEqual([
      '/api/users/stream?size=500',
      '/api/users/stream?size=500&cursor=2',
    ]);
    expect(out).toMatchObject({
      total: 3,
      byStatus: { ACTIVE: 2, EXPIRED: 1 },
      expiringIn3Days: 1,
      expiringIn7Days: 2,
      onlineLast24h: 1,
      neverConnected: 1,
    });
    expect(out.truncated).toBeUndefined();
    expect((out.users as Array<Record<string, unknown>>)[0]).toEqual({
      username: 'vasya',
      status: 'ACTIVE',
      expireAt: iso(2 * DAY),
      used: '5 ГБ',
      limit: 'без лимита',
      lifetime: '50 ГБ',
      onlineAt: iso(-60_000),
      lastNode: 'Финляндия - 1',
      squads: ['Основной'],
      tag: null,
      devicesLimit: 3,
      createdAt: iso(-100 * DAY),
    });
    // Заметка владельца о пользователе (description) тоже не уходит: в ней бывают контакты.
    expectNothingPrivate(out);
    expect(JSON.stringify(out)).not.toContain('звонить');
  });

  it('фильтры и сортировка: истекают за N дней, давно не заходили, поиск по имени, по трафику, limit', async () => {
    const { io } = fakeIo({ 'GET /api/users/stream': { users, hasMore: false } });
    const names = (out: Record<string, unknown>) =>
      (out.users as Array<{ username: string }>).map((u) => u.username);
    expect(names(await read('users', { expiringDays: 3 }, io))).toEqual(['vasya']);
    expect(names(await read('users', { inactiveDays: 30 }, io))).toEqual(['petya', 'masha']);
    expect(names(await read('users', { search: 'AS' }, io))).toEqual(['vasya', 'masha']);
    expect(names(await read('users', { sort: 'traffic' }, io))).toEqual(['petya', 'vasya', 'masha']);
    const limited = await read('users', { sort: 'traffic', limit: 1 }, io);
    expect(names(limited)).toEqual(['petya']);
    expect(limited).toMatchObject({ matched: 3, total: 3 });
  });

  it('статус и тег уходят в запрос Remnawave; неизвестный статус не уходит', async () => {
    const { io, calls } = fakeIo({ 'GET /api/users/stream': { users: [], hasMore: false } });
    await read('users', { status: 'expired', tag: 'VIP' }, io);
    await read('users', { status: 'всё' }, io);
    expect(calls.map((c) => c.path)).toEqual([
      '/api/users/stream?size=500&status=EXPIRED&tag=VIP',
      '/api/users/stream?size=500',
    ]);
  });

  it('больше 20 страниц — честно сказано, что прочитаны не все', async () => {
    const { io } = fakeIo({
      'GET /api/users/stream': (_: string, n: number) => ({
        users: [USER({ id: n })],
        hasMore: true,
        nextCursor: `${n}`,
      }),
    });
    const out = await read('users', {}, io);
    expect(out.total).toBe(20);
    expect(out.truncated).toBe('Прочитаны первые 20 пользователей, остальные не вошли.');
  });
});

describe('Ассистент читает Remnawave: подключения и задачи на чтение', () => {
  const connections = {
    isCompleted: true,
    isFailed: false,
    result: {
      success: true,
      userId: 1,
      nodes: [
        {
          nodeUuid: 'node-fi',
          nodeName: 'Финляндия - 1',
          countryCode: 'FI',
          ips: [
            { ip: '203.0.113.5', lastSeen: '2026-10-15T10:00:00.000Z' },
            { ip: '198.51.100.7', lastSeen: '2026-10-15T11:00:00.000Z' },
          ],
        },
        {
          nodeUuid: 'node-us',
          nodeName: 'США',
          countryCode: 'US',
          ips: [{ ip: '203.0.113.5', lastSeen: '2026-10-15T09:00:00.000Z' }],
        },
      ],
    },
  };

  it('подключения пользователя: сколько разных IP и когда; задача опрашивается до готовности, адресов нет', async () => {
    const { io, calls, sleeps } = fakeIo({
      'GET /api/users/by-username/vasya': USER(),
      'POST /api/connections/by-user/1': { jobId: 'job-1' },
      'GET /api/connections/by-user/job-1': (_: string, n: number) =>
        n === 1 ? { isCompleted: false, isFailed: false } : connections,
    });
    const out = await read('user_connections', { username: 'vasya' }, io);
    expect(out).toMatchObject({
      username: 'vasya',
      differentIps: 2,
      nodes: [
        { node: 'Финляндия - 1', country: 'FI', differentIps: 2, lastSeen: '2026-10-15T11:00:00.000Z' },
        { node: 'США', country: 'US', differentIps: 1, lastSeen: '2026-10-15T09:00:00.000Z' },
      ],
    });
    expect(sleeps).toEqual([1500]);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      '/api/connections/by-user/1',
    ]);
    expectNothingPrivate(out);
  });

  it('подключения на ноде: число пользователей и у кого больше всего IP — по именам, без адресов', async () => {
    const { io } = fakeIo({
      'POST /api/connections/by-node/node-fi': { jobId: 'job-2' },
      'GET /api/connections/by-node/job-2': {
        isCompleted: true,
        result: {
          success: true,
          nodeUuid: 'node-fi',
          users: [
            {
              userId: 1,
              ips: [
                { ip: '203.0.113.5', lastSeen: '2026-10-15T10:00:00.000Z' },
                { ip: '198.51.100.7', lastSeen: '2026-10-15T11:00:00.000Z' },
                { ip: '2a01:4f8::1', lastSeen: '2026-10-15T11:30:00.000Z' },
              ],
            },
            { userId: 2, ips: [{ ip: '203.0.113.5', lastSeen: '2026-10-15T08:00:00.000Z' }] },
          ],
        },
      },
      'GET /api/users/1': USER(),
      'GET /api/users/2': USER({ id: 2, username: 'petya' }),
    });
    const out = await read('node_connections', { node: 'финляндия - 1' }, io);
    expect(out).toMatchObject({
      node: 'Финляндия - 1',
      users: 2,
      differentIps: 3,
      usersWithManyIps: 1,
      topByIps: [
        { username: 'vasya', differentIps: 3, lastSeen: '2026-10-15T11:30:00.000Z' },
        { username: 'petya', differentIps: 1 },
      ],
    });
    expectNothingPrivate(out);
  });

  it('задача упала или не успела — понятная причина, без вечного ожидания', async () => {
    const failed = fakeIo({
      'GET /api/users/by-username/vasya': USER(),
      'POST /api/connections/by-user/1': { jobId: 'job-x' },
      'GET /api/connections/by-user/job-x': { isCompleted: false, isFailed: true },
    });
    expect(await read('user_connections', { username: 'vasya' }, failed.io)).toEqual({
      error: 'Задача Remnawave не выполнилась (нода не ответила или выключена).',
    });
    const slow = fakeIo({
      'GET /api/users/by-username/vasya': USER(),
      'POST /api/connections/by-user/1': { jobId: 'job-y' },
      'GET /api/connections/by-user/job-y': { isCompleted: false, isFailed: false },
    });
    expect(await read('user_connections', { username: 'vasya' }, slow.io)).toEqual({
      error: 'Remnawave не успела собрать данные за 25 секунд — попробуйте ещё раз чуть позже.',
    });
    expect(slow.sleeps).toHaveLength(17);
    const noJob = fakeIo({ 'POST /api/connections/by-node/node-us': {} });
    expect(await read('node_connections', { node: 'США' }, noJob.io)).toEqual({
      error: 'Remnawave не вернула номер задачи.',
    });
  });

  it('геопроверка ноды: выжимка — страна по сервисам, доступность, репутация; без картинки и трассировок', async () => {
    const { io } = fakeIo({
      'POST /api/connections/geocheck/node-us': { jobId: 'geo-1' },
      'GET /api/connections/geocheck/geo-1': {
        isCompleted: true,
        result: {
          success: true,
          message: null,
          image: { data: 'iVBORw0KGgoAAA' },
          rawReport: {
            identity: {
              ipv4: '192.0.2.10',
              asn: 64500,
              as_name: 'Example Hosting',
              org: 'Example',
              as_country: 'TR',
            },
            reputation: {
              type: 'hosting',
              risk: 12,
              flags: ['hosting'],
              hosting: true,
              country_code: 'TR',
              city: 'Istanbul',
              range: '192.0.2.0/24',
            },
            consensus: { ipv4: [{ code: 'TR', country: 'Turkey', count: 16, total: 29, percent: 55.17 }] },
            geo: {
              geoip: [{ id: 'maxmind', name: 'maxmind.com', ipv4: { value: 'TR', country: 'Turkey' } }],
              services: [{ id: 'yt', name: 'YouTube', ipv4: { value: 'RU', country: 'Russia' } }],
              cdn: [],
            },
            stash_checks: [
              { id: 'chatgpt_web', name: 'ChatGPT (web)', state: 'blocked', detail: 'unsupported country' },
            ],
            ai_endpoints: [{ id: 'openai', name: 'OpenAI', state: 'reachable', http_status: 200 }],
            connectivity_checks: {
              clean: true,
              plain_http_blocked: false,
              endpoints: [{ url: 'http://probe.example/x' }],
            },
            connectivity: {
              score: 78,
              breakdown: { direct: 5, detour: 2 },
              targets: [{ host: 'probe.example', hops: [{ ttl: 1, avg_ms: 1 }] }],
            },
          },
        },
      },
    });
    const out = await read('node_geocheck', { node: 'США' }, io);
    expect(out).toMatchObject({
      node: 'США',
      success: true,
      network: { asn: 64500, provider: 'Example Hosting', registeredIn: 'TR' },
      reputation: { type: 'hosting', risk: 12, hosting: true, vpn: false, country: 'TR', city: 'Istanbul' },
      consensus: [{ country: 'Turkey', code: 'TR', percent: 55.17 }],
      geoip: [{ name: 'maxmind.com', value: 'TR', country: 'Turkey' }],
      services: [{ name: 'YouTube', value: 'RU', country: 'Russia' }],
      availability: [
        { name: 'ChatGPT (web)', state: 'blocked', detail: 'unsupported country' },
        { name: 'OpenAI', state: 'reachable', detail: null },
      ],
      connectivity: { clean: true, plainHttpBlocked: false, score: 78, routes: { direct: 5, detour: 2 } },
    });
    const text = JSON.stringify(out);
    for (const noise of ['iVBORw0KGgoAAA', 'probe.example', 'hops', '192.0.2.0/24'])
      expect(text).not.toContain(noise);
  });
});

describe('Ассистент читает Remnawave: трафик', () => {
  it('трафик пользователя за период: по нодам и по дням, байты словами', async () => {
    const { io, calls } = fakeIo({
      'GET /api/users/by-username/vasya': USER(),
      'GET /api/bandwidth-stats/users/1': {
        categories: ['2026-10-14', '2026-10-15'],
        topNodes: [{ name: 'Финляндия - 1', countryCode: 'FI', total: 3 * 1024 ** 3 }],
        series: [
          { name: 'Финляндия - 1', data: [1024 ** 3, 2 * 1024 ** 3] },
          { name: 'США', data: [512 * 1024 ** 2, 0] },
        ],
      },
    });
    const out = await read('user_traffic', { username: 'vasya', days: 2 }, io);
    expect(calls.at(-1)?.path).toBe(
      '/api/bandwidth-stats/users/1?start=2026-10-13&end=2026-10-15&topNodesLimit=20',
    );
    expect(out).toEqual({
      username: 'vasya',
      period: '2026-10-13 — 2026-10-15 (2 дн.)',
      byNode: [{ node: 'Финляндия - 1', country: 'FI', total: '3 ГБ' }],
      byDay: [
        { day: '2026-10-14', total: '1,5 ГБ' },
        { day: '2026-10-15', total: '2 ГБ' },
      ],
    });
  });

  it('кто больше всех качает на ноде и в скваде — имена, без идентификаторов', async () => {
    const { io, calls } = fakeIo({
      'GET /api/bandwidth-stats/nodes/node-us/users': {
        topUsers: [{ username: 'petya', total: 10 * 1024 ** 3 }],
      },
      'GET /api/internal-squads': { internalSquads: [{ uuid: 'sq-1', name: 'Основной' }] },
      'GET /api/bandwidth-stats/internal-squads/sq-1/usage': { users: [{ id: 2, totalBytes: 1024 ** 4 }] },
      'GET /api/users/2': USER({ id: 2, username: 'petya' }),
    });
    expect(await read('node_users_traffic', { node: 'сша', limit: 5 }, io)).toEqual({
      node: 'США',
      period: '2026-10-08 — 2026-10-15 (7 дн.)',
      topUsers: [{ username: 'petya', total: '10 ГБ' }],
    });
    expect(calls.at(-1)?.path).toContain('topUsersLimit=5');
    expect(await read('squad_traffic', { squad: 'основ' }, io)).toEqual({
      squad: 'Основной',
      period: '2026-10-08 — 2026-10-15 (7 дн.)',
      topUsers: [{ username: 'petya', total: '1 ТБ' }],
    });
    expect(await read('squad_traffic', { squad: 'Нет такого' }, io)).toEqual({
      error: 'Внутреннего сквада «Нет такого» нет.',
    });
  });
});

describe('Ассистент читает Remnawave: устройства, подписки, торренты', () => {
  it('история подписки: когда и каким приложением, без IP; разных IP — только число', async () => {
    const { io } = fakeIo({
      'GET /api/users/by-username/vasya': USER(),
      'GET /api/users/1/subscription-request-history': {
        total: 3,
        records: [
          {
            requestAt: iso(-1000),
            requestIp: '203.0.113.5',
            userAgent: 'Happ/3.1 (203.0.113.5)',
            srrResponseType: 'XRAY_JSON',
          },
          {
            requestAt: iso(-2000),
            requestIp: '198.51.100.7',
            userAgent: 'v2rayNG/1.9',
            srrResponseType: 'XRAY_BASE64',
          },
          {
            requestAt: iso(-3000),
            requestIp: '',
            userAgent: '',
            srrResponseType: 'BLOCK',
            srrRuleName: 'Браузер',
          },
        ],
      },
    });
    const out = await read('user_subscription_history', { username: 'vasya' }, io);
    expect(out).toMatchObject({
      total: 3,
      differentIps: 2,
      byApp: { 'Happ/3.1 ([IP скрыт])': 1, 'v2rayNG/1.9': 1, неизвестно: 1 },
      recent: [
        { app: 'Happ/3.1 ([IP скрыт])', result: 'XRAY_JSON' },
        {},
        { result: 'BLOCK', rule: 'Браузер' },
      ],
    });
    expectNothingPrivate(out);
  });

  it('устройства: сколько и каких, у кого больше всего — без HWID', async () => {
    const { io } = fakeIo({
      'GET /api/hwid/devices/stats': {
        stats: { totalUniqueDevices: 10, totalHwidDevices: 12, averageHwidDevicesPerUser: 1.2 },
        byPlatform: [{ platform: 'iOS', count: 7, byApp: [{ app: 'Happ', count: 7 }] }],
      },
      'GET /api/hwid/devices/top-users': {
        users: [{ id: 1, username: 'vasya', devicesCount: 3, hwid: 'hwid-iphone-1' }],
      },
    });
    const out = await read('devices', {}, io);
    expect(out).toMatchObject({
      totals: { totalUniqueDevices: 10 },
      byPlatform: [{ platform: 'iOS', count: 7, byApp: [{ app: 'Happ', count: 7 }] }],
      topUsers: [{ username: 'vasya', devices: 3 }],
    });
    expectNothingPrivate(out);
  });

  it('торрент-блокер: кто и на какой ноде, без IP, почты Xray и адресов назначения', async () => {
    const record = (username: string, at: string) => ({
      userId: 1,
      user: { username },
      node: { name: 'США', countryCode: 'US' },
      createdAt: at,
      report: {
        actionReport: { ip: '203.0.113.5', blocked: true },
        xrayReport: {
          email: 'vasya@example.com',
          source: '198.51.100.7:51000',
          destination: 'tracker.example:6881',
        },
      },
    });
    const { io } = fakeIo({
      'GET /api/node-plugins/torrent-blocker/stats': {
        stats: { totalReports: 2, reportsLast24Hours: 2, distinctUsers: 1, distinctNodes: 1 },
        topUsers: [{ userId: 1, username: 'vasya', total: 2 }],
        topNodes: [{ uuid: 'node-us', name: 'США', total: 2 }],
      },
      'GET /api/node-plugins/torrent-blocker?': {
        records: [record('vasya', iso(-5000)), record('vasya', iso(-1000))],
      },
    });
    const out = await read('torrent_blocker', {}, io);
    expect(out).toMatchObject({
      stats: { totalReports: 2 },
      topUsers: [{ username: 'vasya', reports: 2 }],
      topNodes: [{ node: 'США', reports: 2 }],
      recentByUser: [{ username: 'vasya', reports: 2, lastAt: iso(-1000), nodes: ['США'] }],
    });
    expectNothingPrivate(out);
    expect(JSON.stringify(out)).not.toContain('tracker.example');
  });
});

describe('Ассистент читает Remnawave: настройки, Host, inbound, система', () => {
  it('настройки: секреты, разрешённые почты и Telegram ID входа скрыты, включено ли — видно', async () => {
    const { io } = fakeIo({
      'GET /api/remnawave-settings': {
        oauth2Settings: {
          github: {
            enabled: true,
            clientId: 'gh-client',
            clientSecret: 'gh-secret',
            allowedEmails: ['vasya@example.com'],
          },
          telegram: { enabled: true, clientId: 'bot', clientSecret: 'tg-secret', allowedIds: ['123456789'] },
          generic: { enabled: false, tokenUrl: 'https://idp.example/token?secret=1' },
        },
        passwordSettings: { enabled: false },
        brandingSettings: { title: 'Lumax' },
      },
      'GET /api/subscription-settings': {
        hwidSettings: { enabled: true, fallbackDeviceLimit: 3 },
        responseRules: {
          rules: [
            {
              name: 'Шифрование',
              responseModifications: { encryption: { method: 'age1', key: 'age-private-key' } },
            },
          ],
        },
      },
      'GET /api/subscription-page-configs': { configs: [{ name: 'Основная', config: { secret: 'x' } }] },
    });
    const out = await read('settings', {}, io);
    expect(out).toMatchObject({
      remnawave: {
        oauth2Settings: { github: { enabled: true }, telegram: { enabled: true } },
        passwordSettings: { enabled: false },
        brandingSettings: { title: 'Lumax' },
      },
      subscription: { hwidSettings: { enabled: true, fallbackDeviceLimit: 3 } },
      subscriptionPages: ['Основная'],
    });
    const text = JSON.stringify(out);
    for (const secret of ['gh-secret', 'tg-secret', 'age-private-key', 'idp.example', ...PRIVATE])
      expect(text).not.toContain(secret);
  });

  it('Host: все, а не первые 50; ноды и inbound по именам, без UUID', async () => {
    const hosts = Array.from({ length: 60 }, (_, i) => ({
      uuid: `0192c000-0000-7000-8000-${String(i).padStart(12, '0')}`,
      remark: `Host ${i + 1}`,
      address: `h${i + 1}.example.com`,
      port: 443,
      sni: 'site.test',
      isDisabled: i === 0,
      tags: ['MAIN'],
      inbound: { configProfileUuid: 'p-1', configProfileInboundUuid: 'ib-1' },
      nodes: i === 0 ? ['node-fi', 'node-gone'] : ['node-us'],
    }));
    const { io } = fakeIo({
      'GET /api/hosts/tags': { tags: ['MAIN'] },
      'GET /api/hosts': hosts,
      'GET /api/config-profiles/inbounds': { inbounds: [{ uuid: 'ib-1', tag: 'VLESS_REALITY' }] },
    });
    const out = await read('hosts', {}, io);
    expect(out.total).toBe(60);
    expect(out.hosts).toHaveLength(60);
    expect((out.hosts as unknown[])[0]).toMatchObject({
      remark: 'Host 1',
      address: 'h1.example.com',
      isDisabled: true,
      tags: ['MAIN'],
      inbound: 'VLESS_REALITY',
      nodes: ['Финляндия - 1', 'нода не найдена'],
    });
    expect(out.tags).toEqual(['MAIN']);
    expect(JSON.stringify(out)).not.toContain('0192c000');
  });

  it('inbound: тег, порт, защита и SNI — без ключей Reality', async () => {
    const { io } = fakeIo({
      'GET /api/config-profiles/inbounds': {
        inbounds: [
          {
            uuid: 'ib-1',
            tag: 'VLESS_REALITY',
            type: 'vless',
            network: 'tcp',
            security: 'reality',
            port: 443,
            activeSquads: ['sq-1', 'sq-2'],
            rawInbound: {
              streamSettings: {
                realitySettings: { serverNames: ['site.test:443'], privateKey: 'reality-pk' },
              },
            },
          },
        ],
      },
    });
    const out = await read('inbounds', {}, io);
    expect(out).toMatchObject({
      total: 1,
      inbounds: [
        {
          tag: 'VLESS_REALITY',
          type: 'vless',
          network: 'tcp',
          security: 'reality',
          port: 443,
          sni: ['site.test'],
          squads: 2,
        },
      ],
    });
    expect(JSON.stringify(out)).not.toContain('reality-pk');
  });

  it('сводка: что не отдалось, то пусто, остальное на месте', async () => {
    const { io, calls } = fakeIo({
      'GET /api/system/stats/recap': { total: { users: 870, nodes: 5 }, version: '3.4.4' },
      'GET /api/system/stats/digest': { users: { createdCount: 12, expiredCount: 3 } },
      'GET /api/system/stats/http': {
        routes: [
          { method: 'GET', route: '/api/sub/:shortUuid', count: 900 },
          { method: 'GET', route: '/api/nodes', count: 30 },
        ],
      },
      'GET /api/system/stats/bandwidth': { bandwidthLastSevenDays: { current: '1.2 TB', previous: '1 TB' } },
      'GET /api/system/stats': { onlineStats: { onlineNow: 236 } },
      'GET /api/system/health': {
        runtimeMetrics: [{ instanceType: 'api', rss: 200 * 1024 ** 2, uptime: 10 }],
      },
      'GET /api/system/metadata': new Error('нет права'),
    });
    const out = await read('system', {}, io);
    expect(out).toMatchObject({
      stats: { onlineStats: { onlineNow: 236 } },
      recap: { total: { users: 870 }, version: '3.4.4' },
      last30Days: { users: { createdCount: 12 } },
      bandwidth: { bandwidthLastSevenDays: { current: '1.2 TB' } },
      health: [{ instance: 'api', memory: '200 МБ', uptimeSec: 10 }],
      version: null,
      busiestRoutes: [
        { route: 'GET /api/sub/:shortUuid', count: 900 },
        { route: 'GET /api/nodes', count: 30 },
      ],
    });
    expect(calls.find((c) => c.path.startsWith('/api/system/stats/digest'))?.path).toBe(
      `/api/system/stats/digest?start=${encodeURIComponent('2026-09-15T12:00:00.000Z')}&end=${encodeURIComponent(NOW.toISOString())}`,
    );
  });
});

describe('Ассистент читает Remnawave: границы', () => {
  it('нет пользователя, нет ноды, неоднозначное имя — объяснение, а не пустой ответ', async () => {
    const { io } = fakeIo({ 'GET /api/users/by-username/': new Error('404') });
    expect(await read('user_traffic', { username: 'nobody' }, io)).toEqual({
      error: 'Пользователя «nobody» нет. Имя ищется точно, с регистром.',
    });
    expect(await read('user_traffic', {}, io)).toEqual({
      error: 'Укажите пользователя (username) точно как в Remnawave.',
    });
    expect(await read('node_connections', { node: 'финляндия' }, io)).toEqual({
      error: 'Имя «финляндия» подходит нескольким нодам: Финляндия - 1, Финляндия - 2. Уточните.',
    });
    expect(await read('node_connections', { node: 'Марс' }, io)).toEqual({
      error: 'Ноды «Марс» нет. Возьмите имя из get_remnawave_status.',
    });
  });

  it('нода находится по UUID, точному имени и единственному совпадению части имени', () => {
    expect(findNode(NODES, 'node-us')).toMatchObject({ name: 'США' });
    expect(findNode(NODES, 'финляндия - 2')).toMatchObject({ uuid: 'node-fi2' });
    expect(findNode(NODES, '- 2')).toMatchObject({ uuid: 'node-fi2' });
    expect(findNode(NODES, '')).toBe('Укажите ноду (node): имя или UUID.');
  });

  it('период: от 1 до 90 дней, по умолчанию 7', () => {
    expect(periodOf(undefined, NOW)).toMatchObject({ days: 7, start: '2026-10-08', end: '2026-10-15' });
    expect(periodOf(0, NOW).days).toBe(1);
    expect(periodOf('365', NOW).days).toBe(90);
    expect(periodOf('много', NOW).days).toBe(7);
  });

  it('разделы известны, чужое имя раздела — не раздел', () => {
    expect(isReadTopic('users')).toBe(true);
    expect(isReadTopic('api_tokens')).toBe(false);
    expect(isReadTopic('toString')).toBe(false);
    expect(isReadTopic(undefined)).toBe(false);
    for (const topic of Object.values(REMNAWAVE_READ_TOPICS)) expect(topic.scope).toMatch(/^[a-z-]+:read$/);
  });

  it('чистка личного: почта, Telegram ID, IPv4 и IPv6 скрыты; время и обычный текст остаются', () => {
    expect(
      sanitizePersonal({
        note: 'IP 203.0.113.5 и 2a01:4f8::1, пишите vasya@example.com, созвон в 12:30:45',
        telegram_id: 123456789,
        allowedEmails: ['vasya@example.com'],
        nested: { phone: '+7 900 000-00-00', ips: ['203.0.113.5'] },
      }),
    ).toEqual({
      note: 'IP [IP скрыт] и [IP скрыт], пишите [скрыто], созвон в 12:30:45',
      telegram_id: '[скрыто]',
      allowedEmails: '[скрыто]',
      nested: { phone: '[скрыто]', ips: '[скрыто]' },
    });
  });

  it('только чтение: из всех разделов POST — лишь задачи подключений и геопроверки', async () => {
    const { io, calls } = fakeIo({
      'GET /api/users/by-username/vasya': USER(),
      'GET /api/users/stream': { users: [USER()], hasMore: false },
      'GET /api/connections/by-user/job': { isCompleted: true, result: { nodes: [] } },
      'POST /api/connections/by-user/1': { jobId: 'job' },
      'POST /api/connections/by-node/node-us': { jobId: 'job' },
      'GET /api/connections/by-node/job': { isCompleted: true, result: { users: [] } },
      'POST /api/connections/geocheck/node-us': { jobId: 'job' },
      'GET /api/connections/geocheck/job': { isCompleted: true, result: { success: true } },
      'GET /api/internal-squads': { internalSquads: [{ uuid: 'sq-1', name: 'Основной' }] },
      'GET /api/hosts': [],
      'GET ': {},
    });
    for (const topic of Object.keys(REMNAWAVE_READ_TOPICS) as RemnawaveReadTopic[])
      await read(topic, { username: 'vasya', node: 'США', squad: 'Основной' }, io);
    const posts = calls.filter((c) => c.method === 'POST').map((c) => c.path);
    expect(posts.sort()).toEqual([
      '/api/connections/by-node/node-us',
      '/api/connections/by-user/1',
      '/api/connections/geocheck/node-us',
    ]);
    // Ни одного обращения к ключам, токенам, подпискам и данным входа.
    for (const { path } of calls)
      expect(path).not.toMatch(/api-tokens|\/auth|keygen|passkey|\/subscriptions?\/|by-short-uuid|x25519/);
  });
});

describe('Ассистент читает Remnawave: имена из Telegram ID', () => {
  const tgUsers = [
    USER({ id: 11, username: '5551234567', telegramId: 5551234567 }),
    USER({ id: 12, username: 'user_7779990001', telegramId: 7779990001 }),
    USER({ id: 13, username: '4441234567', telegramId: 4441234567 }),
  ];
  const TG = ['5551234567', '7779990001', '4441234567'];
  const expectNoTelegramIds = (out: unknown) => {
    const text = JSON.stringify(out);
    for (const id of TG) expect(text).not.toContain(id);
  };

  it('длинное число в имени — последними 4 цифрами, короткие числа и слова не трогаются', () => {
    expect(maskName('5551234567')).toBe('•••4567');
    expect(maskName('user_7779990001')).toBe('user_•••0001');
    expect(maskName('vasya')).toBe('vasya');
    expect(maskName('id12345')).toBe('id12345');
  });

  it('список: имена маской; искать можно и по полному имени, и по маске', async () => {
    const { io } = fakeIo({ 'GET /api/users/stream': { users: tgUsers, hasMore: false } });
    const names = (out: Record<string, unknown>) =>
      (out.users as Array<{ username: string }>).map((u) => u.username);
    const all = await read('users', {}, io);
    expect(names(all)).toEqual(['•••4567', 'user_•••0001', '•••4567']);
    expectNoTelegramIds(all);
    expect(names(await read('users', { search: '7779990001' }, io))).toEqual(['user_•••0001']);
    expect(names(await read('users', { search: 'user_•••0001' }, io))).toEqual(['user_•••0001']);
  });

  it('по маске находится тот же пользователь; одинаковая маска у двоих — просит полное имя', async () => {
    const { io, calls } = fakeIo({
      'GET /api/users/stream': { users: tgUsers, hasMore: false },
      'GET /api/bandwidth-stats/users/12': { topNodes: [], categories: [], series: [] },
    });
    const out = await read('user_traffic', { username: 'user_•••0001' }, io);
    expect(out).toMatchObject({ username: 'user_•••0001' });
    expect(calls.at(-1)?.path).toMatch(/^\/api\/bandwidth-stats\/users\/12\?/);
    expect(await read('user_traffic', { username: '•••4567' }, io)).toEqual({
      error: 'Имя «•••4567» подходит нескольким пользователям (2) — нужно полное имя.',
    });
    expect(await read('user_traffic', { username: '•••0000' }, io)).toEqual({
      error: 'Пользователя «•••0000» нет.',
    });
    // Полное имя владелец может назвать сам — тогда ищется напрямую, а в ответе всё равно маска.
    const direct = fakeIo({
      'GET /api/users/by-username/5551234567': tgUsers[0],
      'GET /api/bandwidth-stats/users/11': { topNodes: [], categories: [], series: [] },
    });
    const byFull = await read('user_traffic', { username: '5551234567' }, direct.io);
    expect(byFull).toMatchObject({ username: '•••4567' });
    expectNoTelegramIds(byFull);
  });

  it('топы трафика, устройств, торрентов и подключений — тоже маской', async () => {
    const { io } = fakeIo({
      'GET /api/bandwidth-stats/nodes/node-us/users': { topUsers: [{ username: '5551234567', total: 1 }] },
      'GET /api/hwid/devices/stats': {},
      'GET /api/hwid/devices/top-users': { users: [{ username: 'user_7779990001', devicesCount: 4 }] },
      'GET /api/node-plugins/torrent-blocker/stats': { topUsers: [{ username: '5551234567', total: 1 }] },
      'GET /api/node-plugins/torrent-blocker?': {
        records: [{ user: { username: '4441234567' }, createdAt: iso(0) }],
      },
      'POST /api/connections/by-node/node-us': { jobId: 'j' },
      'GET /api/connections/by-node/j': { isCompleted: true, result: { users: [{ userId: 12, ips: [] }] } },
      'GET /api/users/12': tgUsers[1],
    });
    for (const [topic, args] of [
      ['node_users_traffic', { node: 'США' }],
      ['devices', {}],
      ['torrent_blocker', {}],
      ['node_connections', { node: 'США' }],
    ] as Array<[RemnawaveReadTopic, Record<string, unknown>]>) {
      const out = await read(topic, args, io);
      expect(JSON.stringify(out)).toContain('•••');
      expectNoTelegramIds(out);
    }
  });

  it('метаданных нет (Remnawave отвечает 404) — так и сказано, это не ошибка', async () => {
    const missing = Object.assign(new Error('Remnawave ответила ошибкой HTTP 404.'), { status: 404 });
    const { io } = fakeIo({
      'GET /api/users/by-username/vasya': USER(),
      'GET /api/metadata/user/1': missing,
      'GET /api/metadata/node/node-us': missing,
    });
    expect(await read('user_metadata', { username: 'vasya' }, io)).toEqual({
      username: 'vasya',
      metadata: null,
      note: 'Метаданных у пользователя нет.',
    });
    expect(await read('node_metadata', { node: 'США' }, io)).toEqual({
      node: 'США',
      metadata: null,
      note: 'Метаданных у ноды нет.',
    });
    // Другие ошибки не прячутся: их разберёт вызывающий (право ключа и т. п.).
    const denied = fakeIo({
      'GET /api/users/by-username/vasya': USER(),
      'GET /api/metadata/user/1': Object.assign(new Error('нет права'), { status: 403 }),
    });
    await expect(read('user_metadata', { username: 'vasya' }, denied.io)).rejects.toThrow('нет права');
  });
});
