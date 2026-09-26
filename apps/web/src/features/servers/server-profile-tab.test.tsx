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

describe('вкладка «Профиль» (J3, A5 + C3)', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    seedServers();
    useServerModalStore.getState().close();
  });

  it('пустой профиль: подсказка, снимка нет, «Сохранить» недоступна', async () => {
    const { dialog } = await openProfile();
    expect(within(dialog).getByTestId('profile-summary')).toHaveTextContent('Ожидаемое не задано');
    expect(within(dialog).getByText('Снимка ещё нет')).toBeInTheDocument();
    expect(within(dialog).getByText(/Ожидаемое не задано\. Добавьте контейнеры и порты/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: 'Отменить' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Взять из текущего состояния' })).toBeNull();
  });

  it('роль и важность: выбор, повторный клик по роли сбрасывает, сохранение уходит в PATCH', async () => {
    const { dialog } = await openProfile();
    const user = userEvent.setup();
    const role = within(dialog).getByRole('radiogroup', { name: 'Роль сервера в парке' });
    await user.click(within(role).getByRole('radio', { name: 'Входной' }));
    expect(within(role).getByRole('radio', { name: 'Входной' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(role).getByRole('radio', { name: 'Входной' }));
    expect(within(role).getByRole('radio', { name: 'Входной' })).toHaveAttribute('aria-checked', 'false');
    expect(within(dialog).getByRole('button', { name: 'Сохранить' })).toBeDisabled();

    await user.click(within(role).getByRole('radio', { name: 'Выходной' }));
    const importance = within(dialog).getByRole('radiogroup', { name: 'Важность сервера' });
    await user.click(within(importance).getByRole('radio', { name: 'Критичный' }));
    await user.type(within(dialog).getByLabelText('Окно обслуживания'), 'ночью 03:00–05:00');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    await waitFor(() =>
      expect(server().profile).toMatchObject({
        role: 'exit',
        importance: 'critical',
        maintenanceWindow: 'ночью 03:00–05:00',
      }),
    );
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Сохранить' })).toBeDisabled());
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
