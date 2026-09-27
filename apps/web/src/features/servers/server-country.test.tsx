import { DEFAULT_SERVER_COUNTRY, type Server } from '@nodeservice/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { resetMockState } from '@/test/msw/handlers';
import { finishCountryDetection, MOCK_SSH, mockServers } from '@/test/msw/servers-mock';
import { renderPage } from '@/test/render';
import { countryTip, countryView } from './country-text';
import { CountryMark } from './server-marks';
import { ServerModalHost } from './server-modal-host';
import { useServerModalStore } from './server-modal-store';
import { ServersPage } from './servers-page';

function Harness() {
  const [tag, setTag] = useState<string | undefined>(undefined);
  return (
    <>
      <ServersPage tag={tag} onTag={setTag} />
      <ServerModalHost />
    </>
  );
}

const setCountry = (index: number, over: Partial<Server['country']>) => {
  const s = mockServers.items[index] as Server;
  s.country = { ...DEFAULT_SERVER_COUNTRY, ...over };
};
const NOW = () => new Date().toISOString();
const AUTO_OK = { code: 'PL', source: 'auto', status: 'ok', agree: 6, total: 7 } as const;

/** Окно сервера на вкладке «Подключение». */
async function openConnection() {
  renderPage(Harness, '/servers');
  const user = userEvent.setup();
  await user.click(await screen.findByText('de-fra-01'));
  const dialog = await screen.findByRole('dialog', { name: 'de-fra-01' });
  await user.click(within(dialog).getByRole('button', { name: 'Подключение' }));
  const field = await within(dialog).findByRole('combobox', { name: 'Страна' });
  return { user, dialog, field };
}

