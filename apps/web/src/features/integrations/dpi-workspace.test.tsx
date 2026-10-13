import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppShell } from '@/components/layout/app-shell';
import { useAuthStore } from '@/features/auth/store';
import { mockMe, resetMockState } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { DpiWorkspace } from './dpi-workspace';

const US = 'a1111111-1111-4111-8111-111111111111';
const TR = 'b2222222-2222-4222-8222-222222222222';
const DE = 'c3333333-3333-4333-8333-333333333333';
const point = (location: string, state: 'ok' | 'fail' | 'unknown', reason: string | null, extra = {}) => ({
  location,
  popId: null,
  accessible: state === 'ok' ? true : state === 'fail' ? false : null,
  state,
  reason,
  latency: state === 'ok' ? 120 : null,
  tls: '0 из 5',
  throttled: '0 из 5',
  port80: 'не перехвачен',
  ...extra,
});
const check = (id: string, node: [string, string] | null, extra: Record<string, unknown>) => ({
  id,
  kind: 'ip',
  status: 'completed',
  createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  completedAt: new Date(Date.now() - 3_540_000).toISOString(),
  cost: 0.04,
  refunded: false,
  total: 2,
  success: 0,
  unknown: 0,
  progress: null,
  source: 'api',
  results: [],
  node: node ? { uuid: node[0], name: node[1], panel: 'panel.example' } : null,
  ...extra,
});
const checks = [
  check('9600', [US, 'США - 1'], {
    total: 3,
    success: 0,
    unknown: 1,
    results: [
      point('Москва Ростелеком', 'fail', 'Порт открыт, TLS не проходит'),
      point('Амурская обл.', 'fail', 'Порт открыт, TLS не проходит'),
      point('Казань', 'unknown', 'Точка сама без связи — не в счёт'),
    ],
  }),
  check('9601', [TR, 'Турция - 1'], {
    total: 1,
    success: 1,
    results: [point('Омск МТС', 'ok', 'Сертификат другого имени — для Reality это норма', { tls: '5 из 5' })],
  }),
  check('9602', [DE, 'Германия - 1'], {
    status: 'pending',
    createdAt: new Date().toISOString(),
    completedAt: null,
    total: 10,
    success: null,
    progress: { done: 0, total: 10, percent: 0 },
  }),
];
let started: unknown = null;
let cancelled = false;
let schedule: unknown = null;

function Page() {
  return (
    <AppShell title="DPI Checker">
      <DpiWorkspace settings={() => {}} />
    </AppShell>
  );
}

beforeEach(() => {
  resetMockState({ authenticated: true });
  useAuthStore.setState({ me: mockMe, hydrated: true });
  started = null;
  cancelled = false;
  schedule = null;
  server.use(
    http.get('*/api/integrations/dpi/overview', () =>
      HttpResponse.json({
        checks,
        pops: [
          { id: 39, name: 'Москва', provider: 'Rostelecom' },
          { id: 35, name: 'Омск', provider: 'MTS' },
        ],
        schedule: { enabled: false, minutes: 60, nodes: [], pops: [], nextAt: null, lastError: null },
        balance: '5.868',
        prices: { ipPop: 0.003, ipResource: 0.001, vpnPop: 0.008, vpnResource: 0.002 },
        probePrice: { fixed: 1, perGb: 1.5 },
        optimal: 10,
      }),
    ),
    http.get('*/api/integrations/dpi/checks/:id', ({ params }) =>
      HttpResponse.json(checks.find((c) => c.id === params.id)),
    ),
    http.post('*/api/integrations/dpi/estimate', () =>
      HttpResponse.json({ cost: 0.04, balance: 5.868, affordable: true, minutes: 7, pops: 10 }),
    ),
    http.post('*/api/integrations/dpi/checks', async ({ request }) => {
      started = await request.json();
      return HttpResponse.json(checks[2]);
    }),
    http.post('*/api/integrations/dpi/checks/:id/cancel', () => {
      cancelled = true;
      return HttpResponse.json({ refunded: 0.04 });
    }),
    http.put('*/api/integrations/dpi/schedule', async ({ request }) => {
      schedule = await request.json();
      return HttpResponse.json({ ...(schedule as object), nextAt: null, lastError: null });
    }),
    http.get('*/api/integrations/dpi/tools/noisy/quota', () =>
      HttpResponse.json({ left: 20, limit: 20, unlimited: false }),
    ),
    http.get('*/api/integrations/dpi/tools/rkn/:node', () =>
      HttpResponse.json({
        address: '45.12.8.20',
        blocked: true,
        subnet: '45.12.0.0/16',
        domain: false,
        network: 'Example Hosting · NL',
        refreshedAt: '2026-10-13T02:49:08.732Z',
      }),
    ),
    http.get('*/api/nodes/status', () =>
      HttpResponse.json({
        connected: true,
        domain: 'panel.example',
        checkedAt: null,
        error: null,
        stats: null,
        cert: null,
        nodes: [
          [DE, 'Германия - 1', 'DE'],
          [TR, 'Турция - 1', 'TR'],
          [US, 'США - 1', 'US'],
        ].map(([uuid, name, countryCode]) => ({
          uuid,
          name,
          address: '45.12.8.20',
          countryCode,
          isConnected: true,
          isDisabled: false,
          isConnecting: false,
          lastStatusMessage: null,
          usersOnline: 0,
          trafficUsedBytes: null,
          trafficLimitBytes: null,
        })),
      }),
    ),
  );
});

