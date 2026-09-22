import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetMockState } from '@/test/msw/handlers';
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
    expect(await within(dialog).findByText('Открыть весь Журнал')).toBeInTheDocument();
    // История терминала: список сессий и запись вывода без ANSI-кодов
    await user.click(within(dialog).getByRole('button', { name: 'Терминал' }));
    expect(await within(dialog).findByText(/закрыт пользователем/)).toBeInTheDocument();
    const transcript = await within(dialog).findByTestId('terminal-transcript');
    expect(transcript).toHaveTextContent('nodectl status');
    expect(transcript).toHaveTextContent('Fail2Ban: active');
    expect(transcript.textContent).not.toContain('[32m');
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
