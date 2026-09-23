import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { toast } from '@/lib/notify';
import { resetMockState } from '@/test/msw/handlers';
import { mockNotifications } from '@/test/msw/notifications-mock';
import { renderPage } from '@/test/render';
import { NotificationBell } from './notification-bell';

function Page() {
  return (
    <div>
      <NotificationBell />
    </div>
  );
}

describe('NotificationBell', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('счётчик непрочитанных, список с точками, ссылка на инцидент, прочитано после открытия', async () => {
    const { router } = renderPage(Page, '/', ['/incidents', '/servers/providers']);
    const bell = await screen.findByTestId('notification-bell');
    expect(await screen.findByTestId('notification-badge')).toHaveTextContent('4');
    const user = userEvent.setup();
    await user.click(bell);
    const list = await screen.findByTestId('notification-list');
    const rows = within(list).getAllByTestId('notification-row');
    expect(rows).toHaveLength(6);
    expect(rows[0]).toHaveAttribute('data-unread', 'true');
    expect(rows[0]).toHaveTextContent('Высокая нагрузка на CPU · de-fra-01: ждёт «Да»');
    expect(rows[4]).not.toHaveAttribute('data-unread');
    // через полторы секунды всё прочитано
    await waitFor(() => expect(mockNotifications.items.every((n) => n.readAt !== null)).toBe(true), {
      timeout: 4000,
    });
    await waitFor(() => expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument());
    // ссылка ведёт в инцидент и закрывает список
    await user.click(within(rows[0] as HTMLElement).getByRole('link', { name: /Открыть инцидент/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/incidents'));
    expect(router.state.location.search).toMatchObject({ open: expect.any(String) });
  });

  it('удалить одно и «Очистить все» через подтверждение', async () => {
    renderPage(Page, '/', ['/incidents']);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('notification-bell'));
    const list = await screen.findByTestId('notification-list');
    const first = within(list).getAllByTestId('notification-row')[0] as HTMLElement;
    await user.click(within(first).getByRole('button', { name: 'Удалить уведомление' }));
    await waitFor(() => expect(mockNotifications.items).toHaveLength(5));
    await user.click(screen.getByRole('button', { name: 'Очистить все' }));
    await user.click(await screen.findByRole('button', { name: 'Очистить' }));
    await waitFor(() => expect(mockNotifications.items).toHaveLength(0));
    // окно подтверждения закрыло попап — открываем снова: пусто
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await user.click(screen.getByTestId('notification-bell'));
    expect(await screen.findByText('Уведомлений нет')).toBeInTheDocument();
  });

  it('всплывашка клиента попадает в центр уведомлений', async () => {
    renderPage(Page, '/');
    await screen.findByTestId('notification-bell');
    const before = mockNotifications.items.length;
    toast.success('Провайдер «Contabo» добавлен', { description: 'иконку подтянем в фоне' });
    await waitFor(() => expect(mockNotifications.items).toHaveLength(before + 1));
    expect(mockNotifications.items[0]).toMatchObject({
      severity: 'ok',
      title: 'Провайдер «Contabo» добавлен',
      body: 'иконку подтянем в фоне',
    });
  });
});
