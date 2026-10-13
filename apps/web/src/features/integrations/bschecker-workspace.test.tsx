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
