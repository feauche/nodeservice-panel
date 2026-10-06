import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetMockState } from '@/test/msw/handlers';
import { AppearancePage } from './appearance-page';
import { resetNavigationLayout } from './navigation-layout';

describe('AppearancePage · расположение меню', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    resetNavigationLayout();
  });

  it('переключает панель между левым и верхним меню и запоминает выбор', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AppearancePage />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    const sidebar = screen.getByRole('button', { name: /Слева/ });
    const top = screen.getByRole('button', { name: /Сверху/ });

    expect(sidebar).toHaveAttribute('aria-pressed', 'true');
    expect(top).toHaveAttribute('aria-pressed', 'false');
    await user.click(top);
    expect(top).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('ns-navigation-layout')).toBe('top');
  });
});
