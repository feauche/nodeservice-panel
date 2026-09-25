import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Combobox } from './combobox';

const NAMES = [
  'Time Web',
  'Turtle Guard',
  '4VPS',
  'Aeza',
  'Hetzner',
  'DigitalOcean',
  'Vultr',
  'OVH',
  'Selectel',
];
const options = (n: number) =>
  NAMES.slice(0, n).map((name) => ({ value: name.toLowerCase(), label: name, keywords: `${name}.example` }));

function Harness({ count = 9, onAdd }: { count?: number; onAdd?: () => void }) {
  const [value, setValue] = useState<string | null>(null);
  return (
    <Combobox
      ariaLabel="Провайдер"
      value={value}
      onChange={setValue}
      options={options(count)}
      placeholder="Без провайдера"
      emptyLabel="Без провайдера"
      searchPlaceholder="Найти провайдера…"
      action={onAdd ? { label: 'Добавить провайдера…', onSelect: onAdd } : undefined}
    />
  );
}

describe('Combobox', () => {
  it('поиск: фильтрует по названию и по адресу, показывает счётчик и «Ничего не найдено»', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Провайдер' }));
    expect(screen.getByText('Всего: 9')).toBeInTheDocument();
    const search = screen.getByRole('searchbox');
    expect(search).toHaveFocus();
    await user.type(search, 'HETZ');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Hetzner']);
    expect(screen.getByText('Найдено 1 из 9')).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'guard.example');
    expect(screen.getByRole('option', { name: 'Turtle Guard' })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'qwerty');
    expect(screen.getByText('Ничего не найдено.')).toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  it('клавиатура: стрелки двигают подсветку, Enter выбирает, Escape закрывает без выбора', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    const trigger = screen.getByRole('combobox', { name: 'Провайдер' });
    await user.click(trigger);
    // первая строка — «Без провайдера», вторая — Time Web
    await user.keyboard('{ArrowDown}{Enter}');
    expect(trigger).toHaveTextContent('Time Web');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await user.click(trigger);
    // при открытии подсвечен выбранный пункт
    expect(screen.getByRole('option', { name: 'Time Web' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveTextContent('Time Web');
  });

  it('«Без провайдера» сбрасывает значение и пропадает из списка, пока идёт поиск', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    const trigger = screen.getByRole('combobox', { name: 'Провайдер' });
    await user.click(trigger);
    await user.click(screen.getByRole('option', { name: 'Aeza' }));
    expect(trigger).toHaveTextContent('Aeza');
    await user.click(trigger);
    await user.type(screen.getByRole('searchbox'), 'a');
    expect(screen.queryByRole('option', { name: 'Без провайдера' })).not.toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox'));
    await user.click(screen.getByRole('option', { name: 'Без провайдера' }));
    expect(trigger).toHaveTextContent('Без провайдера');
  });

  it('пункт-действие всегда виден под списком и вызывается и мышью, и клавишей', async () => {
    const onAdd = vi.fn();
    render(<Harness onAdd={onAdd} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Провайдер' }));
    await user.type(screen.getByRole('searchbox'), 'qwerty');
    await user.click(screen.getByRole('button', { name: 'Добавить провайдера…' }));
    expect(onAdd).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('combobox', { name: 'Провайдер' }));
    await user.keyboard('{End}{Enter}');
    expect(onAdd).toHaveBeenCalledTimes(2);
  });

  it('пока пунктов мало, поиска нет, а список работает клавиатурой', async () => {
    render(<Harness count={4} />);
    const user = userEvent.setup();
    const trigger = screen.getByRole('combobox', { name: 'Провайдер' });
    await user.click(trigger);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.getByRole('listbox')).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(trigger).toHaveTextContent('Turtle Guard');
  });
});
