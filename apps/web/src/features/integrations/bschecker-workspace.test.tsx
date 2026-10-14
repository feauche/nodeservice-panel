import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockState } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { BsCheckerWorkspace } from './bschecker-workspace';

const id = '4fab6a97-4d4e-42b7-a84d-6825b8375a72';
const row = (
  unit: string,
  operator: string,
  region: string,
  dpi: string,
  tcp: boolean | null,
  icmp: boolean | null,
) => ({
  unit,
  operator,
  region,
  dpi,
  tcp,
  icmp,
  tcpIsTls: false,
  latency: tcp ? 42 : null,
  dnsFail: false,
  error: null,
});
const run = {
  id,
  status: 'done',
  costCredits: 19,
  refundedCredits: 0,
  error: null,
  rows: [
    row('beeline|уфо|on', 'Билайн', 'УФО', 'on', false, false),
    row('megafon|цфо|on', 'МегаФон', 'ЦФО', 'on', true, true),
  ],
};
const entry = {
  target: '8.8.8.8:443',
  createdAt: '2026-10-12T00:00:00Z',
  units: 2,
  estimatedCredits: 19,
  nodeName: null,
  operators: ['beeline|уфо|on', 'megafon|цфо|on'],
  run,
};
const unit = (
  op_key: string,
  operator: string,
  name: string,
  region: string,
  region_code: string,
  dpi: string,
) => ({
  op_key,
  operator,
  name,
  region,
  region_code,
  dpi,
  channel_state: dpi === 'on' ? 'DPI_ON' : 'DPI_OFF',
  probeable: true,
});
const Page = () => <BsCheckerWorkspace settings={() => {}} />;
beforeEach(() => {
  resetMockState({ authenticated: true });
  try {
    localStorage.removeItem('ns-bs-units');
  } catch {}
  server.use(
    http.get('*/api/integrations/bschecker/workspace', () =>
      HttpResponse.json({
        account: {
          balanceCredits: 19,
          bonusCredits: 486,
          totalCredits: 505,
          tier: 'platinum',
          tierExpiresAt: null,
        },
        units: [
          unit('beeline|уфо|on', 'beeline', 'Билайн', 'УФО', 'urfo', 'on'),
          unit('megafon|цфо|on', 'megafon', 'МегаФон', 'ЦФО', 'cfo', 'on'),
          unit('miranda|крым|off', 'miranda', 'Миранда', 'КРЫМ', 'krym', 'off'),
        ],
      }),
    ),
    http.get('*/api/integrations/bschecker/history', () => HttpResponse.json({ runs: [entry] })),
    http.get('*/api/integrations/bschecker/runs/:id', () => HttpResponse.json(run)),
    http.get('*/api/integrations/bschecker/rentals', () => HttpResponse.json({ rentals: [], unreadable: 0 })),
    http.get('*/api/integrations/bschecker/ws', () => HttpResponse.json({ ws: [], unreadable: 0 })),
  );
});
describe('BS Checker (вариант A)', () => {
  it('результат: вывод про белый список сверху, по точкам TCP и ICMP', async () => {
    const user = userEvent.setup();
    renderPage(Page, '/bs');
    await user.click(await screen.findByRole('button', { name: /8\.8\.8\.8:443/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Белый список пропускает ноду в 1 из 2 точек');
    expect(dialog).toHaveTextContent('У Билайн с включённым белым списком адрес не открывается');
    const table = within(dialog).getByRole('table');
    expect(table).toHaveTextContent('Билайн');
    expect(table).toHaveTextContent('открыт · 42 мс');
    expect(within(table).getAllByText('нет ответа')).toHaveLength(2);
  });

  it('точки — таблицей «оператор × округ», цена сама, платный запуск только по кнопке', async () => {
    const preview = vi.fn(async () =>
      HttpResponse.json({
        id,
        costCredits: 19,
        fullCredits: 22,
        discountPct: 15,
        levelName: 'Platinum',
        units: ['beeline|уфо|on'],
        expiresAt: '2026-10-13T00:10:00Z',
      }),
    );
    const execute = vi.fn(() => HttpResponse.json(run));
    server.use(
      http.post('*/api/integrations/bschecker/preview', preview),
      http.post(`*/api/integrations/bschecker/runs/${id}/execute`, execute),
    );
    const user = userEvent.setup();
    renderPage(Page, '/bs');
    expect(await screen.findByText('В аккаунте нет арендованных точек')).toBeVisible();
    await user.click(screen.getByRole('combobox', { name: 'Нода для проверки' }));
    await user.click(await screen.findByRole('option', { name: 'Ввести IP или домен вручную' }));
    await user.type(screen.getByRole('textbox', { name: 'IP или домен' }), '8.8.8.8');
    await user.click(screen.getByRole('button', { name: 'Выбрать' }));
    const dialog = await screen.findByRole('dialog', { name: 'Точки проверки' });
    // Режим «с белым списком»: оператор без таких точек (Миранда) не показан.
    expect(within(dialog).queryByText('Миранда')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Билайн · УФО' }));
    expect(within(dialog).getByRole('button', { name: 'Билайн · УФО' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Готово' }));
    expect(screen.getByText(/1 точка/)).toBeVisible();
    const run1 = await screen.findByRole('button', { name: 'Запустить за 19 Cred' });
    expect(screen.getByText(/скидка Platinum −15 %/)).toBeVisible();
    expect(preview).toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await user.click(run1);
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  });

  it('после перезагрузки восстанавливает неизвестный результат и повторяет только прежний ключ', async () => {
    const uncertain = { ...run, status: 'uncertain', rows: [], costCredits: null, error: 'Ответ потерян' };
    const execute = vi.fn(() => HttpResponse.json(run));
    server.use(
      http.get('*/api/integrations/bschecker/history', () =>
        HttpResponse.json({ runs: [{ ...entry, run: uncertain }] }),
      ),
      http.get('*/api/integrations/bschecker/runs/:id', () => HttpResponse.json(uncertain)),
      http.post(`*/api/integrations/bschecker/runs/${id}/execute`, execute),
    );
    renderPage(Page, '/bs');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /8\.8\.8\.8:443/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Получить результат той же проверки' }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(await within(dialog).findByText('Белый список пропускает ноду в 1 из 2 точек')).toBeVisible();
  });

  it('точка WebSocket: скорость, срок, выход на ноду, адреса моста; настройки подключения — секреты', async () => {
    server.use(
      http.get('*/api/integrations/bschecker/ws', () =>
        HttpResponse.json({
          unreadable: 0,
          ws: [
            {
              id: '5',
              name: 'WS-5',
              address: 'radio.example',
              state: 'active',
              mbit: 300,
              ready: true,
              applied: true,
              expires_at: '2026-10-30T00:00:00Z',
              autorenew: { enabled: true, days: 30 },
              exits: [
                { host: '2.26.101.44', port: 441, weight: 1, backup: false, enabled: true, state: 'up' },
              ],
              bridges: ['91.240.12.7'],
              cert: { expires_at: '2027-01-10T00:00:00Z' },
            },
          ],
        }),
      ),
      http.get('*/api/integrations/bschecker/ws/5/connect', () =>
        HttpResponse.json({
          id: '5',
          name: 'WS-5',
          host: { address: 'radio.example', port: 443, security: 'tls', network: 'ws', path: '/secret-path' },
          inbound_ready: true,
          inbound_port: 441,
          inbound: { port: 441, protocol: 'vless' },
          bridges: ['91.240.12.7'],
          // Вид ответа на 13.10.2026: проверка и откат — по инструменту, у проверки есть «снаружи».
          firewall: {
            ips: ['91.240.12.7'],
            by_port: [
              {
                port: 441,
                ufw: 'ufw allow from 91.240.12.7 to any port 441',
                nftables: 'systemctl restart wsin-441',
                check: {
                  ufw: 'ufw status numbered | grep -w 441',
                  nftables: 'nft list table inet wsin_441',
                  outside: 'nc -vz -w 5 2.26.101.44 441',
                },
                rollback: { ufw: 'ufw delete deny 441/tcp', nftables: 'systemctl disable --now wsin-441' },
              },
            ],
          },
        }),
      ),
    );
    const user = userEvent.setup();
    renderPage(Page, '/bs');
    const card = await screen.findByRole('article', { name: 'Точка WS-5' });
    expect(card).toHaveTextContent('Скорость 300 Мбит/с');
    expect(card).toHaveTextContent('автопродление на 30 дней');
    expect(card).toHaveTextContent('2.26.101.44:441');
    expect(card).toHaveTextContent('работает');
    expect(card).toHaveTextContent('Порт ноды открывайте только адресам точки: 1 адрес');
    await user.click(within(card).getByRole('button', { name: 'Настройки подключения' }));
    const dialog = await screen.findByRole('dialog', { name: 'Настройки подключения · WS-5' });
    expect(await within(dialog).findByText('/secret-path')).toBeVisible();
    expect(dialog).toHaveTextContent('ufw allow from 91.240.12.7 to any port 441');
    const command = (label: string) =>
      within(dialog)
        .getByRole('button', { name: `Скопировать: ${label}` })
        .closest('div')?.parentElement;
    expect(command('Проверить · ufw')).toHaveTextContent('ufw status numbered | grep -w 441');
    expect(command('Проверить · nftables')).toHaveTextContent('nft list table inet wsin_441');
    expect(command('Проверить с другого компьютера — порт не должен отвечать')).toHaveTextContent(
      'nc -vz -w 5 2.26.101.44 441',
    );
    expect(command('Откатить · ufw')).toHaveTextContent('ufw delete deny 441/tcp');
    expect(command('Откатить · nftables')).toHaveTextContent('systemctl disable --now wsin-441');
    expect(dialog).toHaveTextContent('Просмотр настроек записан в «Журнал».');
  });
});

describe('Серверы точки WebSocket: поля с подписями и свободным вводом', () => {
  const ws = {
    id: '5',
    name: 'WS-5',
    address: 'radio.example',
    state: 'active',
    ready: true,
    applied: true,
    exits: [{ host: '2.26.101.44', port: 441, weight: 1, backup: false, enabled: true, state: 'up' }],
    bridges: [],
  };
  /** Открыть окно серверов и запомнить, что ушло на подготовку изменения. */
  async function open() {
    const sent: Array<{ exits: Array<Record<string, unknown>> }> = [];
    server.use(
      http.get('*/api/integrations/bschecker/ws', () => HttpResponse.json({ ws: [ws], unreadable: 0 })),
      http.post('*/api/integrations/bschecker/ws/5/changes', async ({ request }) => {
        const body = (await request.json()) as { exits: Array<Record<string, unknown>> };
        sent.push(body);
        return HttpResponse.json({
          id: '9b2f3c1e-7d4a-4e8b-9a6c-1f2e3d4c5b6a',
          wsId: '5',
          before: ws.exits.map(({ state, ...e }) => ({ ...e, max_connections: null })),
          after: body.exits,
          expiresAt: '2026-10-13T12:00:00Z',
        });
      }),
    );
    const user = userEvent.setup();
    renderPage(Page, '/bs');
    const card = await screen.findByRole('article', { name: 'Точка WS-5' });
    await user.click(within(card).getByRole('button', { name: 'Изменить выходы' }));
    const dialog = await screen.findByRole('dialog', { name: 'Серверы точки · WS-5' });
    return { user, dialog, sent };
  }

  it('у полей подписи и пояснение; вес стирается целиком и набирается заново; пустой лимит — без лимита', async () => {
    const { user, dialog, sent } = await open();
    for (const label of ['Адрес', 'Порт', 'Вес', 'Лимит подключений'])
      expect(within(dialog).getByText(label, { selector: 'label' })).toBeVisible();
    expect(dialog).toHaveTextContent('с весом 2 — вдвое больше, чем с весом 1; от 1 до 100');
    expect(dialog).toHaveTextContent('пусто — без лимита');
    const weight = within(dialog).getByRole('textbox', { name: 'Вес сервера 1' });
    await user.clear(weight);
    expect(weight).toHaveValue('');
    await user.type(weight, '2');
    expect(weight).toHaveValue('2');
    expect(within(dialog).getByRole('textbox', { name: 'Лимит подключений сервера 1' })).toHaveValue('');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить и проверить' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.exits[0]).toMatchObject({
      host: '2.26.101.44',
      port: 441,
      weight: 2,
      max_connections: null,
    });
  });

  it('вес пустой, 0 или 101 — ошибка под полем, и ничего не отправляется', async () => {
    const { user, dialog, sent } = await open();
    const weight = within(dialog).getByRole('textbox', { name: 'Вес сервера 1' });
    await user.clear(weight);
    await user.tab();
    expect(within(dialog).getByText('Вес — от 1 до 100')).toBeVisible();
    expect(weight).toHaveAttribute('aria-invalid', 'true');
    for (const bad of ['0', '101']) {
      await user.clear(weight);
      await user.type(weight, bad);
      expect(within(dialog).getByText('Вес — от 1 до 100')).toBeVisible();
      await user.click(within(dialog).getByRole('button', { name: 'Сохранить и проверить' }));
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Исправьте поля, отмеченные красным.');
    }
    expect(sent).toHaveLength(0);
    // Исправили — ошибка уходит, лимит набирается числом.
    await user.clear(weight);
    await user.type(weight, '100');
    expect(within(dialog).queryByText('Вес — от 1 до 100')).toBeNull();
    await user.type(within(dialog).getByRole('textbox', { name: 'Лимит подключений сервера 1' }), '50');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить и проверить' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.exits[0]).toMatchObject({ weight: 100, max_connections: 50 });
  });
});

describe('Серверы точки WebSocket: проверка после сохранения', () => {
  const change = '9b2f3c1e-7d4a-4e8b-9a6c-1f2e3d4c5b6a';
  const back = '1c7d0a52-3b6e-4f19-8d2a-5e4f6a7b8c9d';
  const exit = (host: string, state: string) => ({
    host,
    port: 441,
    weight: 1,
    backup: false,
    enabled: true,
    state,
  });
  const ws = {
    id: '5',
    name: 'WS-5',
    address: 'radio.example',
    state: 'active',
    ready: true,
    applied: true,
    exits: [exit('2.26.101.44', 'up')],
    bridges: [],
  };
  const verified = (second: 'up' | 'down' | 'unknown', done = true) => ({
    done,
    applied: done,
    total: 2,
    working: second === 'up' ? 2 : 1,
    pending: second === 'unknown' ? 1 : 0,
    failing: second === 'down' ? ['144.31.144.199:441'] : [],
    exits: [
      { host: '2.26.101.44', port: 441, backup: false, state: 'up', hint: null },
      {
        host: '144.31.144.199',
        port: 441,
        backup: false,
        state: second,
        hint: second === 'down' ? 'Порт закрыт для адресов точки.' : null,
      },
    ],
  });
  /** Открыть окно, добавить второй сервер и дойти до подтверждения; verifyReply задаёт ответ точки. */
  async function saved(reply: () => ReturnType<typeof verified>) {
    const changes: Array<{ exits: Array<Record<string, unknown>>; balancing: string }> = [];
    const verifies: Array<Record<string, unknown>> = [];
    server.use(
      http.get('*/api/integrations/bschecker/ws', () => HttpResponse.json({ ws: [ws], unreadable: 0 })),
      http.post('*/api/integrations/bschecker/ws/5/changes', async ({ request }) => {
        const body = (await request.json()) as { exits: Array<Record<string, unknown>>; balancing: string };
        changes.push(body);
        return HttpResponse.json({
          id: changes.length === 1 ? change : back,
          wsId: '5',
          before:
            changes.length === 1 ? ws.exits.map(({ state, ...e }) => ({ ...e, max_connections: null })) : [],
          after: body.exits,
          expiresAt: '2026-10-13T12:00:00Z',
        });
      }),
      http.post('*/api/integrations/bschecker/ws/changes/:id/execute', () =>
        HttpResponse.json({ status: 'submitted', applied: false, warnings: [] }),
      ),
      http.post('*/api/integrations/bschecker/ws/5/verify', async ({ request }) => {
        verifies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(reply());
      }),
    );
    const user = userEvent.setup();
    renderPage(Page, '/bs');
    const card = await screen.findByRole('article', { name: 'Точка WS-5' });
    await user.click(within(card).getByRole('button', { name: 'Изменить выходы' }));
    const dialog = await screen.findByRole('dialog', { name: 'Серверы точки · WS-5' });
    await user.click(within(dialog).getByRole('button', { name: 'Добавить сервер' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Адрес сервера 2' }), '144.31.144.199');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить и проверить' }));
    await user.click(await screen.findByRole('button', { name: 'Заменить серверы' }));
    return { user, dialog, changes, verifies };
  }

  it('после сохранения окно ждёт точку: серверы строками, «проверяет», закрыть можно', async () => {
    const { dialog, verifies } = await saved(() => verified('unknown', false));
    const list = await within(dialog).findByRole('list', { name: 'Серверы точки после сохранения' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    await waitFor(() => expect(list).toHaveTextContent('144.31.144.199:441'));
    expect(list).toHaveTextContent('работает');
    expect(await within(list).findByText('проверяет')).toBeVisible();
    expect(dialog).toHaveTextContent('Точка проверяет серверы');
    expect(dialog).toHaveTextContent('Окно можно закрыть — итог появится и в карточке точки.');
    expect(within(dialog).queryByRole('button', { name: 'Сохранить и проверить' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Закрыть' })).toBeEnabled();
    // Итог просим именно по этому изменению: по нему панель записывает его в «Журнал».
    expect(verifies[0]).toEqual({ changeId: change });
  });

  it('все серверы работают — итог, «Готово»', async () => {
    const { dialog } = await saved(() => verified('up'));
    expect(await within(dialog).findByText(/Точка проверила серверы — все 2 работают/)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Готово' })).toBeEnabled();
    expect(within(dialog).queryByRole('button', { name: 'Вернуть прежний список' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Проверить снова' })).toBeNull();
  });

  it('сервер не отвечает — причина, «Проверить снова» бесплатно и «Вернуть прежний список» новым изменением', async () => {
    const { user, dialog, changes, verifies } = await saved(() => verified('down'));
    expect(await within(dialog).findByText(/Сервер 144\.31\.144\.199:441 не отвечает точке/)).toBeVisible();
    expect(dialog).toHaveTextContent('Порт закрыт для адресов точки.');
    expect(dialog).toHaveTextContent('Откройте порт и проверьте снова');
    expect(changes).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: 'Проверить снова' }));
    await waitFor(() => expect(verifies.length).toBeGreaterThanOrEqual(2));
    // Проверка не создаёт изменений: лимит 48 в сутки не тратится.
    expect(changes).toHaveLength(1);
    // Возврат — это ещё одно изменение, и дальше снова идёт проверка уже по нему.
    await user.click(await within(dialog).findByRole('button', { name: 'Вернуть прежний список' }));
    await waitFor(() => expect(changes).toHaveLength(2));
    // Уходит прежний список — один сервер, как был до изменения, — с прежними настройками распределения.
    expect(changes[1]?.exits).toEqual([expect.objectContaining({ host: '2.26.101.44', port: 441 })]);
    expect(changes[1]?.balancing).toBe('weighted');
    await waitFor(() => expect(verifies.at(-1)).toEqual({ changeId: back }));
    // Возврат уже сделан: если и после него сервер молчит, второй «возврат» вернул бы тот же список — его нет.
    await waitFor(() =>
      expect(within(dialog).queryByRole('button', { name: 'Вернуть прежний список' })).toBeNull(),
    );
    expect(await within(dialog).findByRole('button', { name: 'Проверить снова' })).toBeEnabled();
    expect(dialog).not.toHaveTextContent('Возврат прежнего списка — ещё одно изменение');
  });
});

describe('История точки', () => {
  const ws = {
    id: '5',
    name: 'WS-5',
    address: 'radio.example',
    state: 'active',
    ready: true,
    applied: true,
    exits: [{ host: '2.26.101.44', port: 441, weight: 1, backup: false, enabled: true, state: 'up' }],
    bridges: [],
  };
  async function open(items: unknown[]) {
    server.use(
      http.get('*/api/integrations/bschecker/ws', () => HttpResponse.json({ ws: [ws], unreadable: 0 })),
      http.get('*/api/integrations/bschecker/ws/5/history', () => HttpResponse.json({ items })),
    );
    const user = userEvent.setup();
    renderPage(Page, '/bs');
    const card = await screen.findByRole('article', { name: 'Точка WS-5' });
    await user.click(within(card).getByRole('button', { name: 'История' }));
    return { user, dialog: await screen.findByRole('dialog', { name: 'История точки · WS-5' }) };
  }

  it('события новыми сверху: заголовок, подробность и кто сделал; честная подпись про то, чего нет', async () => {
    const { dialog } = await open([
      {
        at: '2026-10-14T12:03:00Z',
        tone: 'ok',
        title: 'Точка проверила серверы',
        detail: 'все 2 работают',
        by: 'панель',
      },
      {
        at: '2026-10-14T12:02:00Z',
        tone: 'acc',
        title: 'Серверы изменены',
        detail: 'добавлен 144.31.144.199:441',
        by: 'вы',
      },
    ]);
    const list = await within(dialog).findByRole('list', { name: 'События точки' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Точка проверила серверы');
    expect(rows[0]).toHaveTextContent('все 2 работают · панель');
    expect(rows[1]).toHaveTextContent('добавлен 144.31.144.199:441 · вы');
    expect(dialog).toHaveTextContent(
      'Хранится 90 дней. Падения серверов и продления BS Checker не присылает',
    );
  });

  it('пока ничего нет — объясняет, с какой версии ведётся история', async () => {
    const { dialog } = await open([]);
    expect(await within(dialog).findByText('Пока ничего не записано')).toBeVisible();
    expect(dialog).toHaveTextContent('История ведётся с версии 0.102.0');
  });
});

describe('BS Checker: порт и SNI из подключений ноды', () => {
  const CONTEL = 'c0000000-0000-4000-8000-000000000001';
  const connections = {
    primary: 'CONTEL_PL_XHTTP',
    failed: false,
    items: [
      {
        tag: 'CONTEL_PL',
        protocol: 'vless',
        security: 'reality',
        network: 'raw',
        port: 442,
        names: ['mail73.ru', 'ozon.ru', 'static.rutube.ru'],
      },
      {
        tag: 'CONTEL_PL_XHTTP',
        protocol: 'vless',
        security: 'reality',
        network: 'xhttp',
        port: 18444,
        names: ['storage.yandexcloud.net'],
      },
      { tag: 'SS_BRIDGE', protocol: 'shadowsocks', security: null, network: null, port: 15344, names: [] },
    ],
  };
  const previewBodies: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    previewBodies.length = 0;
    server.use(
      http.get('*/api/nodes/status', () =>
        HttpResponse.json({
          connected: true,
          domain: 'panel.example',
          checkedAt: null,
          error: null,
          stats: null,
          cert: null,
          nodes: [
            {
              uuid: CONTEL,
              name: 'CONTEL',
              address: '46.8.209.86',
              port: 18443,
              countryCode: 'RU',
              whitelist: true,
              isConnected: true,
              isDisabled: false,
              isConnecting: false,
              lastStatusMessage: null,
              usersOnline: 0,
              trafficUsedBytes: null,
              trafficLimitBytes: null,
            },
          ],
        }),
      ),
      http.get(`*/api/nodes/${CONTEL}/connections`, () => HttpResponse.json(connections)),
      http.post('*/api/integrations/bschecker/preview', async ({ request }) => {
        previewBodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({
          id,
          costCredits: 19,
          fullCredits: null,
          discountPct: null,
          levelName: null,
          units: ['beeline|уфо|on'],
          expiresAt: '2026-10-13T00:10:00Z',
        });
      }),
    );
    try {
      localStorage.setItem('ns-bs-units', JSON.stringify(['beeline|уфо|on']));
    } catch {}
  });

  it('выбрали ноду — её подключения строками, основное выбрано, порт подставлен; другое подключение меняет порт и имя', async () => {
    const user = userEvent.setup();
    renderPage(Page, '/bs');
    await user.click(await screen.findByRole('combobox', { name: 'Нода для проверки' }));
    await user.click(await screen.findByRole('option', { name: /CONTEL/ }));
    const group = await screen.findByRole('radiogroup', { name: 'Подключение ноды' });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    expect(within(group).getByRole('radio', { name: /CONTEL_PL_XHTTP/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('textbox', { name: 'Порт' })).toHaveValue('18444');
    expect(group).toHaveTextContent('3 имён SNI');
    expect(group).toHaveTextContent('SNI storage.yandexcloud.net');
    expect(group).toHaveTextContent('без имени SNI');
    // имя SNI подставлено заранее: включили проверку SNI — оно уже в поле
    await user.click(screen.getByRole('button', { name: 'SNI' }));
    expect(screen.getByRole('combobox', { name: 'Имя для SNI' })).toHaveTextContent(
      'storage.yandexcloud.net',
    );
    await user.click(within(group).getByRole('radio', { name: /^CONTEL_PL(?!_)/ }));
    expect(screen.getByRole('textbox', { name: 'Порт' })).toHaveValue('442');
    expect(screen.getByRole('combobox', { name: 'Имя для SNI' })).toHaveTextContent('mail73.ru');
    // у подключения несколько имён: можно выбрать другое или вписать своё
    await user.click(screen.getByRole('combobox', { name: 'Имя для SNI' }));
    await user.click(await screen.findByRole('option', { name: 'ozon.ru' }));
    expect(screen.getByRole('combobox', { name: 'Имя для SNI' })).toHaveTextContent('ozon.ru');
    await user.click(screen.getByRole('combobox', { name: 'Имя для SNI' }));
    await user.click(await screen.findByRole('option', { name: 'Своё имя…' }));
    await user.type(screen.getByRole('textbox', { name: 'Своё имя для SNI' }), 'example.org');
    // подключение без имён SNI: поле имени — обычное
    await user.click(within(group).getByRole('radio', { name: /SS_BRIDGE/ }));
    expect(screen.getByRole('textbox', { name: 'Порт' })).toHaveValue('15344');
    expect(screen.queryByRole('combobox', { name: 'Имя для SNI' })).toBeNull();
  });

  it('порт поправили руками — подключение больше не выбрано; другая нода — свои подключения', async () => {
    const user = userEvent.setup();
    renderPage(Page, '/bs');
    await user.click(await screen.findByRole('combobox', { name: 'Нода для проверки' }));
    await user.click(await screen.findByRole('option', { name: /CONTEL/ }));
    const group = await screen.findByRole('radiogroup', { name: 'Подключение ноды' });
    const port = screen.getByRole('textbox', { name: 'Порт' });
    await user.clear(port);
    await user.type(port, '8443');
    expect(within(group).queryByRole('radio', { checked: true })).toBeNull();
    await user.click(within(group).getByRole('radio', { name: /CONTEL_PL_XHTTP/ }));
    expect(port).toHaveValue('18444');
  });

  it('из ссылки события: нода, порт и имя SNI подставлены, проверка SNI включена, цена считается с ними', async () => {
    function FromIncident() {
      return (
        <BsCheckerWorkspace
          settings={() => {}}
          initialNode={CONTEL}
          initialPort={18444}
          initialSni="storage.yandexcloud.net"
        />
      );
    }
    renderPage(FromIncident, '/bs');
    const group = await screen.findByRole('radiogroup', { name: 'Подключение ноды' });
    expect(within(group).getByRole('radio', { name: /CONTEL_PL_XHTTP/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('textbox', { name: 'Порт' })).toHaveValue('18444');
    expect(screen.getByRole('button', { name: 'SNI' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('combobox', { name: 'Имя для SNI' })).toHaveTextContent(
      'storage.yandexcloud.net',
    );
    await waitFor(() => expect(previewBodies.length).toBeGreaterThan(0));
    expect(previewBodies.at(-1)).toMatchObject({
      nodeUuid: CONTEL,
      ip: '46.8.209.86',
      port: 18444,
      sniHost: 'storage.yandexcloud.net',
    });
  });

  it('в ссылке только нода (совет Ассистента): основное подключение подставляется само, SNI по умолчанию выключен', async () => {
    function FromAdvice() {
      return <BsCheckerWorkspace settings={() => {}} initialNode={CONTEL} />;
    }
    renderPage(FromAdvice, '/bs');
    await screen.findByRole('radiogroup', { name: 'Подключение ноды' });
    expect(screen.getByRole('textbox', { name: 'Порт' })).toHaveValue('18444');
    expect(screen.getByRole('button', { name: 'SNI' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('Remnawave не ответила: честно сказано, порт и имя SNI вписываются самим', async () => {
    server.use(
      http.get(`*/api/nodes/${CONTEL}/connections`, () =>
        HttpResponse.json({ items: [], primary: null, failed: true }),
      ),
    );
    const user = userEvent.setup();
    renderPage(Page, '/bs');
    await user.click(await screen.findByRole('combobox', { name: 'Нода для проверки' }));
    await user.click(await screen.findByRole('option', { name: /CONTEL/ }));
    expect(await screen.findByText(/Подключения ноды из Remnawave прочитать не удалось/)).toBeVisible();
    expect(screen.queryByRole('radiogroup', { name: 'Подключение ноды' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Порт' })).toHaveValue('443');
  });
});

describe('BS Checker: итог SNI в результате проверки', () => {
  const withSni = (rows: Array<Record<string, unknown>>, sniHost: string | null) => {
    const done = { ...run, rows };
    server.use(
      http.get('*/api/integrations/bschecker/history', () =>
        HttpResponse.json({ runs: [{ ...entry, sniHost, run: done }] }),
      ),
      http.get('*/api/integrations/bschecker/runs/:id', () => HttpResponse.json(done)),
    );
  };
  const rowSni = (unit: string, op: string, tcp: boolean, sni: boolean | null) => ({
    ...row(unit, op, 'ЦФО', 'on', tcp, tcp),
    sni,
  });

  it('колонка SNI: «проходит» / «не проходит» / «—», имя — в шапке окна', async () => {
    withSni(
      [
        rowSni('a|цфо|on', 'МТС', true, true),
        rowSni('b|цфо|on', 'Билайн', true, false),
        rowSni('c|цфо|on', 'Tele2', true, null),
      ],
      'storage.yandexcloud.net',
    );
    const user = userEvent.setup();
    renderPage(Page, '/bs');
    await user.click(await screen.findByRole('button', { name: /8\.8\.8\.8:443/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('SNI storage.yandexcloud.net');
    const table = within(dialog).getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'SNI' })).toBeVisible();
    expect(within(table).getByText('проходит')).toBeVisible();
    expect(within(table).getByText('не проходит')).toBeVisible();
    expect(dialog).not.toHaveTextContent('не прислал её итог');
  });

  it('SNI заказывали, а итога от сервиса нет — это сказано, а не выдано за «не проходит»', async () => {
    withSni([rowSni('a|цфо|on', 'МТС', true, null)], 'storage.yandexcloud.net');
    const user = userEvent.setup();
    renderPage(Page, '/bs');
    await user.click(await screen.findByRole('button', { name: /8\.8\.8\.8:443/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('сервис не прислал её итог в понятном виде');
    expect(within(dialog).queryByText('не проходит')).toBeNull();
  });

  it('без SNI колонки нет', async () => {
    withSni([rowSni('a|цфо|on', 'МТС', true, null)], null);
    const user = userEvent.setup();
    renderPage(Page, '/bs');
    await user.click(await screen.findByRole('button', { name: /8\.8\.8\.8:443/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('columnheader', { name: 'SNI' })).toBeNull();
  });

  it('«Проверить снова» после проверки с SNI возвращает то же имя и включает SNI', async () => {
    withSni([rowSni('a|цфо|on', 'МТС', true, true)], 'storage.yandexcloud.net');
    const user = userEvent.setup();
    renderPage(Page, '/bs');
    await user.click(await screen.findByRole('button', { name: /8\.8\.8\.8:443/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Проверить снова' }));
    expect(screen.getByRole('button', { name: 'SNI' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('textbox', { name: 'Имя для SNI' })).toHaveValue('storage.yandexcloud.net');
  });
});
