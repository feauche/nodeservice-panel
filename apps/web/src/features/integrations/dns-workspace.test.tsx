import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppShell } from '@/components/layout/app-shell';
import { useAuthStore } from '@/features/auth/store';
import { mockMe, resetMockState } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { DnsWorkspace } from './dns-workspace';

const DE = 'd1111111-1111-4111-8111-111111111111';
const PL = 'p2222222-2222-4222-8222-222222222222';
const rec = (
  name: string,
  zone: string,
  type: string,
  content: string,
  nodes: Array<[string, string, string]>,
) => ({
  id: `cloudflare|${zone}|${name}`,
  provider: zone === 'lumaxvds.org' ? 'regru' : 'cloudflare',
  zone,
  zoneId: zone,
  recordId: name,
  name,
  subname: name.split('.')[0],
  type,
  content,
  ttl: 300,
  nodes: nodes.map(([uuid, nodeName, address]) => ({ uuid, name: nodeName, address })),
});
const records = [
  rec('de.axelvryn.ru', 'axelvryn.ru', 'A', '177.3.216.253', [[DE, 'Германия - 1', '177.3.216.253']]),
  rec('hy-o.axelvryn.ru', 'axelvryn.ru', 'A', '147.45.126.11', [[PL, 'Польша - 2 (hy2)', '147.45.126.85']]),
  rec('www.axelvryn.ru', 'axelvryn.ru', 'CNAME', 'axelvryn.ru', []),
  rec('panel.lumaxvds.org', 'lumaxvds.org', 'A', '94.131.110.5', []),
];
let settingsBody: unknown = null;
let applyBody: unknown = null;

function Page() {
  return (
    <AppShell title="DNS интеграции">
      <DnsWorkspace />
    </AppShell>
  );
}

