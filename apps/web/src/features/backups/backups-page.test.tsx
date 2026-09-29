import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { MOCK_BACKUP_PASSWORD, mockBackups } from '@/test/msw/backups-mock';
import { resetMockState } from '@/test/msw/handlers';
import { mockSecurity } from '@/test/msw/security-mock';
import { renderPage } from '@/test/render';
import { BackupsPage } from './backups-page';

describe('BackupsPage', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    mockBackups.speedMs = 20;
    mockSecurity.stepUpFresh = true;
  });

  it('состояние сверху и список копий: время, вид, размер, проверка и Telegram', async () => {
    renderPage(BackupsPage, '/settings/backups');
    const list = await screen.findByRole('list', { name: 'Резервные копии' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(7);
    // Копия «перед восстановлением» в счёт хранения не входит.
    expect(screen.getByText('6 из 7')).toBeInTheDocument();
    expect(screen.getByText('С паролем')).toBeInTheDocument();
    expect(within(list).getByText('перед обновлением 0.35.0')).toBeInTheDocument();
    expect(within(list).getAllByText('✓ проверена').length).toBeGreaterThan(0);
    expect(within(list).getByText('не отправилась')).toBeInTheDocument();
  });

  it('«Сделать копию сейчас»: ход по шагам, готовая копия появляется первой', async () => {
    renderPage(BackupsPage, '/settings/backups');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Сделать копию сейчас' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Сделать копию' }));
    expect(await within(dialog).findByText(/Готово:/, undefined, { timeout: 4000 })).toBeInTheDocument();
    expect(mockBackups.items[0]?.kind).toBe('manual');
  });

  it('копия не получилась — причина видна в окне', async () => {
    mockBackups.failNext = true;
    renderPage(BackupsPage, '/settings/backups');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Сделать копию сейчас' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Сделать копию' }));
    expect(
      await within(dialog).findByText(/нет связи с базой данных/, undefined, { timeout: 4000 }),
    ).toBeInTheDocument();
  });

  it('восстановление: пароль архива, слово «ВОССТАНОВИТЬ», запрос уходит', async () => {
    renderPage(BackupsPage, '/settings/backups');
    const user = userEvent.setup();
    const list = await screen.findByRole('list', { name: 'Резервные копии' });
    const first = within(list).getAllByRole('listitem')[0] as HTMLElement;
    // В узком блоке (jsdom без размеров) действия — в меню «⋯».
    await user.click(within(first).getByRole('button', { name: /Действия с копией/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Восстановить' }));
    const dialog = await screen.findByRole('dialog');
    const pw = await within(dialog).findByLabelText('Пароль архива');
    await user.type(pw, 'неверный');
    await user.click(within(dialog).getByRole('button', { name: 'Проверить' }));
    expect(await within(dialog).findByText('Пароль не подошёл.')).toBeInTheDocument();
    await user.clear(pw);
    await user.type(pw, MOCK_BACKUP_PASSWORD);
    await user.click(within(dialog).getByRole('button', { name: 'Проверить' }));
    expect(await within(dialog).findByText('Пароль подошёл.')).toBeInTheDocument();

    const go = within(dialog).getByRole('button', { name: 'Восстановить' });
    expect(go).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Для подтверждения введите/), 'ВОССТАНОВИТЬ');
    expect(go).toBeEnabled();
    await user.click(go);
    await waitFor(() => expect(mockBackups.restored).toHaveLength(1));
    expect(await within(dialog).findByText('Панель перезапускается…')).toBeInTheDocument();
  });

  it('удаление — с подтверждением; самая свежая копия предупреждает', async () => {
    renderPage(BackupsPage, '/settings/backups');
    const user = userEvent.setup();
    const list = await screen.findByRole('list', { name: 'Резервные копии' });
    const first = within(list).getAllByRole('listitem')[0] as HTMLElement;
    await user.click(within(first).getByRole('button', { name: /Действия с копией/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Удалить' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Это самая свежая копия/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Да, удалить' }));
    await waitFor(() => expect(mockBackups.items).toHaveLength(6));
  });

  it('настройки: раз в неделю с днём, пароль с повтором, путь проверяется', async () => {
    renderPage(BackupsPage, '/settings/backups');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Раз в неделю' }));
    await user.click(screen.getByRole('radio', { name: 'ср' }));
    await user.click(screen.getByRole('button', { name: 'Сменить пароль' }));
    await user.type(screen.getByLabelText('Пароль'), 'длинный-пароль');
    await user.type(screen.getByLabelText('Ещё раз'), 'другой-пароль');
    expect(screen.getByText('Пароли не совпадают.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    await user.clear(screen.getByLabelText('Ещё раз'));
    await user.type(screen.getByLabelText('Ещё раз'), 'длинный-пароль');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockBackups.settings.frequency).toBe('week'));
    expect(mockBackups.settings.weekday).toBe(3);

    await user.click(screen.getByRole('button', { name: 'Добавить путь' }));
    await user.type(screen.getByRole('textbox', { name: 'Путь 3' }), '/root/.ssh/config');
    await user.click(screen.getByRole('button', { name: 'Проверить пути' }));
    expect(await screen.findByText('нет такого пути')).toBeInTheDocument();
    expect(screen.getByText('папка · 4,1 МБ')).toBeInTheDocument();
  });
});
