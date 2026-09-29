import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { TagInput } from './tag-input';

const COUNTS = { node: 5, exit: 4, rent: 3, prod: 6 };

function Harness({ initial = [] as string[] }) {
  const [tags, setTags] = useState(initial);
  return (
    <>
      <TagInput id="t" value={tags} onChange={setTags} counts={COUNTS} />
      <output data-testid="val">{tags.join('|')}</output>
    </>
  );
}
const val = () => screen.getByTestId('val').textContent;

describe('TagInput', () => {
  it('пробел и запятая — капсула как напечатано, в нижнем регистре; ⌫ убирает последнюю', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    const input = screen.getByRole('combobox');
    await user.type(input, 'Germany exit,');
    expect(val()).toBe('germany|exit');
    await user.keyboard('{Backspace}');
    expect(val()).toBe('germany');
  });

  it('опечатка: первой идёт «node — похоже, вы имели в виду», Enter берёт её', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('combobox'), 'noed');
    expect(screen.getAllByRole('option')[0]?.textContent).toMatch(/^node — похоже, вы имели в виду/);
    await user.keyboard('{Enter}');
    expect(val()).toBe('node');
  });

  it('опечатка пробелом всё же прошла — предупреждение и «Заменить на»', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('combobox'), 'rnt ');
    expect(screen.getByText(/Похоже на «rent»/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Заменить на «rent»' }));
    expect(val()).toBe('rent');
  });

  it('подсказки по началу слова: «no» + Enter → node; Enter в пустом поле ничего не добавляет', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    const input = screen.getByRole('combobox');
    await user.click(input);
    await user.keyboard('{Enter}');
    expect(val()).toBe('');
    await user.type(input, 'no{Enter}');
    expect(val()).toBe('node');
  });
});
