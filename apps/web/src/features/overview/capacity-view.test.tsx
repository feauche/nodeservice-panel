import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { mockCapacity } from '@/test/msw/capacity-mock';
import { resetMockState } from '@/test/msw/handlers';
import { mockServers } from '@/test/msw/servers-mock';
import { renderPage } from '@/test/render';
import { CapacityView } from './capacity-view';

describe('CapacityView', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('плитки по парку и таблица: упор ноды, сколько ещё влезет, откуда канал', async () => {
    renderPage(CapacityView, '/');
    const table = await screen.findByRole('table', { name: 'Ёмкость нод' });
    expect(screen.getByText('≈ 690')).toBeInTheDocument();
    expect(screen.getByText('2 из 3 нод упираются в канал')).toBeInTheDocument();
    const rows = within(table).getAllByRole('row').slice(1);
    const first = rows[0] as HTMLElement;
    expect(within(first).getByText('ещё ≈ 60')).toBeInTheDocument();
    expect(within(first).getByText('канал', { selector: 'span' })).toBeInTheDocument();
    expect(within(first).getByText(/канал: вручную/)).toBeInTheDocument();
    expect(within(first).getByText('890 из 1000 Мбит/с')).toBeInTheDocument();
  });

  it('замер канала: предупреждение про трафик, затем результат', async () => {
    renderPage(CapacityView, '/');
    const user = userEvent.setup();
    const name = mockServers.items[1]?.name ?? '';
    await user.click(await screen.findByRole('button', { name: `Действия: ${name}` }));
    await user.click(await screen.findByRole('menuitem', { name: 'Замерить канал…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/до ≈ 2 ГБ трафика/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Замерить' }));
    expect(await within(dialog).findByText(/отдача 9,1 Гбит\/с/)).toBeInTheDocument();
    expect(mockCapacity.measured).toContain(mockServers.items[1]?.id);
  });

  it('канал вручную: проверка числа, сохранение', async () => {
    renderPage(CapacityView, '/');
    const user = userEvent.setup();
    const menus = await screen.findAllByRole('button', { name: /^Действия: / });
    await user.click(menus[2] as HTMLElement);
    await user.click(await screen.findByRole('menuitem', { name: 'Указать канал вручную…' }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText('Скорость канала, Мбит/с');
    await user.type(input, '5');
    expect(within(dialog).getByText('От 10 до 400 000 Мбит/с.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    await user.clear(input);
    await user.type(input, '1000');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect([...mockCapacity.manual.values()]).toContain(1000));
  });
});