beforeEach(() => {
  resetMockState({ authenticated: true });
  useAuthStore.setState({ me: mockMe, hydrated: true });
  settingsBody = null;
  applyBody = null;
  server.use(
    http.get('*/api/integrations/dns/overview', () =>
      HttpResponse.json({
        domains: [
          { name: 'axelvryn.ru', provider: 'cloudflare', hosts: [] },
          { name: 'lumaxvds.org', provider: 'regru', hosts: [] },
        ],
        records,
        unmanaged: [],
        errors: [],
        checkedAt: new Date().toISOString(),
        settings: { automaticNodes: [], automaticRecords: [records[0]?.id] },
      }),
    ),
    http.get('*/api/integrations/dns/history', () =>
      HttpResponse.json({
        items: [
          {
            at: '2026-10-09T09:02:00.000Z',
            domain: 'hy-o.axelvryn.ru',
            provider: 'cloudflare',
            old: '147.45.126.4',
            next: '147.45.126.11',
            status: 'success',
            automatic: true,
          },
        ],
      }),
    ),
    http.put('*/api/integrations/dns/settings', async ({ request }) => {
      settingsBody = await request.json();
      return HttpResponse.json({ automaticNodes: [], automaticRecords: [] });
    }),
    http.post('*/api/integrations/dns/apply', async ({ request }) => {
      applyBody = await request.json();
      return HttpResponse.json({ changed: true });
    }),
    http.get('*/api/integrations', () =>
      HttpResponse.json({
        items: ['cloudflare', 'regru'].map((provider) => ({
          provider,
          connected: true,
          checkedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          domains: [],
          balance: null,
        })),
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
          [DE, 'Германия - 1', '177.3.216.253', 'DE'],
          [PL, 'Польша - 2 (hy2)', '147.45.126.85', 'PL'],
        ].map(([uuid, name, address, countryCode]) => ({
          uuid,
          name,
          address,
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

describe('DNS интеграции (вариант A): домены карточками', () => {
  it('показатели и фильтры со счётчиками; расхождение подсвечено с «Заменить», автозамена — в строке', async () => {
    const user = userEvent.setup();
    renderPage(Page, '/integrations/dns');
    const zone = await screen.findByRole('region', { name: 'Домен axelvryn.ru' });
    expect(screen.getByRole('button', { name: 'Отличаются1' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Все4' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Без ноды2' })).toBeVisible();
    const diff = within(zone).getByRole('button', { name: 'Запись hy-o.axelvryn.ru' });
    expect(diff).toHaveTextContent('у ноды 147.45.126.85');
    expect(within(diff).getByRole('button', { name: 'Заменить' })).toBeVisible();
    // Расхождение — первой строкой домена.
    expect(within(zone).getAllByRole('button', { name: /^Запись / })[0]).toBe(diff);
    const auto = within(zone).getByRole('switch', { name: 'Автозамена de.axelvryn.ru' });
    expect(auto).toHaveAttribute('aria-checked', 'true');
    await user.click(auto);
    await waitFor(() => expect(settingsBody).toEqual({ recordId: records[0]?.id, enabled: false }));
    // Переключатель не открывает окно записи.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('фильтр «Отличаются» и поиск по домену, адресу и ноде', async () => {
    const user = userEvent.setup();
    renderPage(Page, '/integrations/dns');
    await screen.findByRole('region', { name: 'Домен axelvryn.ru' });
    await user.click(screen.getByRole('button', { name: 'Отличаются1' }));
    expect(
      screen.getAllByRole('button', { name: /^Запись / }).map((r) => r.getAttribute('aria-label')),
    ).toEqual(['Запись hy-o.axelvryn.ru']);
    expect(screen.queryByRole('region', { name: 'Домен lumaxvds.org' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Все4' }));
    await user.type(screen.getByRole('textbox', { name: 'Поиск записей' }), 'Германия');
    expect(
      screen.getAllByRole('button', { name: /^Запись / }).map((r) => r.getAttribute('aria-label')),
    ).toEqual(['Запись de.axelvryn.ru']);
  });

  it('окно записи: адрес в DNS и у ноды, история записи, замена с проверкой старого адреса', async () => {
    const user = userEvent.setup();
    renderPage(Page, '/integrations/dns');
    const row = await screen.findByRole('button', { name: 'Запись hy-o.axelvryn.ru' });
    await user.click(within(row).getByRole('button', { name: 'Заменить' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('В DNS сейчас147.45.126.11');
    expect(dialog).toHaveTextContent('Адрес ноды147.45.126.85');
    expect(within(dialog).getByRole('list', { name: 'История записи' })).toHaveTextContent(
      '147.45.126.4 → 147.45.126.11Автозамена',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Заменить на 147.45.126.85' }));
    await waitFor(() =>
      expect(applyBody).toEqual({ recordId: records[1]?.id, nodeUuid: PL, expected: '147.45.126.11' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('из события ноды: «Открыть запись в DNS-интеграциях» сразу открывает окно этой записи', async () => {
    let used = 0;
    function FromIncident() {
      return (
        <AppShell title="DNS интеграции">
          <DnsWorkspace initialRecord={records[1]?.id} onInitialRecordUsed={() => (used += 1)} />
        </AppShell>
      );
    }
    renderPage(FromIncident, '/integrations/dns');
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('hy-o.axelvryn.ru');
    expect(dialog).toHaveTextContent('В DNS сейчас147.45.126.11');
    expect(used).toBe(1);
  });

  it('кнопки в шапке страницы: «Подключения» с аккаунтами и «История замен»', async () => {
    const user = userEvent.setup();
    renderPage(Page, '/integrations/dns');
    await screen.findByRole('region', { name: 'Домен axelvryn.ru' });
    await user.click(screen.getByRole('button', { name: 'Подключения' }));
    const accounts = await screen.findByRole('dialog', { name: 'Подключения DNS' });
    expect(await within(accounts).findByText(/1 зона · токен API · проверено 5 мин назад/)).toBeVisible();
    expect(within(accounts).getAllByText('Подключён')).toHaveLength(2);
    await user.click(within(accounts).getAllByRole('button', { name: 'Отключить' })[0] as HTMLElement);
    expect(await screen.findByRole('alertdialog', { name: 'Отключить Cloudflare?' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Нет' }));
    await user.click(within(accounts).getByRole('button', { name: 'Закрыть' }));
    await user.click(screen.getByRole('button', { name: 'История замен' }));
    const history = await screen.findByRole('dialog', { name: 'История замен' });
    expect(within(history).getByRole('list', { name: 'История замен' })).toHaveTextContent(
      'hy-o.axelvryn.ru147.45.126.4 → 147.45.126.11',
    );
  });
});
