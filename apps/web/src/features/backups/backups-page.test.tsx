import type { BackupItem } from '@nodeservice/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { MOCK_BACKUP_PASSWORD, mockBackups } from '@/test/msw/backups-mock';
import { resetMockState } from '@/test/msw/handlers';
import { mockSecurity } from '@/test/msw/security-mock';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { backupsApi } from './backups-api';
import { formatWhen } from './backups-format';
import { BackupsPage } from './backups-page';

/** Сбой сервера без объяснения — как при 500 или 502 во время обновления панели. */
const serverDown = () =>
  HttpResponse.json({ type: 'about:blank', title: 'Сбой', status: 500 }, { status: 500 });

/** Задвижка для ответа сервера: запрос ждёт, пока тест её не откроет. */
function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
}

/** Готовая копия «как с сервера»: появляется в списке в указанный момент. */
const madeAt = (at: Date): BackupItem => ({
  ...(mockBackups.items[0] as BackupItem),
  name: `nodeservice-backup-${at.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-new.tar.gz.enc`,
  createdAt: at.toISOString(),
  kind: 'auto',
});

/** Открыть окно восстановления самой свежей копии и пройти пароль архива. */
async function openRestore(user: ReturnType<typeof userEvent.setup>) {
  const list = await screen.findByRole('list', { name: 'Резервные копии' });
  const first = within(list).getAllByRole('listitem')[0] as HTMLElement;
  await user.click(within(first).getByRole('button', { name: /Действия с копией/ }));
  await user.click(await screen.findByRole('menuitem', { name: 'Восстановить' }));
  const dialog = await screen.findByRole('dialog');
  await user.type(await within(dialog).findByLabelText('Пароль архива'), MOCK_BACKUP_PASSWORD);
  await user.click(within(dialog).getByRole('button', { name: 'Проверить' }));
  await within(dialog).findByText('Пароль подошёл.');
  return dialog;
}

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
    expect(screen.getByText(/6 из 7/)).toBeInTheDocument();
    expect(screen.getByText('С паролем')).toBeInTheDocument();
    expect(within(list).getByText('перед обновлением 0.35.0')).toBeInTheDocument();
    expect(within(list).getAllByText('✓ проверена').length).toBeGreaterThan(0);
    expect(within(list).getByText('только уведомление')).toHaveAttribute(
      'title',
      expect.stringContaining('Новые крупные копии отправляются частями'),
    );
  });

  it('полностью отправленная крупная копия показывает число частей', async () => {
    const first = mockBackups.items[0] as BackupItem;
    mockBackups.items[0] = {
      ...first,
      size: Math.round(60.9 * 1024 * 1024),
      telegram: { ok: true, note: null, parts: 2 },
    };
    renderPage(BackupsPage, '/settings/backups');

    expect(await screen.findByText('2 части в Telegram')).toHaveAttribute(
      'title',
      'Архив полностью отправлен в Telegram частями: 2',
    );
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

  describe('страница не загрузилась', () => {
    it('список копий: ошибка с «Повторить», а не «Копий пока нет»; после повтора копии на месте', async () => {
      let down = true;
      server.use(http.get('/api/backups', () => (down ? serverDown() : undefined)));
      renderPage(BackupsPage, '/settings/backups');
      const user = userEvent.setup();
      expect(await screen.findByText(/Не удалось загрузить список копий/)).toBeInTheDocument();
      expect(screen.queryByText(/Копий пока нет/)).not.toBeInTheDocument();
      // Плитки состояния считать не из чего — пустых «Ещё не было» и «0 из 7» быть не должно.
      expect(screen.queryByText('Последняя копия')).not.toBeInTheDocument();
      // Форма настроек без списка не строится — вместо вечной заглушки сказано, чего она ждёт.
      expect(
        screen.getByText(/Настройки копий откроются, когда загрузится список копий/),
      ).toBeInTheDocument();
      expect(document.querySelector('[data-slot="skeleton"]')).toBeNull();

      down = false;
      await user.click(screen.getAllByRole('button', { name: 'Повторить' })[0] as HTMLElement);
      const list = await screen.findByRole('list', { name: 'Резервные копии' });
      expect(within(list).getAllByRole('listitem')).toHaveLength(7);
      expect(screen.getByText('Последняя копия')).toBeInTheDocument();
      expect(await screen.findByRole('radio', { name: 'Раз в неделю' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument();
    });

    it('настройки копий: ошибка с «Повторить» вместо вечной заглушки, список при этом на месте', async () => {
      let down = true;
      server.use(http.get('/api/backups/settings', () => (down ? serverDown() : undefined)));
      renderPage(BackupsPage, '/settings/backups');
      const user = userEvent.setup();
      expect(await screen.findByText(/Не удалось загрузить настройки копий/)).toBeInTheDocument();
      const list = await screen.findByRole('list', { name: 'Резервные копии' });
      expect(within(list).getAllByRole('listitem')).toHaveLength(7);
      expect(document.querySelector('[data-slot="skeleton"]')).toBeNull();

      down = false;
      await user.click(screen.getByRole('button', { name: 'Повторить' }));
      expect(await screen.findByRole('radio', { name: 'Раз в неделю' })).toBeInTheDocument();
      expect(screen.getByText(/6 из 7/)).toBeInTheDocument();
      expect(screen.queryByText(/Не удалось загрузить настройки копий/)).not.toBeInTheDocument();
    });

    it('не загрузилось ничего: один «Повторить» перечитывает и список, и настройки', async () => {
      let down = true;
      server.use(
        http.get('/api/backups', () => (down ? serverDown() : undefined)),
        http.get('/api/backups/settings', () => (down ? serverDown() : undefined)),
      );
      renderPage(BackupsPage, '/settings/backups');
      const user = userEvent.setup();
      expect(await screen.findByText(/Не удалось загрузить список копий/)).toBeInTheDocument();
      expect(await screen.findByText(/Не удалось загрузить настройки копий/)).toBeInTheDocument();
      // Запускать копию и восстанавливать из файла не из чего — кнопки ждут, пока страница загрузится.
      expect(screen.getByRole('button', { name: 'Сделать копию сейчас' })).toBeDisabled();
      expect(screen.getAllByRole('button', { name: 'Повторить' })).toHaveLength(2);

      down = false;
      await user.click(screen.getAllByRole('button', { name: 'Повторить' })[1] as HTMLElement);
      expect(await screen.findByRole('list', { name: 'Резервные копии' })).toBeInTheDocument();
      expect(await screen.findByRole('radio', { name: 'Раз в неделю' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Сделать копию сейчас' })).toBeEnabled();
    });

    it('сбой при перечитывании уже показанного списка: копии остаются на экране', async () => {
      const { queryClient } = renderPage(BackupsPage, '/settings/backups');
      const list = await screen.findByRole('list', { name: 'Резервные копии' });
      expect(within(list).getAllByRole('listitem')).toHaveLength(7);
      server.use(http.get('/api/backups', () => serverDown()));
      await queryClient.refetchQueries({ queryKey: ['backups', 'list'] });
      expect(queryClient.getQueryState(['backups', 'list'])?.status).toBe('error');
      expect(
        within(screen.getByRole('list', { name: 'Резервные копии' })).getAllByRole('listitem'),
      ).toHaveLength(7);
      expect(screen.queryByText(/Не удалось загрузить список копий/)).not.toBeInTheDocument();
      expect(screen.getByText(/6 из 7/)).toBeInTheDocument();
    });

    it('копий действительно нет — «Копий пока нет» только после успешной загрузки', async () => {
      mockBackups.items = [];
      renderPage(BackupsPage, '/settings/backups');
      expect(await screen.findByText(/Копий пока нет/)).toBeInTheDocument();
      expect(screen.getByText('Ещё не было')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument();
    });
  });

  describe('окно «Сделать копию»', () => {
    it('сразу после запуска — «Начинаю…», а не «Остановлено» с прошлой ошибкой', async () => {
      // Вчерашняя попытка не получилась: её причина лежит в списке, который был на экране до запуска.
      mockBackups.run = { stage: null, startedAt: null, mode: null, lastError: 'вчерашний сбой' };
      renderPage(BackupsPage, '/settings/backups');
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Сделать копию сейчас' }));
      const dialog = await screen.findByRole('dialog');
      // Список после запуска перечитывается не мгновенно: до ответа в кэше лежит прежний.
      const slow = gate();
      server.use(
        http.get('/api/backups', async () => {
          await slow.opened;
        }),
      );
      await user.click(within(dialog).getByRole('button', { name: 'Сделать копию' }));
      expect(await within(dialog).findByText('Начинаю…')).toBeInTheDocument();
      expect(within(dialog).queryByText('Остановлено')).not.toBeInTheDocument();
      expect(within(dialog).queryByText(/Копия не получилась/)).not.toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Свернуть' })).toBeInTheDocument();
      // Копию запустили отсюда — окно называется по-прежнему.
      expect(screen.getByRole('dialog', { name: 'Сделать копию сейчас' })).toBeInTheDocument();

      slow.open();
      expect(await within(dialog).findByText(/Готово:/, undefined, { timeout: 4000 })).toBeInTheDocument();
      expect(within(dialog).getByText('Копия готова')).toBeInTheDocument();
      expect(within(dialog).queryByText(/вчерашний сбой/)).not.toBeInTheDocument();
    });

    it('список после запуска перечитать не удалось — окно ждёт с «Начинаю…», а не объявляет итог', async () => {
      const { queryClient } = renderPage(BackupsPage, '/settings/backups');
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Сделать копию сейчас' }));
      const dialog = await screen.findByRole('dialog');
      let down = true;
      server.use(http.get('/api/backups', () => (down ? serverDown() : undefined)));
      await user.click(within(dialog).getByRole('button', { name: 'Сделать копию' }));
      expect(await within(dialog).findByText('Начинаю…')).toBeInTheDocument();
      await waitFor(() => expect(queryClient.getQueryState(['backups', 'list'])?.status).toBe('error'));
      // Чем кончилось, панель не знает: на экране по-прежнему список, который был до запуска.
      expect(within(dialog).getByText('Начинаю…')).toBeInTheDocument();
      expect(within(dialog).queryByText('Остановлено')).not.toBeInTheDocument();

      down = false;
      await queryClient.refetchQueries({ queryKey: ['backups', 'list'] });
      expect(await within(dialog).findByText(/Готово:/, undefined, { timeout: 4000 })).toBeInTheDocument();
    });

    it('ответ списка, запрошенный ещё до запуска и опоздавший, итогом не считается', async () => {
      const { queryClient } = renderPage(BackupsPage, '/settings/backups');
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Сделать копию сейчас' }));
      const dialog = await screen.findByRole('dialog');
      // Первый запрос списка уходит до запуска и застревает в пути: его ответ — про «до». Второй — уже
      // после запуска, тоже не мгновенный.
      const before = await backupsApi.list();
      const late = gate();
      const fresh = gate();
      let asked = 0;
      server.use(
        http.get('/api/backups', async () => {
          asked += 1;
          if (asked === 1) {
            await late.opened;
            return HttpResponse.json(before);
          }
          await fresh.opened;
        }),
      );
      void queryClient.refetchQueries({ queryKey: ['backups', 'list'] });
      await waitFor(() => expect(asked).toBe(1));
      await user.click(within(dialog).getByRole('button', { name: 'Сделать копию' }));
      expect(await within(dialog).findByText('Начинаю…')).toBeInTheDocument();
      await waitFor(() => expect(asked).toBe(2));

      late.open();
      await delay(80);
      expect(within(dialog).getByText('Начинаю…')).toBeInTheDocument();
      expect(within(dialog).queryByText('Остановлено')).not.toBeInTheDocument();

      fresh.open();
      expect(await within(dialog).findByText(/Готово:/, undefined, { timeout: 4000 })).toBeInTheDocument();
    });

    it('часы компьютера спешат на минуту — готовая копия всё равно «Готово»', async () => {
      mockBackups.clockSkewMs = -60_000;
      renderPage(BackupsPage, '/settings/backups');
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Сделать копию сейчас' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Сделать копию' }));
      expect(await within(dialog).findByText(/Готово:/, undefined, { timeout: 4000 })).toBeInTheDocument();
      expect(within(dialog).getByText('Копия готова')).toBeInTheDocument();
      expect(within(dialog).queryByText('Остановлено')).not.toBeInTheDocument();
    });

    it('та же ошибка второй раз подряд — окно доходит до итога, а не висит на «Начинаю…»', async () => {
      // Копия падает раньше, чем список успевает перечитаться, и с тем же текстом, что вчера:
      // перечитанный список от прежнего ничем не отличается, кроме того, что он — уже после запуска.
      mockBackups.run = {
        stage: null,
        startedAt: null,
        mode: null,
        lastError: 'pg_dump: нет связи с базой данных',
      };
      mockBackups.failNext = true;
      mockBackups.speedMs = 0;
      renderPage(BackupsPage, '/settings/backups');
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Сделать копию сейчас' }));
      const dialog = await screen.findByRole('dialog');
      server.use(
        http.get('/api/backups', async () => {
          await delay(150);
        }),
      );
      await user.click(within(dialog).getByRole('button', { name: 'Сделать копию' }));
      expect(await within(dialog).findByText('Начинаю…')).toBeInTheDocument();
      expect(await within(dialog).findByText('Остановлено')).toBeInTheDocument();
      expect(within(dialog).getByText(/нет связи с базой данных/)).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Закрыть' })).toBeInTheDocument();
    });

    it('идёт копия по расписанию: «Ход копии» открывает ход, а не форму запуска; в конце — итог', async () => {
      const startedAt = new Date();
      mockBackups.run = {
        stage: 'pack',
        startedAt: startedAt.toISOString(),
        mode: 'backup',
        lastError: null,
      };
      renderPage(BackupsPage, '/settings/backups');
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Ход копии' }));
      const dialog = await screen.findByRole('dialog', { name: 'Ход копии' });
      expect(within(dialog).getByText('Упаковываю архив…')).toBeInTheDocument();
      // Запускать вторую копию нечем: ни галочки, ни кнопки — иначе «Копия уже делается».
      expect(within(dialog).queryByRole('button', { name: 'Сделать копию' })).not.toBeInTheDocument();
      expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Свернуть' })).toBeInTheDocument();

      mockBackups.items = [madeAt(new Date(startedAt.getTime() + 1000)), ...mockBackups.items];
      mockBackups.run = { stage: null, startedAt: null, mode: null, lastError: null };
      expect(await within(dialog).findByText(/Готово:/, undefined, { timeout: 4000 })).toBeInTheDocument();
      expect(within(dialog).getByText('Копия готова')).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Закрыть' })).toBeInTheDocument();
    });

    it('копия началась, пока окно открыто с формой запуска, — форма сменяется ходом', async () => {
      const { queryClient } = renderPage(BackupsPage, '/settings/backups');
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Сделать копию сейчас' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('button', { name: 'Сделать копию' })).toBeInTheDocument();

      // Тем временем началась копия по расписанию — очередной опрос списка это показал.
      mockBackups.run = { stage: 'db', startedAt: new Date().toISOString(), mode: 'backup', lastError: null };
      await queryClient.refetchQueries({ queryKey: ['backups', 'list'] });
      expect(await within(dialog).findByText('Сохраняю базу данных…')).toBeInTheDocument();
      expect(within(dialog).queryByRole('button', { name: 'Сделать копию' })).not.toBeInTheDocument();
      expect(screen.getByRole('dialog', { name: 'Ход копии' })).toBeInTheDocument();
    });

    it('копию застали на отправке в Telegram — её файл уже в списке, итог всё равно «Готово»', async () => {
      const startedAt = new Date(Date.now() - 30_000);
      mockBackups.items = [madeAt(new Date(startedAt.getTime() + 500)), ...mockBackups.items];
      mockBackups.run = {
        stage: 'telegram',
        startedAt: startedAt.toISOString(),
        mode: 'backup',
        lastError: null,
      };
      renderPage(BackupsPage, '/settings/backups');
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Ход копии' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Отправляю в Telegram…')).toBeInTheDocument();

      mockBackups.run = { stage: null, startedAt: null, mode: null, lastError: null };
      expect(await within(dialog).findByText(/Готово:/, undefined, { timeout: 4000 })).toBeInTheDocument();
      expect(within(dialog).queryByText('Остановлено')).not.toBeInTheDocument();
    });

    it('копия по расписанию не получилась — в окне хода видна причина', async () => {
      mockBackups.run = { stage: 'db', startedAt: new Date().toISOString(), mode: 'backup', lastError: null };
      renderPage(BackupsPage, '/settings/backups');
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Ход копии' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Сохраняю базу данных…')).toBeInTheDocument();

      mockBackups.run = {
        stage: null,
        startedAt: null,
        mode: null,
        lastError: 'pg_dump: нет связи с базой данных',
      };
      expect(
        await within(dialog).findByText('Остановлено', undefined, { timeout: 4000 }),
      ).toBeInTheDocument();
      expect(within(dialog).getByText(/нет связи с базой данных/)).toBeInTheDocument();
      expect(within(dialog).queryByText(/Готово:/)).not.toBeInTheDocument();
    });

    it('своя копия после «Свернуть»: «Ход копии» снова показывает ход, потом итог', async () => {
      renderPage(BackupsPage, '/settings/backups');
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Сделать копию сейчас' }));
      let dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Сделать копию' }));
      // Копия «зависает» на первом шаге: дальше её ведёт сам тест.
      await waitFor(() => expect(mockBackups.run.stage).not.toBeNull());
      for (const t of mockBackups.timers) clearTimeout(t);
      const startedAt = new Date(mockBackups.run.startedAt as string);
      expect(await within(dialog).findByText('Сохраняю базу данных…')).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Свернуть' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

      await user.click(await screen.findByRole('button', { name: 'Ход копии' }));
      dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Сохраняю базу данных…')).toBeInTheDocument();
      expect(within(dialog).queryByRole('button', { name: 'Сделать копию' })).not.toBeInTheDocument();

      mockBackups.items = [madeAt(new Date(startedAt.getTime() + 1000)), ...mockBackups.items];
      mockBackups.run = { stage: null, startedAt: null, mode: null, lastError: null };
      expect(await within(dialog).findByText(/Готово:/, undefined, { timeout: 4000 })).toBeInTheDocument();
    });
  });

  describe('окно восстановления', () => {
    it('пока пароль архива проверяется — «Проверяю пароль…», а не «Пароль не подошёл.»', async () => {
      // Сервер на каждую проверку расшифровывает и распаковывает весь архив — это секунды.
      server.use(
        http.post('/api/backups/:name/inspect', async () => {
          await delay(150);
        }),
      );
      renderPage(BackupsPage, '/settings/backups');
      const user = userEvent.setup();
      const list = await screen.findByRole('list', { name: 'Резервные копии' });
      const first = within(list).getAllByRole('listitem')[0] as HTMLElement;
      await user.click(within(first).getByRole('button', { name: /Действия с копией/ }));
      await user.click(await screen.findByRole('menuitem', { name: 'Восстановить' }));
      const dialog = await screen.findByRole('dialog');
      await user.type(await within(dialog).findByLabelText('Пароль архива'), MOCK_BACKUP_PASSWORD);
      await user.click(within(dialog).getByRole('button', { name: 'Проверить' }));
      expect(within(dialog).getByText('Проверяю пароль…')).toBeInTheDocument();
      expect(within(dialog).queryByText('Пароль не подошёл.')).not.toBeInTheDocument();
      expect(await within(dialog).findByText('Пароль подошёл.')).toBeInTheDocument();
      expect(within(dialog).queryByText('Проверяю пароль…')).not.toBeInTheDocument();
    });

    it('неверный пароль: «Пароль не подошёл.» появляется, когда ответ пришёл', async () => {
      server.use(
        http.post('/api/backups/:name/inspect', async () => {
          await delay(150);
        }),
      );
      renderPage(BackupsPage, '/settings/backups');
      const user = userEvent.setup();
      const list = await screen.findByRole('list', { name: 'Резервные копии' });
      const first = within(list).getAllByRole('listitem')[0] as HTMLElement;
      await user.click(within(first).getByRole('button', { name: /Действия с копией/ }));
      await user.click(await screen.findByRole('menuitem', { name: 'Восстановить' }));
      const dialog = await screen.findByRole('dialog');
      await user.type(await within(dialog).findByLabelText('Пароль архива'), 'неверный');
      await user.click(within(dialog).getByRole('button', { name: 'Проверить' }));
      expect(within(dialog).getByText('Проверяю пароль…')).toBeInTheDocument();
      expect(within(dialog).queryByText('Пароль не подошёл.')).not.toBeInTheDocument();
      expect(await within(dialog).findByText('Пароль не подошёл.')).toBeInTheDocument();
    });

    it('старая копия без ключей шифрования: оговорка сервера видна в окне до восстановления', async () => {
      const WARNING =
        'Ключей шифрования в этой копии нет — панель не может проверить, от этой ли она установки.';
      server.use(
        http.post('/api/backups/:name/inspect', async ({ request }) => {
          const body = (await request.json()) as { password?: string };
          const it = mockBackups.items[0] as BackupItem;
          return HttpResponse.json({
            name: it.name,
            createdAt: it.createdAt,
            version: it.version,
            domain: 'panel.example.com',
            encrypted: it.encrypted,
            needsPassword: body.password !== MOCK_BACKUP_PASSWORD,
            contents: { dbBytes: 1000, env: false, metrics: false, paths: 0 },
            sameKeys: null,
            compatible: body.password === MOCK_BACKUP_PASSWORD,
            problem: body.password === MOCK_BACKUP_PASSWORD ? null : 'Копия защищена паролем — введите его.',
            warning: body.password === MOCK_BACKUP_PASSWORD ? WARNING : null,
          });
        }),
      );
      renderPage(BackupsPage, '/settings/backups');
      const user = userEvent.setup();
      const dialog = await openRestore(user);
      expect(within(dialog).getByText(WARNING)).toBeInTheDocument();
    });

    it('до подтверждения сказано: вход — по паролю и коду 2FA на момент копии, с её датой', async () => {
      renderPage(BackupsPage, '/settings/backups');
      const user = userEvent.setup();
      const dialog = await openRestore(user);
      const when = formatWhen((mockBackups.items[0] as BackupItem).createdAt, 'Asia/Omsk').toLowerCase();
      const note = within(dialog).getByText(/Вход — по паролю и коду 2FA/);
      expect(note).toHaveTextContent(`на момент копии (${when})`);
      expect(note).toHaveTextContent(/помните прежний пароль/);
      expect(note).toHaveTextContent(/из консоли сервера панели/);
      // Предупреждение — до необратимого шага: слово подтверждения ещё не введено.
      expect(within(dialog).getByRole('button', { name: 'Восстановить' })).toBeDisabled();
    });

    it('восстановление не удалось: слова сервера «текущая база не тронута» остаются в окне', async () => {
      mockBackups.restoreFails = true;
      renderPage(BackupsPage, '/settings/backups');
      const user = userEvent.setup();
      const dialog = await openRestore(user);
      await user.type(within(dialog).getByLabelText(/Для подтверждения введите/), 'ВОССТАНОВИТЬ');
      await user.click(within(dialog).getByRole('button', { name: 'Восстановить' }));
      expect(
        await within(dialog).findByText(
          'Восстановление не удалось, текущая база не тронута: pg_restore: неожиданный конец архива',
        ),
      ).toBeInTheDocument();
      expect(within(dialog).queryByText('Панель перезапускается…')).not.toBeInTheDocument();
      expect(mockBackups.restored).toHaveLength(0);
      // Окно не заперто: можно закрыть или попробовать ещё раз.
      expect(within(dialog).getByRole('button', { name: 'Отмена' })).toBeEnabled();
      expect(within(dialog).getByRole('button', { name: 'Восстановить' })).toBeEnabled();
    });

    it('сбой без объяснения: окно не утверждает, что база не тронута', async () => {
      server.use(
        http.post(
          '/api/backups/:name/restore',
          () => new HttpResponse('<h1>502 Bad Gateway</h1>', { status: 502 }),
        ),
      );
      renderPage(BackupsPage, '/settings/backups');
      const user = userEvent.setup();
      const dialog = await openRestore(user);
      await user.type(within(dialog).getByLabelText(/Для подтверждения введите/), 'ВОССТАНОВИТЬ');
      await user.click(within(dialog).getByRole('button', { name: 'Восстановить' }));
      const note = await within(dialog).findByText(/Панель не подтвердила восстановление/);
      expect(note).toHaveTextContent(/неизвестно/);
      expect(within(dialog).queryByText(/не тронута/)).not.toBeInTheDocument();
    });

    it('отказ до начала (идёт копия) — причина сервера в окне, без догадок о базе', async () => {
      renderPage(BackupsPage, '/settings/backups');
      const user = userEvent.setup();
      const dialog = await openRestore(user);
      await user.type(within(dialog).getByLabelText(/Для подтверждения введите/), 'ВОССТАНОВИТЬ');
      server.use(
        http.post('/api/backups/:name/restore', () =>
          HttpResponse.json(
            {
              type: 'urn:nodeservice:problem:backup-busy',
              title: 'Конфликт',
              status: 409,
              detail: 'Копия уже делается — дождитесь окончания.',
            },
            { status: 409, headers: { 'content-type': 'application/problem+json' } },
          ),
        ),
      );
      await user.click(within(dialog).getByRole('button', { name: 'Восстановить' }));
      expect(
        await within(dialog).findByText('Копия уже делается — дождитесь окончания.'),
      ).toBeInTheDocument();
      expect(within(dialog).queryByText(/Панель не подтвердила восстановление/)).not.toBeInTheDocument();
    });
  });
});
