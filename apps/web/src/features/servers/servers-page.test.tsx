import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetMockState } from '@/test/msw/handlers';
import { makeCheck, mockMaintenance, seedMaintenance } from '@/test/msw/maintenance-mock';
import { MOCK_SECURITY, mockSecurity } from '@/test/msw/security-mock';
import { MOCK_SSH, mockServers, seedServers } from '@/test/msw/servers-mock';
import { renderPage } from '@/test/render';
import { ServersPage } from './servers-page';

function Harness() {
  const [tag, setTag] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState<string | undefined>(undefined);
  return <ServersPage tag={tag} onTag={setTag} openId={open} onOpen={setOpen} />;
}

const cards = () => screen.getAllByRole('article');

describe('ServersPage', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    seedServers();
  });

  it('список: имя, адрес, ОС и архитектура, теги, статусы SSH и агента', async () => {
    renderPage(Harness, '/servers');
    await screen.findByText('de-fra-01');
    expect(cards()).toHaveLength(2);
    expect(screen.getByText('root@203.0.113.7:22')).toBeInTheDocument();
    expect(screen.getByText(/Ubuntu 24.04 · x86_64/)).toBeInTheDocument();
    expect(screen.getByText(/Debian 13 · aarch64/)).toBeInTheDocument();
    expect(screen.getByText('Агент в сети')).toBeInTheDocument();
    expect(screen.getByText('Агент не установлен')).toBeInTheDocument();
    expect(screen.getByText(/SSH недоступен/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Перетащить/ })).toHaveLength(2);
  });

  it('фильтр по тегу (выпадающий список) и поиску', async () => {
    renderPage(Harness, '/servers');
    await screen.findByText('de-fra-01');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Теги' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'de' }));
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Тег: de' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Тег: de' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Все серверы' }));
    await waitFor(() => expect(cards()).toHaveLength(2));
    await user.type(screen.getByLabelText('Поиск по серверам'), 'node-2');
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(screen.getByText('nl-ams-02')).toBeInTheDocument();
  });

  it('дублировать из меню: копия появляется сразу, имя с номером', async () => {
    renderPage(Harness, '/servers');
    await screen.findByText('de-fra-01');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Действия с de-fra-01' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Дублировать' }));
    expect(await screen.findByText('de-fra-01-2')).toBeInTheDocument();
    expect(mockServers.items).toHaveLength(3);
    expect(mockServers.items.find((s) => s.name === 'de-fra-01-2')).toMatchObject({
      host: '203.0.113.7',
      tags: ['prod', 'de'],
      agentStatus: 'not_installed',
    });
  });

  it('клик по карточке: большая модалка с вкладками Метрики/Журнал/Подключение', async () => {
    renderPage(Harness, '/servers');
    const user = userEvent.setup();
    await user.click(await screen.findByText('de-fra-01'));
    const dialog = await screen.findByRole('dialog', { name: 'de-fra-01' });
    expect(within(dialog).getByRole('button', { name: 'Метрики' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Журнал' })).toBeInTheDocument();
    // вкладка «Подключение»: бывшие настройки одним экраном
    await user.click(within(dialog).getByRole('button', { name: 'Подключение' }));
    expect(within(dialog).getByLabelText('Название')).toHaveValue('de-fra-01');
    expect(within(dialog).getByLabelText('IP или домен')).toHaveValue('203.0.113.7');
    expect(within(dialog).getByRole('button', { name: 'SSH-терминал' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Сохранить' })).toBeInTheDocument();
    // журнал сервера
    await user.click(within(dialog).getByRole('button', { name: 'Журнал' }));
    expect(await within(dialog).findByText('Открыть в Журнале')).toHaveAttribute(
      'href',
      expect.stringContaining('/audit?target='),
    );
    // История терминала: список сессий и запись вывода без ANSI-кодов
    await user.click(within(dialog).getByRole('button', { name: 'Терминал' }));
    expect(await within(dialog).findByText(/закрыт пользователем/)).toBeInTheDocument();
    const transcript = await within(dialog).findByTestId('terminal-transcript');
    expect(transcript).toHaveTextContent('nodectl status');
    expect(transcript).toHaveTextContent('Fail2Ban: active');
    expect(transcript.textContent).not.toContain('[32m');
  });

  it('история терминала: поиск по записям считает совпадения, подсвечивает и листает их', async () => {
    renderPage(Harness, '/servers');
    const user = userEvent.setup();
    await user.click(await screen.findByText('de-fra-01'));
    const dialog = await screen.findByRole('dialog', { name: 'de-fra-01' });
    await user.click(within(dialog).getByRole('button', { name: 'Терминал' }));
    await within(dialog).findByTestId('terminal-transcript');
    const search = within(dialog).getByLabelText('Поиск по истории терминала');
    await user.type(search, 'ACTIVE');
    // без регистра: «UFW: active» и «Fail2Ban: active» → 2 совпадения в 1 сессии
    expect(await within(dialog).findByText(/Найдено 2 совпадения в 1 сессии/)).toBeInTheDocument();
    expect(within(dialog).getByText('2 совпадения')).toBeInTheDocument();
    const marks = within(dialog).getByTestId('terminal-transcript').querySelectorAll('mark');
    expect(marks).toHaveLength(2);
    expect(within(dialog).getByText('1 из 2')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(within(dialog).getByText('2 из 2')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Следующее совпадение' }));
    expect(within(dialog).getByText('1 из 2')).toBeInTheDocument();
    // ничего не найдено — пустое состояние, а не пустой список
    await user.clear(search);
    await user.type(search, 'нет-такого');
    expect(await within(dialog).findByText('Совпадений нет')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Очистить поиск' }));
    expect(await within(dialog).findByText(/закрыт пользователем/)).toBeInTheDocument();
  });

  describe('вкладка «Обслуживание»', () => {
    const openTab = async () => {
      renderPage(Harness, '/servers');
      const user = userEvent.setup();
      await user.click(await screen.findByText('de-fra-01'));
      const dialog = await screen.findByRole('dialog', { name: 'de-fra-01' });
      await user.click(within(dialog).getByRole('button', { name: 'Обслуживание' }));
      return { user, dialog };
    };

    it('чек-лист: строки с уровнями, кнопки только у проблем, перезагрузка — только вручную', async () => {
      const { dialog } = await openTab();
      const list = await within(dialog).findByRole('list', { name: 'Чек-лист сервера' });
      expect(within(list).getByText('65 обновлений, из них 1 безопасности')).toBeInTheDocument();
      expect(within(list).getByText('Перезагрузка не требуется')).toBeInTheDocument();
      expect(within(list).getByText('Агент v0.5.4, доступна v0.6.0')).toBeInTheDocument();
      expect(within(list).getByText('Диск: 16% занято')).toBeInTheDocument();
      expect(within(list).getByText('Автообновления безопасности выключены')).toBeInTheDocument();
      expect(within(list).getAllByRole('button', { name: 'Обновить' })).toHaveLength(2);
      expect(within(list).getByRole('button', { name: 'Очистить' })).toBeInTheDocument();
      expect(within(list).getByRole('button', { name: 'Включить' })).toBeInTheDocument();
      expect(within(list).getAllByText('T2')).toHaveLength(3);
      expect(within(list).getByText('T1')).toBeInTheDocument();
      expect(within(dialog).getByText(/Проверено 10 мин назад · следующая через/)).toBeInTheDocument();
    });

    it('T2: обновление системы через подтверждение, шаги идут по очереди, чек-лист меняется', async () => {
      const { user, dialog } = await openTab();
      const list = await within(dialog).findByRole('list', { name: 'Чек-лист сервера' });
      await user.click(within(list).getAllByRole('button', { name: 'Обновить' })[0] as HTMLElement);
      const confirm = await screen.findByRole('alertdialog', { name: 'Обновить систему на «de-fra-01»?' });
      expect(within(confirm).getByText(/65 пакетов/)).toBeInTheDocument();
      await user.click(within(confirm).getByRole('button', { name: 'Да, обновить' }));
      const run = await within(dialog).findByTestId('maintenance-run');
      expect(within(run).getByRole('button', { name: /Обновление системы/ })).toBeInTheDocument();
      expect(within(run).getByText('Установка обновлений', { exact: false })).toBeInTheDocument();
      // пока идёт — кнопки чек-листа заблокированы
      expect(within(list).getByRole('button', { name: 'Очистить' })).toBeDisabled();
      expect(await within(run).findByText(/успешно за/, {}, { timeout: 4000 })).toBeInTheDocument();
      expect(within(run).getByTestId('maintenance-log')).toHaveTextContent('Setting up openssl');
      // после действия: обновлений нет, нужна перезагрузка (T3, без кнопки)
      await waitFor(() => expect(within(list).getByText('Обновлений нет')).toBeInTheDocument());
      expect(within(list).getByText('Требуется перезагрузка')).toBeInTheDocument();
      expect(within(list).getByText('T3')).toBeInTheDocument();
      expect(within(list).getByText(/только вручную: reboot/)).toBeInTheDocument();
      expect(within(list).queryByRole('button', { name: 'Перезагрузить' })).not.toBeInTheDocument();
    });

    it('T1: агент обновляется без подтверждения; ошибка шага — карточка с логом и пропущенными шагами', async () => {
      const { user, dialog } = await openTab();
      const list = await within(dialog).findByRole('list', { name: 'Чек-лист сервера' });
      await user.click(within(list).getAllByRole('button', { name: 'Обновить' })[1] as HTMLElement);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      const run = await within(dialog).findByTestId('maintenance-run');
      expect(await within(run).findByText(/успешно за/, {}, { timeout: 4000 })).toBeInTheDocument();
      await waitFor(() => expect(within(list).getByText('Агент v0.6.0')).toBeInTheDocument());

      mockMaintenance.failStep = 'clean';
      await user.click(within(list).getByRole('button', { name: 'Очистить' }));
      await user.click(
        within(await screen.findByRole('alertdialog', { name: 'Очистить диск на «de-fra-01»?' })).getByRole(
          'button',
          {
            name: 'Да, очистить',
          },
        ),
      );
      const failed = await within(dialog).findByText(
        /ошибка: команда завершилась с кодом 100/,
        {},
        { timeout: 4000 },
      );
      const card = failed.closest('[data-testid="maintenance-run"]') as HTMLElement;
      expect(within(card).getByText(/Системный журнал до 200 МБ/)).toBeInTheDocument();
      expect(within(card).getAllByText('пропущен')).toHaveLength(2);
      expect(within(card).getByTestId('maintenance-log')).toHaveTextContent('сломан для теста');
    });

    it('сервер ещё не проверяли: пустое состояние с кнопкой, после проверки — чек-лист', async () => {
      seedMaintenance(mockServers.items[0]?.id ?? '', null);
      const { user, dialog } = await openTab();
      expect(await within(dialog).findByText('Сервер ещё не проверяли')).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Проверить сейчас' }));
      expect(await within(dialog).findByText('Проверяем сервер…')).toBeInTheDocument();
      expect(
        await within(dialog).findByRole('list', { name: 'Чек-лист сервера' }, { timeout: 4000 }),
      ).toBeInTheDocument();
    });

    it('не Debian/Ubuntu: обновления недоступны, строки без кнопок', async () => {
      seedMaintenance(
        mockServers.items[0]?.id ?? '',
        makeCheck({ supported: false, updates: null, unattended: null, warnings: ['нет apt'] }),
      );
      const { dialog } = await openTab();
      const list = await within(dialog).findByRole('list', { name: 'Чек-лист сервера' });
      expect(within(list).getByText('Обновления через apt недоступны')).toBeInTheDocument();
      expect(within(list).queryByRole('button', { name: 'Очистить' })).not.toBeInTheDocument();
      expect(within(list).queryByRole('button', { name: 'Включить' })).not.toBeInTheDocument();
    });
  });

  it('меню «Изменить» открывает модалку сразу на «Подключении», удаление изнутри работает', async () => {
    renderPage(Harness, '/servers');
    await screen.findByText('de-fra-01');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Действия с de-fra-01' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Изменить' }));
    const dialog = await screen.findByRole('dialog', { name: 'de-fra-01' });
    expect(within(dialog).getByLabelText('Название')).toHaveValue('de-fra-01');
    await user.click(within(dialog).getByRole('button', { name: 'Удалить сервер' }));
    await user.click(await screen.findByRole('button', { name: 'Да, удалить' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'de-fra-01' })).not.toBeInTheDocument());
    expect(mockServers.items.find((sv) => sv.name === 'de-fra-01')).toBeUndefined();
  });

  it('проверить все: статусы SSH обновляются у всех карточек разом', async () => {
    renderPage(Harness, '/servers');
    await screen.findByText('de-fra-01');
    expect(screen.getByText('SSH недоступен')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Проверить все' }));
    // массовая проверка — с подтверждением
    await user.click(await screen.findByRole('button', { name: 'Да, проверить' }));
    await waitFor(() => expect(screen.getAllByText('SSH в порядке')).toHaveLength(2));
  });

  it('удаление при просроченном step-up: диалог пароля, после подтверждения сервер удалён', async () => {
    mockSecurity.stepUpFresh = false;
    renderPage(Harness, '/servers');
    await screen.findByText('de-fra-01');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Действия с de-fra-01' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Удалить' }));
    await user.click(await screen.findByRole('button', { name: 'Да, удалить' }));
    const stepUp = await screen.findByRole('dialog', { name: 'Подтверди пароль' });
    await user.type(within(stepUp).getByLabelText('Пароль'), MOCK_SECURITY.password);
    await user.click(within(stepUp).getByRole('button', { name: 'Подтвердить' }));
    await waitFor(() => expect(screen.queryByText('de-fra-01')).not.toBeInTheDocument());
    expect(mockServers.items).toHaveLength(1);
  });

  it('добавление: проверка подключения показывает факты, создание добавляет карточку', async () => {
    renderPage(Harness, '/servers');
    await screen.findByText('de-fra-01');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Добавить сервер' }));
    const dialog = await screen.findByRole('dialog', { name: 'Добавить сервер' });
    await user.type(within(dialog).getByLabelText('Название'), 'fi-hel-03');
    await user.type(within(dialog).getByLabelText('IP или домен'), '198.51.100.99');
    await user.type(within(dialog).getByLabelText('Пароль'), MOCK_SSH.password);
    await user.click(within(dialog).getByRole('button', { name: 'Проверить и добавить' }));
    // ход проверки виден прямо в диалоге: факты и отпечаток
    const result = await within(dialog).findByTestId('test-result');
    expect(await within(result).findByText(/node-1 · Ubuntu · 24.04/)).toBeInTheDocument();
    expect(within(result).getByText(MOCK_SSH.fingerprint)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 3000 });
    expect(await screen.findByText('fi-hel-03')).toBeInTheDocument();
    expect(mockServers.items).toHaveLength(3);
  });

  it('установка агента по SSH из диалога: статус становится «Ожидает агента»', async () => {
    renderPage(Harness, '/servers');
    await screen.findByText('de-fra-01');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Действия с de-fra-01' }));
    // у ноды с агентом в сети пункт называется «Переустановить агента»
    await user.click(await screen.findByRole('menuitem', { name: /становить агента/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Установка агента' });
    expect(within(dialog).getByText(/github\.com\/feauche\/nodeservice-agent/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Установить по SSH' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockServers.items[0]?.agentStatus).toBe('pending');
    expect(await screen.findByText('Ожидает агента')).toBeInTheDocument();
  });

  it('добавление без проверки (ключ панели): мгновенно, статус «SSH не проверен»', async () => {
    renderPage(Harness, '/servers');
    await screen.findByText('de-fra-01');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Добавить сервер' }));
    const dialog = await screen.findByRole('dialog', { name: 'Добавить сервер' });
    await user.type(within(dialog).getByLabelText('Название'), 'fi-hel-04');
    await user.type(within(dialog).getByLabelText('IP или домен'), '198.51.100.77');
    await user.click(within(dialog).getByRole('button', { name: 'Ключ панели' }));
    await user.click(within(dialog).getByRole('button', { name: 'Добавить без проверки' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('fi-hel-04')).toBeInTheDocument();
    expect(mockServers.items.find((s) => s.name === 'fi-hel-04')?.sshOk).toBeNull();
    expect(screen.getAllByText('SSH не проверен').length).toBeGreaterThan(0);
  });

  it('добавление: неверный пароль — ошибка формы, дубль имени — ошибка у поля', async () => {
    renderPage(Harness, '/servers');
    await screen.findByText('de-fra-01');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Добавить сервер' }));
    const dialog = await screen.findByRole('dialog', { name: 'Добавить сервер' });
    await user.type(within(dialog).getByLabelText('Название'), 'de-fra-01');
    await user.type(within(dialog).getByLabelText('IP или домен'), '198.51.100.98');
    await user.type(within(dialog).getByLabelText('Пароль'), 'wrong');
    await user.click(within(dialog).getByRole('button', { name: 'Проверить и добавить' }));
    expect(await within(dialog).findByText('Пароль или ключ не подошли.')).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('Пароль'));
    await user.type(within(dialog).getByLabelText('Пароль'), MOCK_SSH.password);
    await user.click(within(dialog).getByRole('button', { name: 'Проверить и добавить' }));
    expect(await within(dialog).findByText('Название уже занято')).toBeInTheDocument();
  });

  it('проверка связи при смене отпечатка: диалог сравнения, «Доверять новому» чинит', async () => {
    mockServers.hostKeyChanged = true;
    renderPage(Harness, '/servers');
    await screen.findByText('de-fra-01');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Действия с de-fra-01' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Проверить связь по SSH' }));
    const dialog = await screen.findByRole('dialog', { name: 'Отпечаток сервера изменился' });
    expect(within(dialog).getByText(MOCK_SSH.fingerprint)).toBeInTheDocument();
    expect(within(dialog).getByText(MOCK_SSH.newFingerprint)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Доверять новому' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockServers.items[0]?.hostKeyFingerprint).toBe(MOCK_SSH.newFingerprint);
  });

  it('удаление через меню: подтверждение, карточка исчезает', async () => {
    renderPage(Harness, '/servers');
    await screen.findByText('de-fra-01');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Действия с de-fra-01' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Удалить' }));
    await user.click(await screen.findByRole('button', { name: 'Да, удалить' }));
    await waitFor(() => expect(screen.queryByText('de-fra-01')).not.toBeInTheDocument());
    expect(mockServers.items).toHaveLength(1);
  });

  it('пустое состояние зовёт добавить первый сервер', async () => {
    mockServers.items = [];
    renderPage(Harness, '/servers');
    expect(await screen.findByText('Серверов пока нет')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Добавить сервер' }).length).toBeGreaterThan(0);
  });
});
