import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { buildErrorReport, explainError } from './error-report';
import { ErrorScreen } from './error-screen';

describe('explainError / buildErrorReport', () => {
  it('различает сеть, сервер, сессию и ошибку в коде', () => {
    expect(explainError(new ApiError({ type: 'about:blank', title: 'x', status: 0 })).kind).toBe('network');
    expect(explainError(new ApiError({ type: 'about:blank', title: 'x', status: 503 })).kind).toBe('server');
    expect(explainError(new ApiError({ type: 'about:blank', title: 'x', status: 401 })).kind).toBe('auth');
    expect(explainError(new ReferenceError("Can't find variable: onRegenerate")).kind).toBe('client');
    // Отменённый запрос TanStack Query — не «unknown»-поломка, а понятная сетевая причина.
    const cancelled = new Error('cancelled');
    cancelled.name = 'CancelledError';
    expect(explainError(cancelled).kind).toBe('network');
    expect(explainError('строка').kind).toBe('unknown');
  });

  it('отчёт содержит страницу, сообщение, id запроса и стек', () => {
    const err = new ApiError({
      type: 'https://nodeservice.dev/problems/x',
      title: 'Ошибка',
      status: 500,
      requestId: 'req-42',
    });
    const report = buildErrorReport(err, { path: '/settings/security', theme: 'dark' });
    expect(report).toContain('Страница: /settings/security');
    expect(report).toContain('Запрос: req-42');
    expect(report).toContain('HTTP: 500');
    expect(report).toContain('Тема: dark');
    const plain = buildErrorReport(new TypeError('boom'), { path: '/' });
    expect(plain).toContain('Сообщение: boom');
    expect(plain).toContain('Стек:');
  });
});

describe('ErrorScreen', () => {
  it('объясняет ошибку в коде и копирует отчёт', async () => {
    // userEvent.setup() подменяет navigator.clipboard своим стабом — читаем через него.
    const user = userEvent.setup();
    const reset = vi.fn();
    render(<ErrorScreen error={new ReferenceError("Can't find variable: onRegenerate")} reset={reset} />);
    expect(screen.getByRole('heading', { name: 'Ошибка в коде интерфейса' })).toBeInTheDocument();
    expect(screen.getAllByText("Can't find variable: onRegenerate").length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Скопировать отчёт' }));
    expect(await screen.findByText('Скопировано')).toBeInTheDocument();
    const clipboard = await navigator.clipboard.readText();
    expect(clipboard).toContain("Can't find variable: onRegenerate");
    expect(clipboard).toContain('Страница:');
    await user.click(screen.getByRole('button', { name: 'Попробовать снова' }));
    expect(reset).toHaveBeenCalled();
  });
});
