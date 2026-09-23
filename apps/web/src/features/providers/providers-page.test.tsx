import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetMockState } from '@/test/msw/handlers';
import { mockProviders } from '@/test/msw/providers-mock';
import { mockServers, seedServers } from '@/test/msw/servers-mock';
import { renderPage } from '@/test/render';
import { ProvidersPage } from './providers-page';

describe('ProvidersPage', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    seedServers();
  });

  it('две панели: список слева, карточка выбранного с сайтом, серверами и заметкой', async () => {
    const aeza = mockProviders.items[0];
    if (!aeza || !mockServers.items[0]) throw new Error('seed');
    mockServers.items[0].providerId = aeza.id;
    renderPage(ProvidersPage, '/servers/providers', ['/servers']);
    const list = await screen.findByRole('list', { name: 'Провайдеры' });
    expect(within(list).getAllByRole('button')).toHaveLength(3);
    expect(within(list).getByRole('button', { name: /Aéza/ })).toHaveAttribute('aria-pressed', 'true');
    expect(await within(list).findByText('1 сервер')).toBeInTheDocument();

    const card = screen.getByTestId('provider-card');
    expect(within(card).getByRole('heading', { name: 'Aéza' })).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: /aeza\.net/ })).toHaveAttribute('href', 'https://aeza.net');
    expect(await within(card).findByRole('link', { name: /de-fra-01/ })).toHaveAttribute(
      'href',
      expect.stringContaining('/servers?open='),
    );
    expect(within(card).getByLabelText('Заметка')).toHaveValue('аккаунт lumax@…, оплата до 5 октября');

    const user = userEvent.setup();
    await user.click(within(list).getByRole('button', { name: /Hetzner/ }));
    expect(
      within(screen.getByTestId('provider-card')).getByRole('heading', { name: 'Hetzner' }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/Серверов у этого провайдера пока нет/)).toBeInTheDocument();

    // поиск по названию и сайту
    await user.type(screen.getByLabelText('Поиск по провайдерам'), 'timeweb.cl');
    expect(within(list).getAllByRole('button')).toHaveLength(1);
  });

  it('добавление: превью иконки по адресу сайта, новый провайдер становится выбранным', async () => {
    renderPage(ProvidersPage, '/servers/providers', ['/servers']);
    await screen.findByRole('list', { name: 'Провайдеры' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Добавить провайдера' }));
    const dialog = await screen.findByRole('dialog', { name: 'Новый провайдер' });
    expect(within(dialog).getByTestId('provider-icon-state')).toHaveTextContent('появится после ввода сайта');
    await user.type(within(dialog).getByLabelText('Название'), 'Hetzner');
    await user.type(within(dialog).getByLabelText('Сайт'), 'hetzner.com');
    await waitFor(() =>
      expect(within(dialog).getByTestId('provider-icon-state')).toHaveTextContent('нашли на сайте'),
    );
    // имя занято — ошибка у поля, диалог остаётся
    await user.click(within(dialog).getByRole('button', { name: 'Добавить' }));
    expect(await within(dialog).findByText('Название уже занято')).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('Название'));
    await user.type(within(dialog).getByLabelText('Название'), 'Contabo');
    await user.clear(within(dialog).getByLabelText('Сайт'));
    await user.type(within(dialog).getByLabelText('Сайт'), 'contabo.com');
    await waitFor(() =>
      expect(within(dialog).getByTestId('provider-icon-state')).toHaveTextContent('на сайте иконки нет'),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Добавить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockProviders.items.map((p) => p.name)).toContain('Contabo');
    expect(mockProviders.items.find((p) => p.name === 'Contabo')?.siteUrl).toBe('https://contabo.com');
    expect(
      within(screen.getByTestId('provider-card')).getByRole('heading', { name: 'Contabo' }),
    ).toBeInTheDocument();
  });

  it('заметка сохраняется, «Изменить» открывает форму с данными, удаление — после подтверждения', async () => {
    const aeza = mockProviders.items[0];
    if (!aeza || !mockServers.items[0]) throw new Error('seed');
    mockServers.items[0].providerId = aeza.id;
    renderPage(ProvidersPage, '/servers/providers', ['/servers']);
    const card = await screen.findByTestId('provider-card');
    const user = userEvent.setup();
    const note = within(card).getByLabelText('Заметка');
    expect(within(card).getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    await user.clear(note);
    await user.type(note, 'оплачено до декабря');
    await user.click(within(card).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockProviders.items[0]?.note).toBe('оплачено до декабря'));

    await user.click(within(card).getByRole('button', { name: 'Изменить' }));
    const edit = await screen.findByRole('dialog', { name: 'Изменить провайдера' });
    expect(within(edit).getByLabelText('Название')).toHaveValue('Aéza');
    expect(within(edit).getByLabelText('Сайт')).toHaveValue('https://aeza.net');
    await user.click(within(edit).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(within(card).getByRole('button', { name: 'Удалить' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Удалить провайдера «Aéza»?' });
    expect(within(confirm).getByText(/провайдер сбросится, сами серверы останутся/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Да, удалить' }));
    await waitFor(() => expect(mockProviders.items.map((p) => p.name)).not.toContain('Aéza'));
    expect(mockServers.items[0]?.providerId).toBeNull();
    expect(
      within(await screen.findByRole('list', { name: 'Провайдеры' })).getAllByRole('button'),
    ).toHaveLength(2);
  });

  it('ручная ссылка на иконку: превью по ней, сохраняется; в «Изменить» поле заполнено источником', async () => {
    renderPage(ProvidersPage, '/servers/providers', ['/servers']);
    await screen.findByRole('list', { name: 'Провайдеры' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Добавить провайдера' }));
    const dialog = await screen.findByRole('dialog', { name: 'Новый провайдер' });
    await user.type(within(dialog).getByLabelText('Название'), '4VPS');
    await user.type(within(dialog).getByLabelText('Сайт'), '4vps.su');
    await waitFor(() =>
      expect(within(dialog).getByTestId('provider-icon-state')).toHaveTextContent('на сайте иконки нет'),
    );
    // поле ссылки скрыто из порядка табуляции, пока не раскрыто
    expect(within(dialog).getByLabelText('Ссылка на иконку')).toHaveAttribute('tabindex', '-1');
    await user.click(within(dialog).getByRole('button', { name: 'Указать ссылку' }));
    expect(within(dialog).getByRole('button', { name: 'Скрыть ссылку' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await user.type(within(dialog).getByLabelText('Ссылка на иконку'), '4vps.su/assets/img/favicon_news.svg');
    await waitFor(() =>
      expect(within(dialog).getByTestId('provider-icon-state')).toHaveTextContent('по ссылке — нашли'),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Добавить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const created = mockProviders.items.find((p) => p.name === '4VPS');
    expect(created?.iconUrl).toBe('https://4vps.su/assets/img/favicon_news.svg');
    expect(created?.hasIcon).toBe(true);
    const card = screen.getByTestId('provider-card');
    expect(within(card).getByText(/Иконка по ссылке: 4vps\.su\/assets/)).toBeInTheDocument();

    // «Изменить»: ссылка уже в поле, поле раскрыто; очистка возвращает автопоиск
    await user.click(within(card).getByRole('button', { name: 'Изменить' }));
    const edit = await screen.findByRole('dialog', { name: 'Изменить провайдера' });
    const link = within(edit).getByLabelText('Ссылка на иконку');
    expect(link).toHaveValue('https://4vps.su/assets/img/favicon_news.svg');
    expect(link).not.toHaveAttribute('tabindex', '-1');
    expect(within(edit).getByTestId('provider-icon-state')).toHaveTextContent('по ручной ссылке');
    await user.clear(link);
    expect(within(edit).getByText('Пусто — панель найдёт иконку на сайте сама.')).toBeInTheDocument();
    await user.click(within(edit).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockProviders.items.find((p) => p.name === '4VPS')?.iconUrl).toBeNull();
  });

  it('«Изменить» у провайдера с найденной иконкой показывает адрес источника, без правок режим не меняется', async () => {
    renderPage(ProvidersPage, '/servers/providers', ['/servers']);
    const card = await screen.findByTestId('provider-card');
    expect(within(card).getByText(/Иконка с сайта: aeza\.net\/favicon\.ico/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(card).getByRole('button', { name: 'Изменить' }));
    const edit = await screen.findByRole('dialog', { name: 'Изменить провайдера' });
    expect(within(edit).getByLabelText('Ссылка на иконку')).toHaveValue('https://aeza.net/favicon.ico');
    expect(within(edit).getByText(/Найдена на сайте автоматически/)).toBeInTheDocument();
    await user.click(within(edit).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockProviders.items[0]?.iconUrl).toBeNull();
  });

  it('сайт за защитой: иконка из кэша Google, подписи в форме и на карточке', async () => {
    renderPage(ProvidersPage, '/servers/providers', ['/servers']);
    await screen.findByRole('list', { name: 'Провайдеры' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Добавить провайдера' }));
    const dialog = await screen.findByRole('dialog', { name: 'Новый провайдер' });
    await user.type(within(dialog).getByLabelText('Название'), 'Rawi');
    await user.type(within(dialog).getByLabelText('Сайт'), 'rawi.host');
    await waitFor(() =>
      expect(within(dialog).getByTestId('provider-icon-state')).toHaveTextContent(
        'на сайте нет, нашли в кэше Google',
      ),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Добавить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const card = screen.getByTestId('provider-card');
    expect(within(card).getByText(/Иконка из кэша Google/)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Изменить' }));
    const edit = await screen.findByRole('dialog', { name: 'Изменить провайдера' });
    expect(within(edit).getByTestId('provider-icon-state')).toHaveTextContent('из кэша Google');
    expect(within(edit).getByText(/взята из кэша Google/)).toBeInTheDocument();
  });

  it('пустой справочник: подсказка и кнопка добавления', async () => {
    mockProviders.items = [];
    renderPage(ProvidersPage, '/servers/providers', ['/servers']);
    expect(await screen.findByText('Провайдеров пока нет')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Добавить первого провайдера' })).toBeInTheDocument();
  });
});
