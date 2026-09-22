import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Markdown } from './markdown';

describe('Markdown', () => {
  it('рендерит markdown-таблицу с заголовком и строками', () => {
    render(<Markdown content={'| Термин | Простыми словами |\n| --- | --- |\n| SSH | Доступ по сети |'} />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('Термин')).toBeInTheDocument();
    expect(within(table).getByText('SSH')).toBeInTheDocument();
    expect(within(table).getByText('Доступ по сети')).toBeInTheDocument();
    // заголовочная строка + одна строка данных
    expect(within(table).getAllByRole('row')).toHaveLength(2);
  });

  it('текст без таблицы не превращается в таблицу', () => {
    render(<Markdown content={'Просто абзац без разметки таблицы.'} />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
