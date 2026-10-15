import type { Incident } from '@nodeservice/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { planWaves, WaveBlock, WaveExplain, WaveMembers } from './wave-rows';

const at = (min: number) => new Date(Date.parse('2026-10-15T08:00:00Z') + min * 60_000).toISOString();
const inc = (id: string, over: Partial<Incident> = {}): Incident =>
  ({
    id,
    nodeUuid: null,
    serverId: null,
    serverName: 'Нода',
    kind: 'node_down',
    severity: 'crit',
    status: 'open',
    title: 'Нода не на связи',
    detail: '',
    timeline: [],
    attempts: [],
    proposal: null,
    snapshot: null,
    analysis: null,
    diagnostics: null,
    openedAt: at(0),
    resolvedAt: null,
    resolvedBy: null,
    ...over,
  }) as Incident;

const member = (n: string, uuid: string, incidentId: string, down: number, up: number | null = null) => ({
  serverId: null,
  nodeUuid: uuid,
  name: n,
  baseline: null,
  incidentId,
  countryCode: 'NL',
  downAt: at(down),
  upAt: up === null ? null : at(up),
});
const wave = (status: 'open' | 'resolved', ups: Array<number | null> = [null, null, null]) =>
  inc('w1', {
    kind: 'wave',
    title: 'Волна · Aeza',
    serverName: 'Aeza',
    status,
    openedAt: at(4),
    resolvedAt: status === 'resolved' ? at(25) : null,
    snapshot: {
      cpu: null,
      mem: null,
      disk: null,
      node: null,
      agentStatus: null,
      agentVersion: null,
      fleet: {
        cause: 'provider',
        groupKey: 'provider:aeza',
        groupLabel: 'Aeza',
        total: 5,
        members: [
          member('Нидерланды - 1', 'n1', 'i1', 2, ups[0] ?? null),
          member('Германия - 2 (hy2)', 'n2', 'i2', 4, ups[1] ?? null),
          member('Польша - 2 (hy2)', 'n3', 'i3', 7, ups[2] ?? null),
        ],
        skipped: [{ ruleId: 'r1', ruleName: 'Скрыть Host', nodeUuid: 'n1' }],
      },
    },
  });

/** Строки ведут на страницу события — нужен роутер. */
function withRouter(ui: () => ReactNode) {
  const root = createRootRoute({ component: ui });
  const page = createRoute({ getParentRoute: () => root, path: '/incidents/$id', component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([page, createRoute({ getParentRoute: () => root, path: '/' })]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('волна в «Событиях»', () => {
  it('события нод открытой волны не повторяются в списке — они под строкой волны', () => {
    const open = [
      wave('open'),
      inc('i1', { nodeUuid: 'n1' }),
      inc('i2', { nodeUuid: 'n2' }),
      inc('i9', { nodeUuid: 'n2', kind: 'server_down', title: 'TCP-порт недоступен' }),
      inc('x', { nodeUuid: 'other', kind: 'mem_high', severity: 'warn' }),
    ];
    const plan = planWaves(open);
    expect(plan.items.map((i) => i.id)).toEqual(['w1', 'x']);
    expect(plan.members.get('w1')?.map((i) => i.id)).toEqual(['i1', 'i2', 'i9']);
  });

  it('идёт: заголовок «N из M нод не на связи», ноды под ним видны сразу, у каждой своё время', async () => {
    const w = wave('open', [20, null, null]);
    withRouter(() => (
      <WaveBlock wave={w} members={[]} now={Date.parse(at(30))} expanded={false} onToggle={() => {}} />
    ));
    const block = await screen.findByTestId('wave-block');
    expect(block).toHaveTextContent('Волна · Aeza');
    expect(block).toHaveTextContent('2 из 5 нод не на связи');
    const rows = within(block).getAllByTestId('wave-member');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Снова на связи');
    expect(rows[2]).toHaveTextContent('Польша - 2 (hy2)');
    expect(within(block).queryByRole('button', { name: /ноды волны/ })).toBeNull();
    // Подсказка «что такое волна» — у строки волны.
    expect(within(block).getByLabelText('Что такое волна')).toHaveAttribute(
      'title',
      expect.stringContaining(
        'Волна — когда за короткое время падают сразу несколько нод одного провайдера.',
      ),
    );
  });

  it('закончилась: одна строка, ноды раскрываются стрелкой', async () => {
    const user = userEvent.setup();
    const w = wave('resolved', [21, 24, 25]);
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <WaveBlock
          wave={w}
          members={[]}
          now={Date.now()}
          expanded={open}
          onToggle={() => setOpen((v) => !v)}
        />
      );
    }
    withRouter(() => <Harness />);
    const block = await screen.findByTestId('wave-block');
    expect(block).toHaveTextContent('3 из 5 нод были не на связи');
    expect(within(block).queryAllByTestId('wave-member')).toHaveLength(0);
    await user.click(within(block).getByRole('button', { name: 'Раскрыть ноды волны' }));
    expect(within(block).getAllByTestId('wave-member')).toHaveLength(3);
    await user.click(within(block).getByRole('button', { name: 'Свернуть ноды волны' }));
    expect(within(block).queryAllByTestId('wave-member')).toHaveLength(0);
  });

  it('страница волны: «что такое волна», ноды со временем, уцелевшие ноды, пропущенные сценарии', async () => {
    const w = wave('open', [20, null, null]);
    withRouter(() => (
      <>
        <WaveExplain inc={w} />
        <WaveMembers inc={w} calm={[{ uuid: 'n4', name: 'Турция - 1', countryCode: 'TR' }]} />
      </>
    ));
    expect(await screen.findByRole('region', { name: 'Что такое волна' })).toHaveTextContent(
      'Обычно это сбой у провайдера, а не у самих нод.',
    );
    expect(screen.getByText('Ноды провайдера · Aeza')).toBeVisible();
    expect(screen.getByText('Турция - 1').closest('li')).toHaveTextContent('работала');
    expect(
      screen.getByText(/Сценарии с исключением «нода в волне» пропустили 1 срабатывание: «Скрыть Host»/),
    ).toBeVisible();
  });
});
