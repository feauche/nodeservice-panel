import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockState } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { NodeTcpCheck } from './node-tcp-check';

const uuid = '4fab6a97-4d4e-42b7-a84d-6825b8375a72';
const report = {
  verdict: 'unknown',
  checkedAt: '2026-10-12T00:00:00Z',
  target: '8.8.8.8:5492',
  link: null,
  observations: [],
  error: 'Не хватило точек',
};
const Page = () => <NodeTcpCheck uuid={uuid} />;
beforeEach(() => resetMockState({ authenticated: true }));
describe('TCP проверки ноды', () => {
  it('показывает сохранённый неизвестный результат как неполный, а не недоступный', async () => {
    server.use(
      http.get('*/api/nodes/:uuid/tcp-checks', () => HttpResponse.json({ checks: [{ id: uuid, report }] })),
    );
    renderPage(Page, '/tcp');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Неполный результат/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Доступность пока не подтверждена')).toBeInTheDocument();
    expect(within(dialog).queryByText('Не отвечает')).not.toBeInTheDocument();
  });
  it('сразу открывает окно, получает результат и обновляет историю', async () => {
    let saved = false;
    server.use(
      http.get('*/api/nodes/:uuid/tcp-checks', () =>
        HttpResponse.json({ checks: saved ? [{ id: uuid, report }] : [] }),
      ),
      http.post('*/api/nodes/:uuid/tcp-check', () => {
        saved = true;
        return HttpResponse.json(report);
      }),
    );
    renderPage(Page, '/tcp');
    await screen.findByText('Ручных проверок пока нет');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Проверить порты' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Доступность пока не подтверждена')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Закрыть окно' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Неполный результат/ })).toBeInTheDocument(),
    );
  });
});
