import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockState } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { BsCheckerWorkspace } from './bschecker-workspace';

const id = '4fab6a97-4d4e-42b7-a84d-6825b8375a72';
const run = {
  id,
  status: 'done',
  costCredits: 19,
  refundedCredits: 0,
  error: null,
  rows: [
    {
      unit: 'beeline-ufo',
      operator: 'Билайн',
      region: 'УФО',
      dpi: 'on',
      tcp: false,
      icmp: true,
      tcpIsTls: false,
      error: null,
    },
  ],
};
const entry = {
  target: '8.8.8.8:443',
  createdAt: '2026-10-12T00:00:00Z',
  units: 1,
  estimatedCredits: 19,
  run,
};
const Page = () => <BsCheckerWorkspace settings={() => {}} />;
beforeEach(() => {
  resetMockState({ authenticated: true });
  server.use(
    http.get('*/api/integrations/bschecker/workspace', () =>
      HttpResponse.json({
        account: {
          balanceCredits: 19,
          bonusCredits: 0,
          totalCredits: 19,
          tier: 'basic',
          tierExpiresAt: null,
        },
        units: [
          {
            op_key: 'beeline-ufo',
            operator: 'beeline',
            name: 'Билайн',
            region: 'УФО',
            dpi: 'on',
            channel_state: 'ready',
            probeable: true,
          },
        ],
      }),
    ),
    http.get('*/api/integrations/bschecker/history', () => HttpResponse.json({ runs: [entry] })),
    http.get('*/api/integrations/bschecker/runs/:id', () => HttpResponse.json(run)),
    http.get('*/api/integrations/bschecker/rentals', () => HttpResponse.json({ rentals: [] })),
  );
});
describe('BS Checker: рабочий экран', () => {
  it('сохраняет единицы Cred, открывает историю в модалке и различает TCP/ICMP', async () => {
    renderPage(Page, '/bs');
    expect((await screen.findAllByText('19 Cred')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/₽|0,19/)).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /8.8.8.8:443/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Недоступно')).toBeInTheDocument();
    expect(within(dialog).getByText('Доступно')).toBeInTheDocument();
    expect(within(dialog).getByText('Билайн')).toBeInTheDocument();
    expect(within(dialog).getByText('БС активен')).toBeInTheDocument();
  });
  it('выбирает точки отдельно, не запускает платную проверку при выборе или расчёте', async () => {
    const execute = vi.fn(() => HttpResponse.json(run));
    const preview = vi.fn(() =>
      HttpResponse.json({ id, costCredits: 19, units: ['beeline-ufo'], expiresAt: '2026-10-12T00:10:00Z' }),
    );
    server.use(
      http.post('*/api/integrations/bschecker/preview', preview),
      http.post('*/api/integrations/bschecker/runs/:id/execute', execute),
    );
    renderPage(Page, '/bs');
    await screen.findByText('В аккаунте пока нет арендованных точек');
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: /^IP или домен$/ }), '8.8.8.8');
    await user.click(screen.getByRole('button', { name: 'Выбрать точки и проверить' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Рассчитать стоимость' }));
    await within(dialog).findByRole('button', { name: 'Запустить за 19 Cred' });
    expect(execute).not.toHaveBeenCalled();
    expect(preview).toHaveBeenCalledTimes(1);
    await user.click(within(dialog).getByRole('button', { name: 'Очистить' }));
    expect(within(dialog).getByRole('button', { name: 'Рассчитать стоимость' })).toBeDisabled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('после перезагрузки восстанавливает неизвестный результат и повторяет только прежний UUID', async () => {
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
    await user.click(await screen.findByRole('button', { name: /8.8.8.8:443/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Получить результат той же проверки' }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(await within(dialog).findByText('Недоступно')).toBeInTheDocument();
  });
});
