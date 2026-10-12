import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Markdown, NodeLinkContext } from './markdown';

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

  it('копирует только содержимое выбранного блока кода', async () => {
    const user = userEvent.setup();
    render(<Markdown copyCode content={'```bash\necho first\n```\n\n```json\n{"second":true}\n```'} />);

    const buttons = screen.getAllByRole('button', { name: 'Скопировать код' });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[1] as HTMLButtonElement);

    expect(await navigator.clipboard.readText()).toBe('{"second":true}');
    expect(screen.getByRole('button', { name: 'Код скопирован' })).toHaveTextContent('Скопировано');
  });

  it('не показывает копирование вне базы знаний без явного флага', () => {
    render(<Markdown content={'```bash\necho hidden\n```'} />);
    expect(screen.queryByRole('button', { name: 'Скопировать код' })).not.toBeInTheDocument();
  });
});

it('node links use current UUID context and absent nodes are inert', async () => {
  const uuid = '11111111-1111-4111-8111-111111111111',
    open = vi.fn();
  render(
    <NodeLinkContext.Provider
      value={{ nodes: { [uuid]: { country: 'DE', state: 'Доступна', tone: 'ok' } }, open }}
    >
      <Markdown content={`[Нода](node:${uuid}) [Старая](node:22222222-2222-4222-8222-222222222222)`} />
    </NodeLinkContext.Provider>,
  );
  await userEvent.setup().click(screen.getByRole('button', { name: 'Нода' }));
  expect(open).toHaveBeenCalledWith(uuid);
  expect(screen.getByRole('button', { name: 'Старая' })).toBeDisabled();
});

it('ссылка на старый сервер — простое имя без кнопки и без адреса', () => {
  const { container } = render(
    <Markdown content="Сбой был на [de-fra-01](server:11111111-1111-4111-8111-111111111111) вчера." />,
  );
  expect(container.textContent).toContain('Сбой был на de-fra-01 вчера.');
  expect(container.textContent).not.toContain('server:');
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});