describe('поле «Страна» на вкладке «Подключение» (A1)', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    useServerModalStore.getState().close();
    mockServers.countryDelayMs = 60_000;
  });

  it('подпись, «Необязательно» и подсказка; в блоке «Хостинг» рядом с провайдером', async () => {
    setCountry(0, { checkedAt: NOW(), ...AUTO_OK });
    const { dialog } = await openConnection();
    const host = within(dialog).getByRole('heading', { name: 'Хостинг' }).closest('section') as HTMLElement;
    expect(within(host).getByRole('combobox', { name: 'Провайдер' })).toBeInTheDocument();
    expect(within(host).getByRole('combobox', { name: 'Страна' })).toBeInTheDocument();
    expect(within(host).getByText('Необязательно')).toBeInTheDocument();
    expect(
      within(host).getByText('К какой стране относится сервер: флаг на карточке и фильтр «Страны».'),
    ).toBeInTheDocument();
  });

  it('не задана: «Определять автоматически» и подсказка про определение по IP', async () => {
    setCountry(0, {});
    const { field, dialog } = await openConnection();
    expect(field).toHaveTextContent('Определять автоматически');
    expect(within(dialog).getByText('Определится по IP сервера после добавления.')).toBeInTheDocument();
  });

  it('идёт определение: спиннер, IP сервера и подсказка про ручной выбор', async () => {
    setCountry(0, { status: 'detecting' });
    const { field, dialog } = await openConnection();
    expect(field).toHaveTextContent('Определяю по IP 203.0.113.7…');
    expect(
      within(dialog).getByText('Обычно до минуты. Страну можно выбрать вручную, не дожидаясь.'),
    ).toBeInTheDocument();
  });

  it('определена автоматически: флаг, название, метка «авто», когда и сколько источников совпало', async () => {
    setCountry(0, { checkedAt: NOW(), ...AUTO_OK });
    const { field, dialog } = await openConnection();
    expect(field).toHaveTextContent('Польша');
    expect(field).toHaveTextContent('авто');
    await waitFor(() => expect(field.querySelector('img[data-code="PL"]')).not.toBeNull());
    expect(
      within(dialog).getByText(/Определена автоматически только что: совпали 6 из 7 источников\./),
    ).toBeInTheDocument();
  });

  it('выбрана вручную: без метки «авто», подсказка про первый пункт списка', async () => {
    const { field, dialog } = await openConnection();
    setCountry(0, { code: 'NL', source: 'manual', status: 'ok', checkedAt: NOW() });
    // страна читается при открытии окна: открываем заново с ручной страной
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Закрыть' }));
    expect(field).toBeDefined();
  });

  it('не удалось определить: «Не определена» и причина, повторить можно тем же пунктом', async () => {
    setCountry(0, { status: 'failed' });
    const { field, dialog } = await openConnection();
    expect(field).toHaveTextContent('Не определена');
    expect(
      within(dialog).getByText(
        'Не удалось определить: источники не ответили. Выберите страну вручную или повторите позже (пункт «Определять автоматически»).',
      ),
    ).toBeInTheDocument();
  });

  it('список: частые сверху, есть «Определять автоматически» с подписью «по IP сервера», нет «Добавить…»', async () => {
    setCountry(0, {});
    const { field, user } = await openConnection();
    await user.click(field);
    const list = await screen.findByRole('listbox', { name: 'Страна' });
    const options = within(list).getAllByRole('option');
    expect(options[0]).toHaveTextContent('Определять автоматически');
    expect(options[0]).toHaveTextContent('по IP сервера');
    expect(options.slice(1, 7).map((o) => o.getAttribute('aria-label'))).toEqual([
      'Россия',
      'Нидерланды',
      'Германия',
      'Финляндия',
      'Польша',
      'США',
    ]);
    expect(screen.getByText('Частые')).toBeInTheDocument();
    expect(screen.getByText('Все страны')).toBeInTheDocument();
    expect(screen.queryByText(/Добавить страну|Добавить провайдера/)).not.toBeInTheDocument();
    expect(screen.getByText('Всего: 249')).toBeInTheDocument();
  });

  it('поиск «пол» находит Польшу; по коду «nl» находит Нидерланды; при поиске заголовков и автопункта нет', async () => {
    const { field, user } = await openConnection();
    await user.click(field);
    const search = await screen.findByRole('searchbox');
    await user.type(search, 'пол');
    const names = screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'));
    expect(names).toContain('Польша');
    expect(names).not.toContain('Определять автоматически');
    expect(screen.queryByText('Частые')).not.toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'NL');
    expect(screen.getByRole('option', { name: 'Нидерланды' })).toBeInTheDocument();
  });

  it('первый пункт отправляет {mode:"auto"} даже без смены значения: определение запускается заново', async () => {
    setCountry(0, { checkedAt: NOW(), ...AUTO_OK });
    const { field, user, dialog } = await openConnection();
    await user.click(field);
    await user.click(await screen.findByRole('option', { name: 'Определять автоматически' }));
    expect(within(dialog).getByText('Определится по IP сервера после сохранения.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockServers.items[0]?.country.status).toBe('detecting'));
    expect(mockServers.items[0]?.country.source).toBe('auto');
  });

  it('ручной выбор отправляет {mode:"manual", code}: страна и режим «вручную» сохраняются', async () => {
    const { field, user, dialog } = await openConnection();
    await user.click(field);
    await user.click(await screen.findByRole('option', { name: 'Финляндия' }));
    expect(field).toHaveTextContent('Финляндия');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(mockServers.items[0]?.country).toMatchObject({ code: 'FI', source: 'manual', status: 'ok' }),
    );
    // После сохранения поле показывает то, что пришло с сервера: ручной режим
    await waitFor(() =>
      expect(within(dialog).getByText(/Выбрана вручную: автоопределение её не меняет\./)).toBeInTheDocument(),
    );
  });

  it('без выбора форма страну не отправляет: у сервера остаётся прежнее', async () => {
    setCountry(0, { checkedAt: NOW(), ...AUTO_OK });
    const { user, dialog } = await openConnection();
    const input = within(dialog).getByLabelText('Название');
    await user.clear(input);
    await user.type(input, 'de-fra-01b');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockServers.items[0]?.name).toBe('de-fra-01b'));
    expect(mockServers.items[0]?.country).toMatchObject({ code: 'PL', source: 'auto', status: 'ok' });
  });

  it('пока идёт определение, список серверов перечитывается сам и страна появляется без действий', async () => {
    setCountry(0, { status: 'detecting' });
    const { field } = await openConnection();
    expect(field).toHaveTextContent('Определяю по IP');
    // Сервер «доопределил» страну: список перечитывается сам (раз в 3 с), пользователь ничего не нажимает.
    setTimeout(() => finishCountryDetection((mockServers.items[0] as Server).id), 300);
    await waitFor(() => expect(field).toHaveTextContent('Польша'), { timeout: 8000 });
    expect(field).toHaveTextContent('авто');
  }, 12_000);
});

