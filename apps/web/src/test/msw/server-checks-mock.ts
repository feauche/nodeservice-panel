import {
  type BlockCheckResult,
  SERVER_CHECK_AUTO_KEYS,
  SERVER_CHECK_INTERVAL_HOURS,
  SERVER_CHECK_META,
  SERVER_CHECK_PROBLEM,
  type ServerCheckKey,
  type ServerCheckRun,
  serverCheckKeySchema,
} from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';

import { mockAutochecks } from './autochecks-mock';

/**
 * Мок реестра проверок: запуски в памяти, «идущая» проверка дописывает вывод по таймеру и завершается —
 * как на живом сервере, только быстрее (speedMs). «Объяснить» отвечает готовым пересказом.
 */
export const mockServerChecks = {
  runs: [] as ServerCheckRun[],
  speedMs: 30,
  timers: [] as ReturnType<typeof setTimeout>[],
};

let seq = 0;
const uuid = () => `0192c000-cccc-7000-8000-${String(++seq).padStart(12, '0')}`;

const RUSSIA_RESULT: BlockCheckResult = {
  nodeName: 'Нидерланды - 1',
  address: '1.2.3.4',
  sniUsed: 'mask.example',
  probes: [
    {
      from: 'Россия - 1',
      verdict: 'ok',
      detail: 'TLS-подключение и передача данных прошли без обрывов.',
      stalledAtKb: null,
      error: null,
    },
  ],
  foreign: [
    {
      from: 'Германия - 1',
      verdict: 'ok',
      detail: 'TCP-порт отвечает.',
      stalledAtKb: null,
      error: null,
    },
  ],
  verdict: 'ok',
  unchecked: null,
  foreignUnchecked: null,
  entry: null,
};

const SAMPLE: Record<ServerCheckKey, string> = {
  russia_access: JSON.stringify(RUSSIA_RESULT),
  cpu: 'Устанавливаю недостающий пакет: sysbench\n== Одно ядро\nCPU speed:\n    events per second:  1180.42\n== Все ядра: 2\nCPU speed:\n    events per second:  2310.77\n',
  ip_region:
    'Service        Country\nMaxMind        NL\nIPinfo         NL\nCloudflare     NL\nYouTube        NL\nChatGPT        DE\n',
  geoblock:
    'Checking geoblock...\nyoutube.com        OK\nopenai.com         OK\nspotify.com        BLOCKED (451)\nnetflix.com        OK\nTotal: 1 blocked of 38\n',
  dpi: 'Checking DPI (RU servers)...\nya.ru              OK  84ms\nvk.com             OK  91ms\nTotal: 31 OK, 0 failed\n',
  ip_quality: 'IPQuality\nIP type: Hosting\nRisk score: low\nBlacklists: 0 of 439\n',
  iperf3_ru:
    'Moscow    download 812 Mbit/s  upload 640 Mbit/s\nSt.Petersburg download 790 Mbit/s upload 610 Mbit/s\n',
  yabs: 'fio Disk Speed Tests:\n  Read 420.1 MB/s\nGeekbench 6:\n  Single Core 1020\n  Multi Core 1870\n',
};

const EXPLAIN: Partial<Record<ServerCheckKey, string>> = {
  geoblock:
    'Из 38 сервисов не открывается только Spotify (отказ по стране). Если пользователям этого сервера он нужен, направьте их через другой выход.',
};

export function seedServerChecks(
  serverId: string,
  keys: ServerCheckKey[] = ['cpu', 'ip_region', 'geoblock', 'dpi'],
): void {
  const at = Date.now() - 3 * 3_600_000;
  for (const check of keys)
    mockServerChecks.runs.push({
      id: uuid(),
      serverId,
      check,
      status: check === 'dpi' ? 'failed' : 'ok',
      trigger: 'auto',
      actorDisplay: null,
      startedAt: new Date(at).toISOString(),
      finishedAt: new Date(at + 90_000).toISOString(),
      output: check === 'dpi' ? 'Checking DPI (RU servers)...\n' : SAMPLE[check],
      error: check === 'dpi' ? 'Проверка не уложилась в отведённое время и была остановлена.' : null,
      explanation: null,
    });
}

