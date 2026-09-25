import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ServerModalHost } from '@/features/servers/server-modal-host';
import { useServerModalStore } from '@/features/servers/server-modal-store';
import { toast } from '@/lib/notify';
import { resetMockState } from '@/test/msw/handlers';
import { mockNotifications } from '@/test/msw/notifications-mock';
import { mockServers } from '@/test/msw/servers-mock';
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
    const { router } = renderPage(Page, '/', ['/incidents', '/incidents/$id', '/servers/providers']);
    const bell = await screen.findByTestId('notification-bell');
    expect(await screen.findByTestId('notification-badge')).toHaveTextContent('4');
    const user = userEvent.setup();
    await user.click(bell);
    const list = await screen.findByTestId('notification-list');
    const rows = within(list).getAllByTestId('notification-row');
    expect(rows).toHaveLength(6);
    expect(rows[0]).toHaveAttribute('data-unread', 'true');
    expect(rows[0]).toHaveTextContent('Высокая нагрузка на CPU · de-fra-01: ждёт подтверждения');
    expect(rows[4]).not.toHaveAttribute('data-unread');
    // через полторы секунды всё прочитано
    await waitFor(() => expect(mockNotifications.items.every((n) => n.readAt !== null)).toBe(true), {
      timeout: 4000,
    });
    await waitFor(() => expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument());
    // ссылка ведёт в инцидент и закрывает список
    await user.click(within(rows[0] as HTMLElement).getByRole('link', { name: /Открыть инцидент/ }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/incidents\/[0-9a-f-]+$/));
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

  it('всплывашка клиента в центр уведомлений не попадает — там только важное', async () => {
    renderPage(Page, '/');
    await screen.findByTestId('notification-bell');
    const before = mockNotifications.items.length;
    toast.success('Провайдер «Contabo» добавлен', { description: 'иконку подтянем в фоне' });
    await new Promise((r) => setTimeout(r, 50));
    expect(mockNotifications.items).toHaveLength(before);
  });

  it('ссылка на сервер в уведомлении открывает карточку поверх страницы, без перехода', async () => {
    useServerModalStore.getState().close();
    const target = mockServers.items[0];
    if (!target) throw new Error('нет мок-сервера');
    mockNotifications.items = [
      {
        id: '0192e000-0000-7000-8000-00000000f001',
        severity: 'warn',
        title: `Обслуживание: ${target.name}`,
        body: 'обновлений безопасности: 5',
        link: { to: `/servers?open=${target.id}`, label: 'Открыть сервер' },
        createdAt: new Date().toISOString(),
        readAt: null,
      },
    ];
    const HostPage = () => (
      <>
        <NotificationBell />
        <ServerModalHost />
      </>
    );
    const { router } = renderPage(HostPage, '/', ['/servers']);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('notification-bell'));
    await user.click(await screen.findByRole('button', { name: /Открыть сервер/ }));
    expect(await screen.findByRole('dialog', { name: target.name })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });
});
