import type { Capacity, CapacityCell, CapacityServer, ServerLink } from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';

import { mockServers } from './servers-mock';

/** Мок ёмкости: те же ноды, что в витрине `capacity-variants.html` (Германия-1 упирается в канал 1 Гбит). */
export const mockCapacity = { measured: [] as string[], manual: new Map<string, number | null>() };

const cell = (
  usedPct: number | null,
  limitPct: number,
  left: number | null,
  detail: string | null = null,
): CapacityCell => ({
  usedPct,
  limitPct,
  left,
  detail,
});
const link = (patch: Partial<ServerLink> = {}): ServerLink => ({
  downMbit: null,
  upMbit: null,
  source: 'none',
  nicName: 'eth0',
  nicMbit: 10_000,
  nicVirtual: true,
  measuredDownMbit: null,
  measuredUpMbit: null,
  measuredAt: null,
  manualMbit: null,
  conntrackMax: 262_144,
  probedAt: new Date().toISOString(),
  ...patch,
});

function build(): Capacity {
  const ids = mockServers.items.map((s) => ({ id: s.id, name: s.name, country: s.country.code ?? null }));
  const pick = (i: number) =>
    ids[i] ?? { id: `0192c000-cafe-7000-8000-00000000000${i}`, name: `Сервер ${i + 1}`, country: null };
  const withManual = (id: string, l: ServerLink): ServerLink => {
    const m = mockCapacity.manual.get(id);
    return m ? { ...l, manualMbit: m, upMbit: m, downMbit: m, source: 'manual' } : l;
  };
  const a = pick(0);
  const b = pick(1);
  const c = pick(2);
  const servers: CapacityServer[] = [
    {
      serverId: a.id,
      name: a.name,
      country: a.country,
      role: 'exit',
      status: 'ok',
      onlinePeak: 910,
      peakAt: new Date(Date.now() - 20 * 3_600_000).toISOString(),
      left: 60,
      bottleneck: 'net',
      tone: 'crit',
      cells: {
        cpu: cell(34, 80, 1230),
        mem: cell(22, 85, 2600),
        net: cell(89, 90, 60, '890 из 1000 Мбит/с'),
        conn: cell(18, 80, 3100, '47 тыс. из 262 тыс.'),
      },
      link: withManual(a.id, link({ manualMbit: 1000, upMbit: 1000, downMbit: 1000, source: 'manual' })),
      note: 'Упрётся в канал (1 Гбит/с). Процессор и память почти свободны. Помогут канал больше или перенос части людей на другие ноды.',
    },
    {
      serverId: b.id,
      name: b.name,
      country: b.country,
      role: 'exit',
      status: 'ok',
      onlinePeak: 300,
      peakAt: new Date(Date.now() - 44 * 3_600_000).toISOString(),
      left: 110,
      bottleneck: 'cpu',
      tone: 'warn',
      cells: {
        cpu: cell(71, 80, 110),
        mem: cell(48, 85, 260),
        net: cell(21, 90, 2900, '2,1 из 10 Гбит/с'),
        conn: cell(12, 80, 1700, '31 тыс. из 262 тыс.'),
      },
      link: withManual(
        b.id,
        mockCapacity.measured.includes(b.id)
          ? link({
              measuredDownMbit: 9400,
              measuredUpMbit: 9100,
              measuredAt: new Date().toISOString(),
              downMbit: 9400,
              upMbit: 9100,
              source: 'measured',
            })
          : link({ nicVirtual: false, nicMbit: 10_000, downMbit: 10_000, upMbit: 10_000, source: 'nic' }),
      ),
      note: 'Упрётся в процессор. Память почти свободна. Помогут больше ядер или перенос части людей.',
    },
    {
      serverId: c.id,
      name: c.name,
      country: c.country,
      role: 'exit',
      status: 'ok',
      onlinePeak: 420,
      peakAt: new Date(Date.now() - 20 * 3_600_000).toISOString(),
      left: 520,
      bottleneck: 'net',
      tone: 'ok',
      cells: {
        cpu: cell(38, 80, 780),
        mem: cell(52, 85, 560),
        net: cell(44, 90, 520, '270 из 612 Мбит/с'),
        conn: cell(20, 80, 1300, '52 тыс. из 262 тыс.'),
      },
      link: withManual(
        c.id,
        link({
          measuredDownMbit: 700,
          measuredUpMbit: 612,
          measuredAt: new Date(Date.now() - 86_400_000).toISOString(),
          downMbit: 700,
          upMbit: 612,
          source: 'measured',
        }),
      ),
      note: 'Упрётся в канал (612 Мбит/с). Процессор почти свободен.',
    },
    ...ids.slice(3).map(
      (s): CapacityServer => ({
        serverId: s.id,
        name: s.name,
        country: s.country,
        role: 'other',
        status: 'few_data',
        onlinePeak: 12,
        peakAt: null,
        left: null,
        bottleneck: null,
        tone: 'mute',
        cells: {
          cpu: cell(9, 80, null),
          mem: cell(30, 85, null),
          net: cell(null, 90, null, 'канал неизвестен'),
          conn: cell(3, 80, null),
        },
        link: link(),
        note: 'Мало людей: в пик 12 онлайн, для оценки нужно хотя бы 30.',
      }),
    ),
  ];
  return {
    computedAt: new Date().toISOString(),
    vmOk: true,
    remnawave: true,
    onlinePeak: 1630,
    peakAt: new Date(Date.now() - 20 * 3_600_000).toISOString(),
    left: 690,
    bottleneck: 'net',
    bottleneckCount: 2,
    counted: 3,
    growthPctWeek: 6,
    soonest: { days: 7, serverId: a.id, name: a.name },
    servers,
  };
}

export function resetCapacity(): void {
  mockCapacity.measured = [];
  mockCapacity.manual = new Map();
}

const linkOf = (id: string) => build().servers.find((s) => s.serverId === id)?.link ?? null;

export const capacityHandlers = [
  http.get('/api/fleet/capacity', () => HttpResponse.json(build())),
  http.post('/api/fleet/capacity/refresh', () => HttpResponse.json(build())),
  http.post('/api/servers/:id/link/measure', async ({ params }) => {
    await new Promise((r) => setTimeout(r, 300));
    mockCapacity.measured.push(String(params.id));
    return HttpResponse.json(linkOf(String(params.id)));
  }),
  http.put('/api/servers/:id/link', async ({ params, request }) => {
    const b = (await request.json()) as { manualMbit: number | null };
    mockCapacity.manual.set(String(params.id), b.manualMbit);
    return HttpResponse.json(linkOf(String(params.id)));
  }),
];
