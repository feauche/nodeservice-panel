import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetMockState } from '@/test/msw/handlers';
import { mockServers, seedServers } from '@/test/msw/servers-mock';
import { renderPage } from '@/test/render';
import { ServerModalHost } from './server-modal-host';
import { openServer, useServerModalStore } from './server-modal-store';

function Harness() {
  return <ServerModalHost />;
}

async function openProfile() {
  const id = (mockServers.items[0] as { id: string }).id;
  renderPage(Harness, '/servers');
  openServer(id, 'profile');
  const dialog = await screen.findByRole('dialog', { name: 'de-fra-01' });
  return { dialog, id };
}

const server = () => mockServers.items[0] as (typeof mockServers.items)[number];

describe('вкладка «Профиль» (J3, A5 + R2 + C3)', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    seedServers();
    useServerModalStore.getState().close();
  });

  it('пустой профиль: подсказка, снимка нет, «Сохранить» недоступна', async () => {
    const { dialog } = await openProfile();
    expect(within(dialog).getByTestId('profile-summary')).toHaveTextContent('Ожидаемое не задано');
    expect(within(dialog).getByText('Снимка ещё нет')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Пока ничего не добавлено\. Добавьте контейнеры и порты/),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: 'Отменить' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Взять из текущего состояния' })).toBeNull();
  });

  it('пояснения: зачем профиль, «Необязательно» у четырёх блоков, подсказки к функциям и важности', async () => {
    const { dialog } = await openProfile();
    expect(
      within(dialog).getByText(/Джарвис по этим данным понимает, что сломается при сбое/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Заполнять необязательно: без профиля он работает как раньше/),
    ).toBeInTheDocument();
    expect(within(dialog).getAllByText('Необязательно')).toHaveLength(4);
    // Мост назван мостом и объяснён
    expect(
      within(dialog).getByRole('checkbox', { name: 'Мост: передаёт трафик на другой сервер' }),
    ).toHaveAccessibleDescription(/Переходник между вашими серверами/);
    expect(within(dialog).getByText(/Приложения клиентов подключаются к этому серверу/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Например: remnanode, порт 443/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Когда можно обновлять и перезагружать сервер/)).toBeInTheDocument();
  });

  it('функции сервера: отмечать можно несколько, повторное нажатие снимает отметку', async () => {
    const { dialog } = await openProfile();
    const user = userEvent.setup();
    const entry = within(dialog).getByRole('checkbox', { name: 'Принимает подключения клиентов' });
    const exit = within(dialog).getByRole('checkbox', { name: 'Выпускает трафик в интернет' });
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(5);
    await user.click(entry);
    await user.click(exit);
    expect(entry).toHaveAttribute('aria-checked', 'true');
    expect(exit).toHaveAttribute('aria-checked', 'true');
    expect(within(dialog).getByRole('button', { name: 'Сохранить' })).toBeEnabled();
    await user.click(entry);
    expect(entry).toHaveAttribute('aria-checked', 'false');
    expect(exit).toHaveAttribute('aria-checked', 'true');
    await user.click(exit);
    expect(within(dialog).getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  });

  it('важность: подсказки ко всем трём значениям видны сразу, выбранное подсвечено', async () => {
    const { dialog } = await openProfile();
    const user = userEvent.setup();
    const hints = within(dialog).getByRole('list', { name: 'Что значит каждая важность' });
    const items = within(hints).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent(/Критичный\. Без него клиенты теряют доступ/);
    expect(items[1]).toHaveTextContent(/Обычный\. Один из нескольких равноценных серверов/);
    expect(items[2]).toHaveTextContent(/Второстепенный\. Запасной или тестовый сервер/);
    expect(items.map((i) => i.dataset.selected)).toEqual(['false', 'true', 'false']);
    const importance = within(dialog).getByRole('radiogroup', { name: 'Важность сервера' });
    await user.click(within(importance).getByRole('radio', { name: 'Критичный' }));
    expect(items.map((i) => i.dataset.selected)).toEqual(['true', 'false', 'false']);
    expect(within(dialog).getByText('Сейчас важность влияет только на советы Джарвиса.')).toBeInTheDocument();
  });

  it('нода Remnawave стоит первым блоком: режимы, состояние, отмена возвращает сохранённое', async () => {
    const { dialog } = await openProfile();
    const user = userEvent.setup();
    const headings = within(dialog)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(headings.slice(0, 2)).toEqual(['Нода Remnawave на сервере', 'Что делает сервер']);
    expect(within(dialog).getByText('Ещё не проверяли')).toBeInTheDocument();
    const auto = within(dialog).getByRole('button', { name: /Определять автоматически/ });
    expect(auto).toHaveAttribute('aria-pressed', 'true');
    expect(
      within(dialog).getByText(/Панель следит за нодой, только если найдёт её контейнер/),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /Нет, не следить/ }));
    expect(within(dialog).getByText('Слежение выключено')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/инцидент об остановленной ноде заводиться не будет/),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Сохранить' })).toBeEnabled();
    await user.click(within(dialog).getByRole('button', { name: 'Отменить' }));
    expect(within(dialog).getByRole('button', { name: /Определять автоматически/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(dialog).getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  });

  it('слежение за нодой сохраняется вместе с профилем одним запросом', async () => {
    const { dialog } = await openProfile();
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole('button', { name: /Есть, следить/ }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Выпускает трафик в интернет' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Принимает подключения клиентов' }));
    const importance = within(dialog).getByRole('radiogroup', { name: 'Важность сервера' });
    await user.click(within(importance).getByRole('radio', { name: 'Критичный' }));
    await user.type(within(dialog).getByLabelText('Окно обслуживания'), 'ночью 03:00–05:00');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    await waitFor(() =>
      expect(server().profile).toMatchObject({
        roles: ['entry', 'exit'],
        importance: 'critical',
        maintenanceWindow: 'ночью 03:00–05:00',
      }),
    );
    expect(server().nodeWatch).toBe('on');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Сохранить' })).toBeDisabled());
    expect(within(dialog).getByRole('button', { name: /Есть, следить/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('на вкладке «Подключение» блока про ноду больше нет', async () => {
    const { dialog } = await openProfile();
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole('button', { name: 'Подключение' }));
    expect(await within(dialog).findByLabelText('Название')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Нет, не следить/ })).toBeNull();
    expect(within(dialog).queryByText(/Нода Remnawave на сервере/)).toBeNull();
    expect(within(dialog).queryByRole('heading', { name: 'Нода' })).toBeNull();
  });

  it('добавление контейнера и порта: проверка имени, дубликатов и диапазона', async () => {
    const { dialog } = await openProfile();
    const user = userEvent.setup();

    await user.click(within(dialog).getByRole('button', { name: 'Контейнер' }));
    const cInput = within(dialog).getByRole('textbox', { name: 'Контейнер' });
    await user.type(cInput, 'bad name!{Enter}');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Имя контейнера');
    await user.clear(cInput);
    await user.type(cInput, 'remnanode{Enter}');
    expect(within(dialog).getByText('Контейнер remnanode')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Контейнер' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Контейнер' }), 'RemnaNode{Enter}');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Такой контейнер уже в списке.');
    await user.keyboard('{Escape}');

    await user.click(within(dialog).getByRole('button', { name: 'Порт' }));
    const pInput = within(dialog).getByRole('textbox', { name: 'Порт' });
    await user.type(pInput, '70000{Enter}');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Порт: число от 1 до 65535.');
    await user.clear(pInput);
    await user.type(pInput, '443{Enter}');
    expect(within(dialog).getByText('Порт 443')).toBeInTheDocument();
    expect(within(dialog).getAllByText('Не проверялось')).toHaveLength(2);
    expect(within(dialog).getByText('Есть несохранённые изменения')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Убрать: Порт 443' }));
    expect(within(dialog).queryByText('Порт 443')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Отменить' }));
    expect(within(dialog).queryByText('Контейнер remnanode')).toBeNull();
    expect(server().profile.expectedContainers).toEqual([]);
  });

  it('сохранение ожидаемого при отсутствии снимка: снимок снимается сам, таблица и пилюля показывают расхождения', async () => {
    const { dialog } = await openProfile();
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole('button', { name: 'Контейнер' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Контейнер' }), 'remnanode{Enter}');
    await user.click(within(dialog).getByRole('button', { name: 'Контейнер' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Контейнер' }), 'nginx{Enter}');
    await user.click(within(dialog).getByRole('button', { name: 'Порт' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Порт' }), '8443{Enter}');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(server().inventory).not.toBeNull());
    const summary = within(dialog).getByTestId('profile-summary');
    await waitFor(() => expect(summary).toHaveTextContent('Не совпадает с ожидаемым: 2'));
    const table = within(dialog).getByRole('table');
    expect(within(table).getByText('Не работает (exited)')).toBeInTheDocument();
    expect(within(table).getByText('Работает')).toBeInTheDocument();
    expect(within(table).getByText('Никто не слушает')).toBeInTheDocument();
    expect(within(dialog).getByTestId('drift-pill')).toHaveTextContent('Расхождения: 2');
  });

  it('«Обновить состояние» и «Взять из текущего состояния»', async () => {
    const { dialog } = await openProfile();
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole('button', { name: 'Обновить состояние' }));
    expect(await within(dialog).findByText(/^Снимок /)).toBeInTheDocument();
    expect(within(dialog).getByTestId('profile-summary')).toHaveTextContent('Ожидаемое не задано');

    await user.click(within(dialog).getByRole('button', { name: 'Взять из текущего состояния' }));
    const table = within(dialog).getByRole('table');
    // Запущено только nginx (remnanode остановлен), снаружи слушают 22 и 443.
    expect(within(table).getByText('Контейнер nginx')).toBeInTheDocument();
    expect(within(table).queryByText('Контейнер remnanode')).toBeNull();
    expect(within(table).getByText('Порт 22')).toBeInTheDocument();
    expect(within(table).getByText('Порт 443')).toBeInTheDocument();
    expect(within(dialog).getByTestId('profile-summary')).toHaveTextContent('Всё совпадает с ожидаемым');
    expect(within(table).getByText('Слушает sshd')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(server().profile.expectedContainers).toEqual(['nginx']));
    expect(server().profile.expectedPorts).toEqual([22, 443]);
    expect(within(dialog).queryByTestId('drift-pill')).toBeNull();
  });

  it('пилюля «Расхождения: N» в шапке открывает вкладку «Профиль»', async () => {
    const s = server();
    mockServers.items[0] = {
      ...s,
      profile: { ...s.profile, expectedContainers: ['remnanode'] },
      drift: [{ kind: 'container_not_running', subject: 'remnanode', detail: 'Контейнер remnanode: exited' }],
    } as typeof s;
    const id = s.id;
    renderPage(Harness, '/servers');
    openServer(id, 'metrics');
    const dialog = await screen.findByRole('dialog', { name: 'de-fra-01' });
    const user = userEvent.setup();
    await user.click(await within(dialog).findByTestId('drift-pill'));
    expect(within(dialog).getByRole('button', { name: 'Профиль' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByLabelText('Окно обслуживания')).toBeInTheDocument();
  });
});
