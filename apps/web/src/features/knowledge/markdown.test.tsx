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

  it('курсив звёздочкой и подчёркиванием, жирный и код рядом', () => {
    const { container } = render(
      <Markdown
        content={'*Когда нужно:* и _так_, но **жирный** и `nf_conntrack_max` и snake_case_word без курсива'}
      />,
    );
    const em = [...container.querySelectorAll('em')].map((e) => e.textContent);
    expect(em).toEqual(['Когда нужно:', 'так']);
    expect(container.querySelector('strong')?.textContent).toBe('жирный');
    expect(container.querySelector('code')?.textContent).toBe('nf_conntrack_max');
    expect(container.textContent).toContain('snake_case_word');
  });

  it('заголовки четырёх уровней', () => {
    render(<Markdown content={'# Один\n## Два\n### Три\n#### Четыре\nТекст'} />);
    for (const t of ['Один', 'Два', 'Три', 'Четыре']) expect(screen.getByText(t)).toBeInTheDocument();
    expect(screen.getByText('Четыре').className).toContain('text-[13px]');
  });

  it('цитата собирается из подряд идущих строк, линия отделяет блоки', () => {
    const { container } = render(
      <Markdown content={'Текст\n\n> Первая строка\n> вторая строка\n\n---\n\nПосле'} />,
    );
    const q = container.querySelector('blockquote');
    expect(q?.textContent).toBe('Первая строка вторая строка');
    expect(container.querySelector('hr')).not.toBeNull();
    expect(screen.getByText('После')).toBeInTheDocument();
  });

  it('цитата и линия прерывают абзац, а маркеры списка и таблицы работают как раньше', () => {
    const { container } = render(
      <Markdown content={'Абзац\n> цитата\n- пункт\n\n| A | B |\n| --- | --- |\n| 1 | 2 |'} />,
    );
    expect(container.querySelector('p')?.textContent).toBe('Абзац');
    expect(container.querySelector('blockquote')).not.toBeNull();
    expect(container.querySelectorAll('li')).toHaveLength(1);
    expect(container.querySelectorAll('td')).toHaveLength(2);
  });
});
