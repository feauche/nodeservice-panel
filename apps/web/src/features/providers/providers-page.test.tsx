import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetMockState } from '@/test/msw/handlers';
import { mockProviders } from '@/test/msw/providers-mock';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { ProvidersSourceContext } from './providers-api';
import { ProvidersPage } from './providers-page';

describe('ProvidersPage', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
  });

  it('две панели: список слева, карточка выбранного с сайтом и заметкой, строк своих серверов нет', async () => {
    renderPage(ProvidersPage, '/billing/providers');
    const list = await screen.findByRole('list', { name: 'Провайдеры' });
    expect(within(list).getAllByRole('button')).toHaveLength(3);
    expect(within(list).getByRole('button', { name: /Aéza/ })).toHaveAttribute('aria-pressed', 'true');

    const card = screen.getByTestId('provider-card');
    expect(within(card).getByRole('heading', { name: 'Aéza' })).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: /aeza\.net/ })).toHaveAttribute('href', 'https://aeza.net');
    expect(within(card).getByLabelText('Заметка')).toHaveValue('аккаунт lumax@…, оплата до 5 октября');
    // Своих серверов у панели больше нет: в карточке ни списка, ни ссылки на окно сервера.
    expect(within(card).queryByText('Серверы')).not.toBeInTheDocument();
    expect(within(card).queryByText(/открыть →/)).not.toBeInTheDocument();
    expect(within(card).queryByText(/окне сервера/)).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(list).getByRole('button', { name: /Hetzner/ }));
    expect(
      within(screen.getByTestId('provider-card')).getByRole('heading', { name: 'Hetzner' }),
    ).toBeInTheDocument();

    // поиск по названию и сайту
    await user.type(screen.getByLabelText('Поиск по провайдерам'), 'timeweb.cl');
    expect(within(list).getAllByRole('button')).toHaveLength(1);
  });

  it('добавление: превью иконки по адресу сайта, новый провайдер становится выбранным', async () => {
    renderPage(ProvidersPage, '/billing/providers');
    await screen.findByRole('list', { name: 'Провайдеры' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Добавить провайдера' }));
    const dialog = await screen.findByRole('dialog', { name: 'Новый провайдер' });
    expect(within(dialog).getByTestId('provider-icon-state')).toHaveTextContent('Появится после ввода сайта');
    await user.type(within(dialog).getByLabelText('Название'), 'Hetzner');
    await user.type(within(dialog).getByLabelText('Сайт'), 'hetzner.com');
    await waitFor(() =>
      expect(within(dialog).getByTestId('provider-icon-state')).toHaveTextContent('Нашли на сайте'),
    );
    // имя занято — ошибка у поля, диалог остаётся
    await user.click(within(dialog).getByRole('button', { name: 'Добавить' }));
    expect(await within(dialog).findByText('Название уже занято')).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('Название'));
    await user.type(within(dialog).getByLabelText('Название'), 'Contabo');
    await user.clear(within(dialog).getByLabelText('Сайт'));
    await user.type(within(dialog).getByLabelText('Сайт'), 'contabo.com');
    await waitFor(() =>
      expect(within(dialog).getByTestId('provider-icon-state')).toHaveTextContent('На сайте иконки нет'),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Добавить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockProviders.items.map((p) => p.name)).toContain('Contabo');
    expect(mockProviders.items.find((p) => p.name === 'Contabo')?.siteUrl).toBe('https://contabo.com');
    const card = screen.getByTestId('provider-card');
    expect(within(card).getByRole('heading', { name: 'Contabo' })).toBeInTheDocument();
    // сохранили сразу, иконка ищется в фоне: сначала «ищем», потом результат сам подтянулся
    expect(within(card).getByText('Ищем иконку на сайте…')).toBeInTheDocument();
    expect(
      await within(card).findByText('Иконка не найдена — показываем букву', {}, { timeout: 4000 }),
    ).toBeInTheDocument();
  });

  it('заметка сохраняется, «Изменить» открывает форму с данными, удаление — после подтверждения', async () => {
    renderPage(ProvidersPage, '/billing/providers');
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
    const confirm = await screen.findByRole('alertdialog', { name: 'Архивировать провайдера «Aéza»?' });
    expect(within(confirm).getByText(/название сохранится во всей истории оплат/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'В архив' }));
    await waitFor(() => expect(mockProviders.items.map((p) => p.name)).not.toContain('Aéza'));
    expect(
      within(await screen.findByRole('list', { name: 'Провайдеры' })).getAllByRole('button'),
    ).toHaveLength(2);
  });

  it('ручная ссылка на иконку: превью по ней, сохраняется; в «Изменить» поле заполнено источником', async () => {
    renderPage(ProvidersPage, '/billing/providers');
    await screen.findByRole('list', { name: 'Провайдеры' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Добавить провайдера' }));
    const dialog = await screen.findByRole('dialog', { name: 'Новый провайдер' });
    await user.type(within(dialog).getByLabelText('Название'), '4VPS');
    await user.type(within(dialog).getByLabelText('Сайт'), '4vps.su');
    await waitFor(() =>
      expect(within(dialog).getByTestId('provider-icon-state')).toHaveTextContent('На сайте иконки нет'),
    );
    // поле ссылки скрыто из порядка табуляции, пока не раскрыто
    expect(within(dialog).getByLabelText('Ссылка на иконку')).toHaveAttribute('tabindex', '-1');
    await user.click(within(dialog).getByRole('button', { name: 'Указать ссылку' }));
    expect(within(dialog).getByRole('button', { name: 'Скрыть ссылку' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    // ссылка на сайт за защитой: причина показана прямо в форме
    await user.type(within(dialog).getByLabelText('Ссылка на иконку'), 'https://rawi.host/favicon.svg');
    expect(await within(dialog).findByTestId('provider-icon-reason')).toHaveTextContent(/защита от ботов/);
    await user.clear(within(dialog).getByLabelText('Ссылка на иконку'));
    await user.type(within(dialog).getByLabelText('Ссылка на иконку'), '4vps.su/assets/img/favicon_news.svg');
    await waitFor(() =>
      expect(within(dialog).getByTestId('provider-icon-state')).toHaveTextContent('По ссылке — нашли'),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Добавить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const created = mockProviders.items.find((p) => p.name === '4VPS');
    expect(created?.iconUrl).toBe('https://4vps.su/assets/img/favicon_news.svg');
    await waitFor(() => expect(created?.hasIcon).toBe(true));
    const card = screen.getByTestId('provider-card');
    expect(
      await within(card).findByText(/Иконка по ссылке: 4vps\.su\/assets/, {}, { timeout: 4000 }),
    ).toBeInTheDocument();

    // «Изменить»: ссылка уже в поле, поле раскрыто; очистка возвращает автопоиск
    await user.click(within(card).getByRole('button', { name: 'Изменить' }));
    const edit = await screen.findByRole('dialog', { name: 'Изменить провайдера' });
    const link = within(edit).getByLabelText('Ссылка на иконку');
    expect(link).toHaveValue('https://4vps.su/assets/img/favicon_news.svg');
    expect(link).not.toHaveAttribute('tabindex', '-1');
    expect(within(edit).getByTestId('provider-icon-state')).toHaveTextContent('По ручной ссылке');
    await user.clear(link);
    expect(within(edit).getByText('Пусто — панель найдёт иконку на сайте сама.')).toBeInTheDocument();
    await user.click(within(edit).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockProviders.items.find((p) => p.name === '4VPS')?.iconUrl).toBeNull();
  });

  it('«Изменить» у провайдера с найденной иконкой показывает адрес источника, без правок режим не меняется', async () => {
    renderPage(ProvidersPage, '/billing/providers');
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
    renderPage(ProvidersPage, '/billing/providers');
    await screen.findByRole('list', { name: 'Провайдеры' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Добавить провайдера' }));
    const dialog = await screen.findByRole('dialog', { name: 'Новый провайдер' });
    await user.type(within(dialog).getByLabelText('Название'), 'Rawi');
    await user.type(within(dialog).getByLabelText('Сайт'), 'rawi.host');
    await waitFor(() =>
      expect(within(dialog).getByTestId('provider-icon-state')).toHaveTextContent(
        'На сайте нет, нашли в кэше Google',
      ),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Добавить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const card = screen.getByTestId('provider-card');
    expect(await within(card).findByText(/Иконка из кэша Google/, {}, { timeout: 4000 })).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Изменить' }));
    const edit = await screen.findByRole('dialog', { name: 'Изменить провайдера' });
    expect(within(edit).getByTestId('provider-icon-state')).toHaveTextContent('Из кэша Google');
    expect(within(edit).getByText(/взята из кэша Google/)).toBeInTheDocument();
  });

  it('пустой справочник: подсказка и кнопка добавления', async () => {
    mockProviders.items = [];
    renderPage(ProvidersPage, '/billing/providers');
    expect(await screen.findByText('Провайдеров пока нет')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Добавить первого провайдера' })).toBeInTheDocument();
  });

  it('справочник Remnawave: ноды провайдера открывают окно ноды поверх страницы', async () => {
    const node = {
      uuid: '0192f200-0000-7000-8000-000000000001',
      name: 'de-fra-01',
      address: '203.0.113.7',
      countryCode: 'DE',
      isConnected: true,
      isDisabled: false,
      isConnecting: false,
      lastStatusMessage: null,
      usersOnline: 12,
      trafficUsedBytes: 0,
      trafficLimitBytes: null,
    };
    const provider = {
      id: '0192c000-2222-7000-8000-000000000001',
      name: 'Aéza',
      siteUrl: 'https://aeza.net',
      siteHost: 'aeza.net',
      hasIcon: false,
      iconUrl: null,
      iconSourceUrl: null,
      iconPending: false,
      iconVersion: 1,
      note: null,
      serversCount: 1,
      createdAt: '2026-09-12T10:00:00.000Z',
      updatedAt: '2026-09-12T10:00:00.000Z',
    };
    server.use(
      http.get('/api/nodes/providers/catalog', () => HttpResponse.json({ items: [provider] })),
      http.get('/api/nodes/providers/catalog/:id/servers', () =>
        HttpResponse.json([{ id: node.uuid, name: node.name }]),
      ),
      http.get('/api/nodes/status', () =>
        HttpResponse.json({
          connected: true,
          domain: 'panel.example.com',
          checkedAt: new Date().toISOString(),
          error: null,
          stats: null,
          nodes: [node],
          cert: null,
        }),
      ),
      http.get('/api/nodes/metrics', () =>
        HttpResponse.json({
          panel: 'panel.example.com',
          history: [],
          traffic: null,
          trafficError: null,
          collectedSince: null,
        }),
      ),
      http.get('/api/nodes/:uuid/preferences', () =>
        HttpResponse.json({
          channelMbps: null,
          note: '',
          cpuWarningPercent: null,
          memoryWarningPercent: null,
        }),
      ),
    );
    const Remote = () => (
      <ProvidersSourceContext.Provider value="/nodes/providers/catalog">
        <ProvidersPage />
      </ProvidersSourceContext.Provider>
    );
    renderPage(Remote, '/billing/providers');
    const card = await screen.findByTestId('provider-card');
    expect(within(card).getByText('Ноды')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(await within(card).findByRole('button', { name: /de-fra-01/ }));
    expect(await screen.findByRole('dialog', { name: node.name })).toBeInTheDocument();
  });
});