describe('окно «Добавить сервер»: поле «Страна» (B1)', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    useServerModalStore.getState().close();
    mockServers.countryDelayMs = 60_000;
  });

  async function openAdd() {
    renderPage(Harness, '/servers');
    await screen.findByText('de-fra-01');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Добавить сервер' }));
    const dialog = await screen.findByRole('dialog', { name: 'Добавить сервер' });
    return { user, dialog };
  }
  const fillAndSubmit = async (
    user: ReturnType<typeof userEvent.setup>,
    dialog: HTMLElement,
    name: string,
  ) => {
    await user.type(within(dialog).getByLabelText('Название'), name);
    await user.type(within(dialog).getByLabelText('IP или домен'), '198.51.100.99');
    await user.type(within(dialog).getByLabelText('Пароль'), MOCK_SSH.password);
    await user.click(within(dialog).getByRole('button', { name: 'Проверить и добавить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 3000 });
  };

  it('по умолчанию «Определять автоматически» с подсказкой; поле стоит под «Провайдером», необязательное', async () => {
    const { dialog } = await openAdd();
    const country = within(dialog).getByRole('combobox', { name: 'Страна' });
    expect(country).toHaveTextContent('Определять автоматически');
    expect(within(dialog).getByText('Необязательно')).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        'Если не выбрать, панель определит страну по IP сервера после добавления. Потом её можно поменять на вкладке «Подключение».',
      ),
    ).toBeInTheDocument();
    const provider = within(dialog).getByRole('combobox', { name: 'Провайдер' });
    expect(provider.compareDocumentPosition(country) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('автоматически (по умолчанию или явным выбором первого пункта): поле country не уходит, сервер получает определение', async () => {
    const { user, dialog } = await openAdd();
    await user.click(within(dialog).getByRole('combobox', { name: 'Страна' }));
    await user.click(await screen.findByRole('option', { name: 'Определять автоматически' }));
    await fillAndSubmit(user, dialog, 'fi-hel-05');
    const created = mockServers.items.find((s) => s.name === 'fi-hel-05');
    expect(created?.country).toMatchObject({ source: 'auto', status: 'detecting', code: null });
  });

  it('ручной выбор: уходит {mode:"manual", code}, определение не запускается', async () => {
    const { user, dialog } = await openAdd();
    await user.click(within(dialog).getByRole('combobox', { name: 'Страна' }));
    await user.click(await screen.findByRole('option', { name: 'Финляндия' }));
    expect(within(dialog).getByText('Выбрана вручную: автоопределение её не изменит.')).toBeInTheDocument();
    await fillAndSubmit(user, dialog, 'fi-hel-06');
    const created = mockServers.items.find((s) => s.name === 'fi-hel-06');
    expect(created?.country).toMatchObject({ code: 'FI', source: 'manual', status: 'ok' });
  });

  it('при закрытии окна выбор сбрасывается', async () => {
    const { user, dialog } = await openAdd();
    await user.click(within(dialog).getByRole('combobox', { name: 'Страна' }));
    await user.click(await screen.findByRole('option', { name: 'Польша' }));
    await user.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Добавить сервер' }));
    const again = await screen.findByRole('dialog', { name: 'Добавить сервер' });
    expect(within(again).getByRole('combobox', { name: 'Страна' })).toHaveTextContent(
      'Определять автоматически',
    );
  });
});

describe('плитка страны на карточке (C3, D1)', () => {
  const base = (over: Partial<Server['country']>): Server =>
    ({ country: { ...DEFAULT_SERVER_COUNTRY, ...over } }) as Server;
  const wrap = (s: Server) =>
    render(<TooltipProvider delayDuration={0}>{<CountryMark server={s} />}</TooltipProvider>);

  it('страны нет и определение не шло: плитки нет', () => {
    wrap(base({}));
    expect(screen.queryByTestId('country-mark')).not.toBeInTheDocument();
  });

  it('идёт определение без кода: плитка со спиннером и подсказкой', async () => {
    wrap(base({ status: 'detecting' }));
    const mark = screen.getByTestId('country-mark');
    expect(mark).toHaveAttribute('data-view', 'detecting');
    expect(mark).toHaveAccessibleName('Определяется по IP сервера…');
    expect(mark.querySelector('svg.animate-spin')).not.toBeNull();
  });

  it('не удалось определить: вопросительный знак и подсказка про ручной выбор', () => {
    wrap(base({ status: 'failed' }));
    expect(screen.getByTestId('country-mark')).toHaveAccessibleName(
      'Страну не удалось определить. Выберите вручную на вкладке «Подключение».',
    );
  });

  it('определена автоматически: флаг, подсказка «Польша. Определена автоматически: 6 из 7 источников. Проверено …»', async () => {
    wrap(base({ ...AUTO_OK, checkedAt: NOW() }));
    const mark = screen.getByTestId('country-mark');
    expect(mark).toHaveAttribute('data-view', 'auto');
    expect(mark).toHaveAccessibleName(
      'Польша. Определена автоматически: 6 из 7 источников. Проверено только что.',
    );
    await waitFor(() => expect(mark.querySelector('img[data-code="PL"]')).not.toBeNull());
  });

  it('выбрана вручную: «Нидерланды. Выбрана вручную.»', () => {
    wrap(base({ code: 'NL', source: 'manual', status: 'ok' }));
    expect(screen.getByTestId('country-mark')).toHaveAccessibleName('Нидерланды. Выбрана вручную.');
  });

  it('нажатие показывает подсказку (на телефоне нет наведения) и не открывает карточку', async () => {
    let opened = 0;
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: имитация клика по карточке
      <div onClick={() => (opened += 1)} onKeyDown={() => undefined}>
        <TooltipProvider delayDuration={0}>
          <CountryMark server={base({ code: 'NL', source: 'manual', status: 'ok' })} />
        </TooltipProvider>
      </div>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId('country-mark'));
    expect((await screen.findAllByText('Выбрана вручную.')).length).toBeGreaterThan(0);
    expect(opened).toBe(0);
  });

  it('состояния сводятся к пяти видам', () => {
    expect(countryView({ ...DEFAULT_SERVER_COUNTRY })).toBe('unset');
    expect(countryView({ ...DEFAULT_SERVER_COUNTRY, status: 'detecting' })).toBe('detecting');
    expect(countryView({ ...DEFAULT_SERVER_COUNTRY, status: 'failed' })).toBe('failed');
    expect(countryView({ ...DEFAULT_SERVER_COUNTRY, ...AUTO_OK })).toBe('auto');
    expect(countryView({ ...DEFAULT_SERVER_COUNTRY, code: 'NL', source: 'manual', status: 'ok' })).toBe(
      'manual',
    );
    expect(
      countryTip({ ...DEFAULT_SERVER_COUNTRY, code: 'PL', status: 'failed', note: 'Источники разошлись.' }),
    ).toEqual({
      name: 'Польша',
      text: 'Последняя проверка не удалась: Источники разошлись.',
    });
  });
});

describe('карточки на странице: флаг рядом со значком функций', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    useServerModalStore.getState().close();
  });

  it('у серверов со страной на карточке плитка, у сервера без страны её нет; высота карточек не меняется', async () => {
    setCountry(1, {});
    renderPage(Harness, '/servers');
    await screen.findByText('de-fra-01');
    const cards = screen.getAllByRole('article');
    expect(within(cards[0] as HTMLElement).getByTestId('country-mark')).toBeInTheDocument();
    expect(within(cards[1] as HTMLElement).queryByTestId('country-mark')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(cards[0]?.querySelector('[data-testid="country-mark"] img[data-code="PL"]')).not.toBeNull(),
    );
  });
});

