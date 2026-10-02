import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetMockState } from '@/test/msw/handlers';
import { mockNotifications } from '@/test/msw/notifications-mock';
import { renderPage } from '@/test/render';
import { NotificationsCenterPage } from './notifications-center-page';

describe('NotificationsCenterPage', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('shows report cards, filters maintenance and marks the page read', async () => {
    renderPage(NotificationsCenterPage, '/notifications', ['/servers', '/incidents/$id']);

    const center = await screen.findByTestId('notifications-center');
    expect(
      await within(center).findByText('Высокая нагрузка на CPU · de-fra-01: ждёт подтверждения'),
    ).toBeVisible();
    expect(within(center).getByText('Требуют внимания')).toBeVisible();

    const user = userEvent.setup();
    await user.click(within(center).getByRole('button', { name: 'Обслуживание' }));
    expect(within(center).getByText('Обслуживание: nl-ams-02')).toBeVisible();
    expect(within(center).getByText('Агент вышел на связь · nl-ams-02')).toBeVisible();
    expect(within(center).queryByText('Провайдер «Rawi»: иконку не нашли')).not.toBeInTheDocument();

    await waitFor(() => expect(mockNotifications.items.every((n) => n.readAt !== null)).toBe(true), {
      timeout: 4000,
    });
  });

  it('clears report history only after confirmation', async () => {
    renderPage(NotificationsCenterPage, '/notifications', ['/servers']);
    const user = userEvent.setup();
    await screen.findByTestId('notifications-center');
    await user.click(screen.getByRole('button', { name: /Очистить историю/ }));
    expect(mockNotifications.items.length).toBeGreaterThan(0);
    await user.click(await screen.findByRole('button', { name: 'Очистить' }));
    await waitFor(() => expect(mockNotifications.items).toHaveLength(0));
    expect(await screen.findByText('Здесь пока нет отчётов')).toBeVisible();
  });
});
