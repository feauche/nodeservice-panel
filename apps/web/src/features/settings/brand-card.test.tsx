import { BRAND_NAME_DEFAULT } from '@nodeservice/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { mockAppearance, resetMockState } from '@/test/msw/handlers';
import { renderPage } from '@/test/render';
import { BrandCard } from './brand-card';

describe('BrandCard', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    mockAppearance.logoUrl = null;
    mockAppearance.brandName = BRAND_NAME_DEFAULT;
  });

  it('не принимает не-http ссылку и не зовёт API', async () => {
    renderPage(BrandCard, '/settings/appearance');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Ссылка на логотип'), 'javascript:alert(1)');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/https/);
    expect(mockAppearance.logoUrl).toBeNull();
  });

  it('сохраняет ссылку и название одной кнопкой', async () => {
    renderPage(BrandCard, '/settings/appearance');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Ссылка на логотип'), 'https://example.com/logo.svg');
    const nameInput = screen.getByLabelText('Название');
    await user.clear(nameInput);
    await user.type(nameInput, '[[#ff6b6b]My[[#accent]Panel');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockAppearance.logoUrl).toBe('https://example.com/logo.svg'));
    expect(mockAppearance.brandName).toBe('[#ff6b6b]My[#accent]Panel');
  });

  it('пустое название не проходит', async () => {
    renderPage(BrandCard, '/settings/appearance');
    const user = userEvent.setup();
    const nameInput = await screen.findByLabelText('Название');
    await user.clear(nameInput);
    await user.type(nameInput, '[[#accent]');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/пустым/);
  });

  it('«Вернуть стандартные» сбрасывает и логотип, и название', async () => {
    mockAppearance.logoUrl = 'https://example.com/logo.png';
    mockAppearance.brandName = 'Custom';
    renderPage(BrandCard, '/settings/appearance');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Вернуть стандартные' }));
    await waitFor(() => expect(mockAppearance.logoUrl).toBeNull());
    expect(mockAppearance.brandName).toBe(BRAND_NAME_DEFAULT);
  });
});