describe('фильтр «Страны» (C0)', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    useServerModalStore.getState().close();
  });
  // Пока список открыт, страница под ним скрыта от читалок (модальное меню): смотрим карточки без учёта этого.
  const cardsShown = () =>
    screen
      .getAllByRole('article', { hidden: true })
      .map((a) => within(a).getByRole('heading', { hidden: true }).textContent);

  it('не показывается, пока ни у одного сервера нет страны', async () => {
    setCountry(0, {});
    setCountry(1, {});
    renderPage(Harness, '/servers');
    await screen.findByText('de-fra-01');
    expect(screen.queryByRole('button', { name: /Страны/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Теги/ })).toBeInTheDocument();
  });

  it('рядом с «Теги»: страны из серверов с числом, «Без страны», несколько значений, «Сбросить»', async () => {
    setCountry(1, {});
    renderPage(Harness, '/servers');
    await screen.findByText('de-fra-01');
    const tags = screen.getByRole('button', { name: /Теги/ });
    const trigger = screen.getByRole('button', { name: /Страны/ });
    expect(tags.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    const user = userEvent.setup();
    await user.click(trigger);
    const menu = await screen.findByRole('menu');
    const rows = within(menu).getAllByRole('menuitemcheckbox');
    expect(rows.map((r) => r.textContent)).toEqual(['Польша1', 'Без страны1']);
    expect(within(menu).getByText('Выбрано: 0')).toBeInTheDocument();

    await user.click(within(menu).getByRole('menuitemcheckbox', { name: /Польша/ }));
    // список остался открытым, карточки отфильтрованы, на кнопке число выбранных
    expect(cardsShown()).toEqual(['de-fra-01']);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(
      within(screen.getByRole('button', { name: /Страны/, hidden: true })).getByText('1'),
    ).toBeInTheDocument();

    await user.click(within(menu).getByRole('menuitemcheckbox', { name: /Без страны/ }));
    expect(cardsShown().sort()).toEqual(['de-fra-01', 'nl-ams-02']);
    expect(within(menu).getByText('Выбрано: 2')).toBeInTheDocument();

    await user.click(within(menu).getByRole('menuitemcheckbox', { name: /Польша/ }));
    expect(cardsShown()).toEqual(['nl-ams-02']);
    await user.click(within(menu).getByRole('button', { name: 'Сбросить' }));
    expect(cardsShown().sort()).toEqual(['de-fra-01', 'nl-ams-02']);
  });

  it('в списке только страны серверов и счётчики: две страны — две строки по одному серверу', async () => {
    renderPage(Harness, '/servers');
    await screen.findByText('de-fra-01');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Страны/ }));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitemcheckbox')
        .map((r) => r.textContent),
    ).toEqual(['Нидерланды1', 'Польша1']);
  });
});
