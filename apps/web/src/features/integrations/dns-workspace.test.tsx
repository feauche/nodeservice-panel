import { act, screen, waitFor, within } from '@testing-library/react';
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

describe('DNS: свой адрес вместо адреса ноды (вариант B)', () => {
  const overview = (list: unknown[]) =>
    http.get('*/api/integrations/dns/overview', () =>
      HttpResponse.json({
        domains: [
          { name: 'axelvryn.ru', provider: 'cloudflare', hosts: [] },
          { name: 'lumaxvds.org', provider: 'regru', hosts: [] },
        ],
        records: list,
        unmanaged: [],
        errors: [],
        checkedAt: new Date().toISOString(),
        settings: { automaticNodes: [], automaticRecords: [] },
      }),
    );

  it('запись без ноды открывается на «Свой адрес»: ошибка по-русски, замена уходит со своим адресом', async () => {
    const user = userEvent.setup();
    renderPage(Page, '/integrations/dns');
    const row = await screen.findByRole('button', { name: 'Запись panel.lumaxvds.org' });
    await user.click(row);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: 'Свой адрес' })).toHaveAttribute('aria-checked', 'true');
    const input = within(dialog).getByRole('textbox', { name: 'Новый адрес' });
    expect(input).toHaveValue('94.131.110.5');
    expect(within(dialog).queryByText(/Автозамена/)).toBeNull();
    await user.clear(input);
    await user.type(input, '203.0.113.');
    expect(within(dialog).getByText(/Введите IPv4-адрес целиком/)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Заменить' })).toBeDisabled();
    await user.type(input, '10');
    expect(within(dialog).queryByText(/Введите IPv4-адрес целиком/)).toBeNull();
    expect(dialog).toHaveTextContent('Станет203.0.113.10');
    await user.click(within(dialog).getByRole('button', { name: 'Заменить на 203.0.113.10' }));
    await waitFor(() =>
      expect(applyBody).toEqual({
        recordId: records[3]?.id,
        address: '203.0.113.10',
        expected: '94.131.110.5',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('запись с нодой открывается на «Адрес ноды»; «Свой адрес» предупреждает, что автозамена выключится', async () => {
    const user = userEvent.setup();
    renderPage(Page, '/integrations/dns');
    await user.click(await screen.findByRole('button', { name: 'Запись de.axelvryn.ru' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: 'Адрес ноды' })).toHaveAttribute('aria-checked', 'true');
    expect(within(dialog).getByRole('switch')).toBeVisible();
    await user.click(within(dialog).getByRole('radio', { name: 'Свой адрес' }));
    expect(within(dialog).getByRole('note')).toHaveTextContent(
      'Запись связана с нодой «Германия - 1». Со своим адресом автозамена для неё выключится',
    );
    expect(within(dialog).queryByRole('switch')).toBeNull();
    await user.type(within(dialog).getByRole('textbox', { name: 'Новый адрес' }), '198.51.100.7');
    await user.click(within(dialog).getByRole('button', { name: 'Заменить на 198.51.100.7' }));
    await waitFor(() =>
      expect(applyBody).toEqual({
        recordId: records[0]?.id,
        address: '198.51.100.7',
        expected: '177.3.216.253',
      }),
    );
  });

  it('тот же адрес у записи без пометки — «Оставить свой адрес»: запись перестаёт сравниваться с нодой', async () => {
    const user = userEvent.setup();
    renderPage(Page, '/integrations/dns');
    await user.click(await screen.findByRole('button', { name: 'Запись hy-o.axelvryn.ru' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: 'Свой адрес' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Новый адрес' }), '147.45.126.11');
    await user.click(within(dialog).getByRole('button', { name: 'Оставить свой адрес' }));
    await waitFor(() =>
      expect(applyBody).toEqual({
        recordId: records[1]?.id,
        address: '147.45.126.11',
        expected: '147.45.126.11',
      }),
    );
  });

  it('запись со своим адресом: метка в списке, не «отличается», без автозамены; в окне — «Свой адрес» уже выбран', async () => {
    const custom = {
      ...rec('hy-o.axelvryn.ru', 'axelvryn.ru', 'A', '203.0.113.10', [
        [PL, 'Польша - 2 (hy2)', '147.45.126.85'],
      ]),
      custom: true,
    };
    server.use(overview([records[0], custom, records[3]]));
    const user = userEvent.setup();
    renderPage(Page, '/integrations/dns');
    const row = await screen.findByRole('button', { name: 'Запись hy-o.axelvryn.ru' });
    expect(row).toHaveTextContent('свой адрес');
    expect(row).toHaveTextContent('у ноды 147.45.126.85');
    expect(within(row).queryByRole('button', { name: 'Заменить' })).toBeNull();
    expect(within(row).queryByRole('switch')).toBeNull();
    expect(screen.getByRole('button', { name: 'Отличаются0' })).toBeVisible();
    await user.click(row);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: 'Свой адрес' })).toHaveAttribute('aria-checked', 'true');
    expect(within(dialog).getByRole('textbox', { name: 'Новый адрес' })).toHaveValue('203.0.113.10');
    expect(within(dialog).getByRole('note')).toHaveTextContent('автозамена для неё выключена');
    expect(within(dialog).queryByRole('button', { name: /Оставить свой адрес|Заменить/ })).toBeNull();
    await user.click(within(dialog).getByRole('radio', { name: 'Адрес ноды' }));
    expect(dialog).toHaveTextContent('Автозамена выключена: у записи свой адрес');
  });

  it('AAAA: нужен IPv6, IPv4 отклоняется', async () => {
    const aaaa = rec('v6.axelvryn.ru', 'axelvryn.ru', 'AAAA', '2001:db8::1', []);
    server.use(overview([aaaa]));
    const user = userEvent.setup();
    renderPage(Page, '/integrations/dns');
    await user.click(await screen.findByRole('button', { name: 'Запись v6.axelvryn.ru' }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByRole('textbox', { name: 'Новый адрес' });
    await user.clear(input);
    await user.type(input, '203.0.113.10');
    expect(within(dialog).getByText(/Введите IPv6-адрес целиком/)).toBeVisible();
    await user.clear(input);
    await user.type(input, '2001:db8::2');
    expect(within(dialog).getByRole('button', { name: 'Заменить на 2001:db8::2' })).toBeEnabled();
  });

  it('CNAME и другие записи не-адреса — только просмотр: без выбора ноды и своего адреса, плитки про ноду нет', async () => {
    const user = userEvent.setup();
    renderPage(Page, '/integrations/dns');
    await user.click(await screen.findByRole('button', { name: 'Запись www.axelvryn.ru' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('CNAME-запись указывает не на IP-адрес — её можно только посмотреть');
    expect(dialog).toHaveTextContent('В DNS сейчасaxelvryn.ru');
    // Ни переключателя, ни поля адреса, ни плитки «Адрес ноды» с подписью «выберите ноду», ни подписи про привязку.
    expect(within(dialog).queryByRole('radio')).toBeNull();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(within(dialog).queryByText(/Адрес ноды/)).toBeNull();
    expect(within(dialog).queryByText('выберите ноду')).toBeNull();
    expect(within(dialog).queryByText('не привязана к ноде')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /Заменить/ })).toBeNull();
    expect(applyBody).toBeNull();
  });

  it('в истории записи замена на свой адрес подписана «Свой адрес»', async () => {
    server.use(
      http.get('*/api/integrations/dns/history', () =>
        HttpResponse.json({
          items: [
            {
              at: '2026-10-14T09:02:00.000Z',
              domain: 'panel.lumaxvds.org',
              provider: 'regru',
              old: '94.131.110.4',
              next: '94.131.110.5',
              status: 'success',
              automatic: false,
              custom: true,
            },
          ],
        }),
      ),
    );
    const user = userEvent.setup();
    renderPage(Page, '/integrations/dns');
    await user.click(await screen.findByRole('button', { name: 'Запись panel.lumaxvds.org' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('list', { name: 'История записи' })).toHaveTextContent(
      '94.131.110.4 → 94.131.110.5Свой адрес',
    );
  });
});

describe('DNS: домены сворачиваются (витрина heartbeat-dns-2026-10, вариант A)', () => {
  const KEY = 'ns-dns-zones';
  const AX = 'cloudflare:axelvryn.ru';
  const zoneButton = (zone: HTMLElement) => within(zone).getByRole('button', { name: 'axelvryn.ru' });
  const rowInert = (zone: HTMLElement, name: string) =>
    within(zone)
      .getByRole('button', { name: `Запись ${name}`, hidden: true })
      .closest('[inert]');

  it('по умолчанию развёрнуто; свёрнутый домен помнит браузер, расхождение видно на заголовке', async () => {
    const user = userEvent.setup();
    const first = renderPage(Page, '/integrations/dns');
    const zone = await screen.findByRole('region', { name: 'Домен axelvryn.ru' });
    expect(zoneButton(zone)).toHaveAttribute('aria-expanded', 'true');
    expect(rowInert(zone, 'de.axelvryn.ru')).toBeNull();
    await user.click(zoneButton(zone));
    expect(zoneButton(zone)).toHaveAttribute('aria-expanded', 'false');
    // Записи свёрнутого домена клавиатурой не выбираются.
    expect(rowInert(zone, 'de.axelvryn.ru')).not.toBeNull();
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify([AX]));
    // Тревога не прячется: «1 отличается» и жёлтая кромка у свёрнутого.
    expect(within(zone).getByText('1 отличается')).toBeVisible();
    expect(zoneButton(zone).closest('header')?.className).toContain('var(--ns-warn)');
    // Второй домен не тронут.
    const regru = screen.getByRole('region', { name: 'Домен lumaxvds.org' });
    expect(within(regru).getByRole('button', { name: 'lumaxvds.org' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    // Обновление страницы: домен остаётся свёрнутым.
    first.unmount();
    renderPage(Page, '/integrations/dns');
    const again = await screen.findByRole('region', { name: 'Домен axelvryn.ru' });
    expect(zoneButton(again)).toHaveAttribute('aria-expanded', 'false');
    await user.click(zoneButton(again));
    expect(zoneButton(again)).toHaveAttribute('aria-expanded', 'true');
    expect(localStorage.getItem(KEY)).toBe('[]');
  });

  it('поиск раскрывает свёрнутый домен на время, с пометкой, и не меняет запомненное', async () => {
    localStorage.setItem(KEY, JSON.stringify([AX]));
    const user = userEvent.setup();
    renderPage(Page, '/integrations/dns');
    const zone = await screen.findByRole('region', { name: 'Домен axelvryn.ru' });
    expect(zoneButton(zone)).toHaveAttribute('aria-expanded', 'false');
    expect(within(zone).queryByText('раскрыт для поиска')).toBeNull();
    const search = screen.getByRole('textbox', { name: 'Поиск записей' });
    await user.type(search, 'Германия');
    expect(zoneButton(zone)).toHaveAttribute('aria-expanded', 'true');
    expect(within(zone).getByText('раскрыт для поиска')).toBeVisible();
    expect(within(zone).getByText('найдено 1')).toBeVisible();
    expect(rowInert(zone, 'de.axelvryn.ru')).toBeNull();
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify([AX]));
    await user.clear(search);
    expect(zoneButton(zone)).toHaveAttribute('aria-expanded', 'false');
    expect(within(zone).queryByText('раскрыт для поиска')).toBeNull();
    expect(within(zone).queryByText(/^найдено/)).toBeNull();

    // Фильтр раскрывает так же; нажатие на раскрытый на время — разворачивает по-настоящему.
    await user.click(screen.getByRole('button', { name: 'Отличаются1' }));
    expect(within(zone).getByText('раскрыт для поиска')).toBeVisible();
    await user.click(zoneButton(zone));
    expect(zoneButton(zone)).toHaveAttribute('aria-expanded', 'true');
    expect(within(zone).queryByText('раскрыт для поиска')).toBeNull();
    expect(localStorage.getItem(KEY)).toBe('[]');
  });

  it('свернули во время поиска — домен не раскрывается сам и запомнен', async () => {
    const user = userEvent.setup();
    renderPage(Page, '/integrations/dns');
    const zone = await screen.findByRole('region', { name: 'Домен axelvryn.ru' });
    const search = screen.getByRole('textbox', { name: 'Поиск записей' });
    await user.type(search, 'axelvryn');
    await user.click(zoneButton(zone));
    expect(zoneButton(zone)).toHaveAttribute('aria-expanded', 'false');
    expect(within(zone).queryByText('раскрыт для поиска')).toBeNull();
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify([AX]));
    await user.type(search, '.ru');
    expect(zoneButton(zone)).toHaveAttribute('aria-expanded', 'false');
    await user.clear(search);
    expect(zoneButton(zone)).toHaveAttribute('aria-expanded', 'false');
  });

  it('свернули в другой вкладке — здесь тоже', async () => {
    renderPage(Page, '/integrations/dns');
    const zone = await screen.findByRole('region', { name: 'Домен axelvryn.ru' });
    localStorage.setItem(KEY, JSON.stringify([AX, 'cloudflare:старый-домен.ru']));
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    });
    expect(zoneButton(zone)).toHaveAttribute('aria-expanded', 'false');
    expect(
      within(screen.getByRole('region', { name: 'Домен lumaxvds.org' })).getByRole('button', {
        name: 'lumaxvds.org',
      }),
    ).toHaveAttribute('aria-expanded', 'true');
  });
});
