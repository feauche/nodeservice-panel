import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { mockAppearance, resetMockState } from '@/test/msw/handlers';
import { renderPage } from '@/test/render';
import { TimeZoneCard } from './time-zone-card';
import { timeZoneLabel } from './time-zones';

describe('TimeZoneCard', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    mockAppearance.timeZone = 'Europe/Moscow';
  });

  it('пояс по-русски; выбор из списка сохраняется сразу', async () => {
    renderPage(TimeZoneCard, '/settings/appearance');
    const user = userEvent.setup();
    const field = await screen.findByRole('combobox', { name: 'Часовой пояс панели' });
    await waitFor(() => expect(field).toHaveTextContent('Москва · UTC+3'));
    await user.click(field);
    await user.type(await screen.findByRole('searchbox'), 'Омск');
    await user.click(await screen.findByRole('option', { name: timeZoneLabel('Asia/Omsk') }));
    await waitFor(() => expect(mockAppearance.timeZone).toBe('Asia/Omsk'));
  });

  it('подписи поясов: свои названия для России, смещение от UTC', () => {
    expect(timeZoneLabel('Asia/Novosibirsk')).toBe('Новосибирск · UTC+7');
    expect(timeZoneLabel('UTC')).toBe('Всемирное время · UTC');
  });
});