export function resetServerChecks(): void {
  for (const t of mockServerChecks.timers) clearTimeout(t);
  mockServerChecks.timers = [];
  mockServerChecks.runs = [];
}

const latest = (serverId: string) => {
  const by = new Map<ServerCheckKey, ServerCheckRun>();
  for (const r of mockServerChecks.runs)
    if (r.serverId === serverId) {
      const cur = by.get(r.check);
      if (!cur || cur.startedAt <= r.startedAt) by.set(r.check, r);
    }
  return [...by.values()];
};

export const serverChecksHandlers = [
  http.get('/api/servers/:id/checks', ({ params }) => {
    const items = latest(String(params.id));
    // Как в api: срок — только у своих проверок и только при включённом тумблере в «Автопроверках».
    const autoEnabled = mockAutochecks.value.serverChecksEnabled;
    const auto = autoEnabled ? items.filter((r) => SERVER_CHECK_AUTO_KEYS.includes(r.check)) : [];
    const earliest = auto.length ? Math.min(...auto.map((r) => Date.parse(r.startedAt))) : null;
    return HttpResponse.json({
      items,
      autoEnabled,
      nextAutoAt:
        earliest === null ? null : new Date(earliest + SERVER_CHECK_INTERVAL_HOURS * 3_600_000).toISOString(),
    });
  }),
  http.post('/api/servers/:id/checks/:check/run', async ({ params, request }) => {
    const serverId = String(params.id);
    const check = serverCheckKeySchema.parse(params.check);
    const body = (await request.json().catch(() => ({}))) as { confirmHeavy?: boolean };
    if (SERVER_CHECK_META[check].heavy && !body.confirmHeavy)
      return HttpResponse.json(
        {
          type: SERVER_CHECK_PROBLEM.heavyConfirm,
          title: 'Неверный запрос',
          status: 400,
          detail: 'Подтвердите запуск.',
        },
        { status: 400, headers: { 'content-type': 'application/problem+json' } },
      );
    if (latest(serverId).some((r) => r.status === 'running'))
      return HttpResponse.json(
        {
          type: SERVER_CHECK_PROBLEM.busy,
          title: 'Конфликт',
          status: 409,
          detail: 'На этом сервере уже идёт проверка.',
        },
        { status: 409, headers: { 'content-type': 'application/problem+json' } },
      );
    const run: ServerCheckRun = {
      id: uuid(),
      serverId,
      check,
      status: 'running',
      trigger: 'manual',
      actorDisplay: 'admin',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      output: '',
      blockResult: null,
      error: null,
      explanation: null,
    };
    mockServerChecks.runs.push(run);
    const lines = SAMPLE[check].split('\n');
    lines.forEach((line, i) => {
      mockServerChecks.timers.push(
        setTimeout(
          () => {
            run.output += `${line}\n`;
            if (i === lines.length - 1) {
              run.status = 'ok';
              run.finishedAt = new Date().toISOString();
              if (check === 'russia_access') run.blockResult = RUSSIA_RESULT;
            }
          },
          mockServerChecks.speedMs * (i + 1),
        ),
      );
    });
    return HttpResponse.json(run, { status: 202 });
  }),
  http.post('/api/servers/:id/checks/runs/:runId/explain', ({ params }) => {
    const run = mockServerChecks.runs.find((r) => r.id === params.runId);
    if (!run)
      return HttpResponse.json({ status: 404, title: 'Не найдено', type: 'about:blank' }, { status: 404 });
    run.explanation ??=
      EXPLAIN[run.check] ??
      (run.status === 'failed'
        ? 'Проверка не успела: сторонний сервис проверки долго не отвечал. Повторите позже — на сервер это не указывает.'
        : 'Всё в порядке: по выводу проблем для VPN-сервера не видно.');
    return HttpResponse.json(run);
  }),
];
