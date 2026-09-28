import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ActivityRow } from './activity';

const base = {
  id: 'a1',
  label: 'Проверка «Геоблок» на «NL-2»',
  startedAt: '2026-09-29T10:00:00.000Z',
  finishedAt: null,
  detail: null,
};

describe('ActivityRow', () => {
  it('идёт — «идёт…» и счётчик; готова — «готова за 1:12» с итогом; ошибка — «не удалась» с причиной', () => {
    const { rerender } = render(<ActivityRow activity={{ ...base, state: 'running' }} />);
    expect(screen.getByText(/идёт…/)).toBeInTheDocument();
    rerender(
      <ActivityRow
        activity={{
          ...base,
          state: 'done',
          finishedAt: '2026-09-29T10:01:12.000Z',
          detail: 'Вывод — во вкладке «Проверки» сервера.',
        }}
      />,
    );
    expect(screen.getByText(/готова за 1:12/)).toBeInTheDocument();
    expect(screen.getByText(/во вкладке «Проверки»/)).toBeInTheDocument();
    rerender(
      <ActivityRow
        activity={{
          ...base,
          state: 'failed',
          finishedAt: '2026-09-29T10:00:30.000Z',
          detail: 'Не удалось установить jq.',
        }}
      />,
    );
    expect(screen.getByText(/не удалась/)).toBeInTheDocument();
  });
});
