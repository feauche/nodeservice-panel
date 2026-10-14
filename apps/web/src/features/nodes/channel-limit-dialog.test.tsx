import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CHANNEL_SPEED_COMMAND, CHANNEL_SPEEDTEST_COMMAND } from '@/lib/channel-speed';
import { ChannelLimitDialog } from './channel-limit-dialog';

function open(props: Partial<Parameters<typeof ChannelLimitDialog>[0]> = {}) {
  const onSubmit = vi.fn<(mbps: number) => void | Promise<void>>(async () => undefined);
  const onClose = vi.fn();
  render(<ChannelLimitDialog nodeName="Финляндия - 1" onSubmit={onSubmit} onClose={onClose} {...props} />);
  const dialog = screen.getByRole('dialog', { name: 'Лимит канала · Финляндия - 1' });
  const field = within(dialog).getByRole('textbox', { name: 'Вывод команды или скорость канала' });
  const save = (name = 'Сохранить') => within(dialog).getByRole('button', { name });
  return { onSubmit, onClose, dialog, field, save };
}

describe('окно «Лимит канала»', () => {
  it('сначала команда для сервера, поле пустое и сохранить нечего', () => {
    const { dialog, field, save } = open();
    expect(within(dialog).getByRole('list', { name: 'Шаги' })).toBeVisible();
    expect(dialog).toHaveTextContent(CHANNEL_SPEED_COMMAND);
    expect(dialog).toHaveTextContent('Нужен, чтобы посчитать, сколько ещё выдержит нода.');
    expect(field).toHaveValue('');
    expect(save()).toBeDisabled();
    // Запасной способ свёрнут, пока он не нужен.
    expect(within(dialog).getByRole('button', { name: 'Ошибка или −1 вместо числа?' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(dialog).not.toHaveTextContent(CHANNEL_SPEEDTEST_COMMAND);
  });

  it('«Копировать» кладёт команду в буфер и подтверждает «Скопировано»', async () => {
    const user = userEvent.setup();
    const { dialog } = open();
    const copy = within(dialog).getByRole('button', { name: 'Копировать: команда скорости сетевой карты' });
    await user.click(copy);
    expect(await navigator.clipboard.readText()).toBe(CHANNEL_SPEED_COMMAND);
    expect(copy).toHaveTextContent('Скопировано');
  });

  it('вписали число — видно, какой лимит уйдёт; «Сохранить» отдаёт его и закрывает окно', async () => {
    const user = userEvent.setup();
    const { dialog, field, save, onSubmit, onClose } = open();
    await user.type(field, '1000');
    expect(await within(dialog).findByText(/Лимит канала: 1\s000/)).toBeVisible();
    await user.click(save());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(1000));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('вставили вывод замера — берётся меньшее из Download и Upload, и это сказано словами', async () => {
    const user = userEvent.setup();
    const { dialog, field, save, onSubmit } = open();
    await user.click(field);
    await user.paste('Ping: 14.2 ms\nDownload: 912.31 Mbit/s\nUpload: 874.07 Mbit/s');
    expect(await within(dialog).findByText(/Лимит канала: 874/)).toBeVisible();
    expect(dialog).toHaveTextContent(
      'Это меньшее из Download (912) и Upload (874): канал считается по меньшему.',
    );
    await user.click(save());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(874));
  });

  it('сервер скорость не сообщает: предупреждение, запасной способ раскрывается сам, сохранить нельзя', async () => {
    const user = userEvent.setup();
    const { dialog, field, save, onSubmit } = open();
    await user.click(field);
    await user.paste('cat: read error: Invalid argument');
    expect(await within(dialog).findByText('Сервер скорость не сообщает.')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Ошибка или −1 вместо числа?' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(dialog).toHaveTextContent(CHANNEL_SPEEDTEST_COMMAND);
    expect(dialog).toHaveTextContent('виртуальная сетевая карта пишет 10000, а по тарифу у вас 1000');
    expect(save()).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
    // Человек может свернуть подсказку обратно.
    await user.click(within(dialog).getByRole('button', { name: 'Ошибка или −1 вместо числа?' }));
    expect(dialog).not.toHaveTextContent(CHANNEL_SPEEDTEST_COMMAND);
  });

  it('непонятное и невозможное не сохраняются: объясняют, что вписать', async () => {
    const user = userEvent.setup();
    const { dialog, field, save } = open();
    await user.type(field, 'очень быстро');
    expect(await within(dialog).findByText('Число не найдено.')).toBeVisible();
    expect(save()).toBeDisabled();
    await user.clear(field);
    await user.type(field, '0');
    expect(await within(dialog).findByText('Такая скорость не подходит.')).toBeVisible();
    expect(save()).toBeDisabled();
  });

  it('ошибка сохранения показана в окне, окно остаётся открытым', async () => {
    const user = userEvent.setup();
    const { dialog, field, save, onClose } = open({
      onSubmit: async () => {
        throw new Error('Не удалось сохранить настройки ноды.');
      },
    });
    await user.type(field, '500');
    await user.click(save());
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Не удалось сохранить настройки ноды.',
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('в окне ноды главное действие — «Подставить», и сказано, что сохранять ещё нужно там', () => {
    const { dialog, save } = open({
      submitLabel: 'Подставить',
      hint: 'Число попадёт в поле — сохраните его кнопкой в окне ноды.',
    });
    expect(save('Подставить')).toBeDisabled();
    expect(dialog).toHaveTextContent('Число попадёт в поле — сохраните его кнопкой в окне ноды.');
  });
});