describe('DPI Checker (вариант A): итог по нодам', () => {
  it('баланс с «хватит на», ноды с итогом: недоступные наверху, точка без связи не в счёт', async () => {
    renderPage(Page, '/integrations/dpi');
    const nodes = await screen.findByRole('region', { name: 'Ноды' });
    expect(screen.getByText('≈ 146 проверок IP')).toBeVisible();
    const rows = within(nodes).getAllByRole('button', { name: /^Проверить / });
    // Недоступная «США - 1» — первой, идущая «Германия - 1» — следом, доступная «Турция - 1» — после них.
    expect(rows.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Проверить США - 1',
      'Проверить Германия - 1',
      'Проверить Турция - 1',
    ]);
    expect(nodes).toHaveTextContent('0 из 2 открывается · без связи 1');
    expect(nodes).toHaveTextContent('Недоступна');
    expect(screen.getByRole('list', { name: 'Проверки DPI Checker' })).toHaveTextContent('В очереди');
  });

  it('новая проверка: цена до запуска, «Запустить за 0,04 $», запуск с номером запроса', async () => {
    const user = userEvent.setup();
    renderPage(Page, '/integrations/dpi');
    const nodes = await screen.findByRole('region', { name: 'Ноды' });
    await user.click(within(nodes).getByRole('button', { name: 'Проверить Турция - 1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Новая проверка' });
    expect(await within(dialog).findByText('0,04 $')).toBeVisible();
    expect(dialog).toHaveTextContent('Стоимость 0,04 $ · на балансе 5,87 $ · хватит · до 7 мин');
    await user.click(within(dialog).getByRole('button', { name: 'Запустить за 0,04 $' }));
    await waitFor(() => expect(started).toMatchObject({ nodeUuid: TR, kind: 'ip', popIds: [] }));
    expect((started as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('окно результата: итог словами, плитки с причиной; не начатую проверку можно отменить', async () => {
    const user = userEvent.setup();
    renderPage(Page, '/integrations/dpi');
    const list = await screen.findByRole('list', { name: 'Проверки DPI Checker' });
    await user.click(within(list).getByRole('button', { name: /США - 1 · режим IP/ }));
    const result = await screen.findByRole('dialog');
    expect(result).toHaveTextContent('Не открывается ни в одном из 2 регионов');
    expect(result).toHaveTextContent('TLS не устанавливается ни разу');
    expect(result).toHaveTextContent('1 точка была без связи — они не в счёт');
    expect(within(result).getByRole('list', { name: 'Регионы' })).toHaveTextContent(
      'Москва РостелекомПорт открыт, TLS не проходит',
    );
    await user.click(within(result).getByRole('button', { name: 'Закрыть' }));
    await user.click(within(list).getByRole('button', { name: /Германия - 1 · режим IP/ }));
    const pending = await screen.findByRole('dialog');
    expect(pending).toHaveTextContent('Проверка в очереди');
    await user.click(within(pending).getByRole('button', { name: 'Отменить' }));
    await waitFor(() => expect(cancelled).toBe(true));
  });

  it('расписание: ноды и частота, цена запуска и суток; реестр РКН — итог по-русски', async () => {
    const user = userEvent.setup();
    renderPage(Page, '/integrations/dpi');
    await screen.findByRole('region', { name: 'Ноды' });
    await user.click(screen.getByRole('button', { name: 'Расписание' }));
    const dialog = await screen.findByRole('dialog', { name: 'Расписание проверок' });
    await user.click(within(dialog).getByRole('switch', { name: 'Проверять по расписанию' }));
    await user.click(within(dialog).getByRole('button', { name: 'Выбрать все' }));
    expect(dialog).toHaveTextContent('За запуск ≈ 0,12 $, за сутки ≈ 2,88 $.');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(schedule).toMatchObject({ enabled: true, minutes: 60, pops: [] }));
    expect((schedule as { nodes: string[] }).nodes).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Проверить адрес' }));
    const rkn = await screen.findByRole('dialog', { name: 'Реестр РКН' });
    await user.click(within(rkn).getByRole('combobox', { name: 'Нода' }));
    await user.click(await screen.findByRole('option', { name: /США - 1/ }));
    await user.click(within(rkn).getByRole('button', { name: 'Проверить адрес' }));
    expect(await within(rkn).findByText('Адрес 45.12.8.20 в реестре РКН')).toBeVisible();
    expect(rkn).toHaveTextContent('вся подсеть 45.12.0.0/16');
  });
});
