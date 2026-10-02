import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { mockBilling } from '@/test/msw/billing-mock';
import { resetMockState } from '@/test/msw/handlers';
import { renderPage } from '@/test/render';
import { BillingPage, type BillingView } from './billing-page';

function Page() {
  const [view, setView] = useState<BillingView>('items');
  return <BillingPage view={view} onView={setView} />;
}

const cards = () => screen.getAllByTestId('billing-card');

describe('BillingPage', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
  });

  it('итоги за периоды и карточки по ближайшему сроку с маячком', async () => {
    renderPage(Page, '/servers/billing', ['/servers']);
    await waitFor(() => expect(cards().length).toBe(6));
    // Просроченная аренда — первой, с маячком «Просрочено».
    const first = cards()[0];
    if (!first) throw new Error('нет карточек');
    expect(within(first).getByText('Вход с белым IP')).toBeInTheDocument();
    expect(within(first).getByRole('img', { name: 'Просрочено' })).toBeInTheDocument();
    expect(within(first).getByText(/просрочено на 1 день/)).toBeInTheDocument();
    // Сертификат показывает, где развёрнут.
    const cert = cards().find((c) => within(c).queryByText('*.lumaxvds.org — certwarden'));
    expect(cert && within(cert).getByRole('button', { name: /de-fra-01/ })).toBeTruthy();
    expect(await screen.findByTestId('billing-stat-month')).toHaveTextContent(/₽/);
    // Фильтр по типу.
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: /Сертификат 1/ }));
    expect(cards()).toHaveLength(1);
  });

  it('«Продлить»: быстрая кнопка продлевает сразу, галочка снимается, отмена возвращает дату', async () => {
    renderPage(Page, '/servers/billing', ['/servers']);
    await waitFor(() => expect(cards().length).toBe(6));
    const user = userEvent.setup();
    const card = cards().find((c) => within(c).queryByText('de-fra-01 · VPS 2 ГБ'));
    if (!card) throw new Error('нет карточки');
    await user.click(within(card).getByRole('button', { name: 'Продлить' }));
    const dialog = await screen.findByRole('dialog');
    const before = within(dialog).getByTestId('extend-due').textContent;
    expect(within(dialog).getByRole('checkbox', { name: 'Учесть оплату в статистике' })).toBeChecked();
    // Период карточки — 30 дней, выделенная кнопка.
    await user.click(within(dialog).getByRole('button', { name: '30 дней' }));
    await waitFor(() => expect(within(dialog).getByTestId('extend-due').textContent).not.toBe(before));
    expect(within(dialog).getByRole('checkbox', { name: 'Учесть оплату в статистике' })).not.toBeChecked();
    expect(within(dialog).getByLabelText('Сумма оплаты')).toBeDisabled();
    expect(within(dialog).getByTestId('extend-log')).toHaveTextContent(/учтено €9.5/);
    const counted = mockBilling.payments[0];
    expect(counted?.counted).toBe(true);
    // Второй клик без галочки — только дата.
    await user.click(within(dialog).getByRole('button', { name: '1 день' }));
    await waitFor(() => expect(within(dialog).getByTestId('extend-log')).toHaveTextContent(/без суммы/));
    expect(mockBilling.payments[0]?.counted).toBe(false);
    // Отменить можно только последнее.
    expect(within(dialog).getAllByRole('button', { name: 'Отменить' })).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: 'Отменить' }));
    await waitFor(() => expect(within(dialog).getAllByRole('button', { name: 'Отменить' })).toHaveLength(1));
    expect(mockBilling.payments[0]?.id).toBe(counted?.id);
  });

  it('двойной клик по сроку записывает только одно продление', async () => {
    renderPage(Page, '/servers/billing', ['/servers']);
    await waitFor(() => expect(cards().length).toBe(6));
    const user = userEvent.setup();
    const card = cards().find((c) => within(c).queryByText('de-fra-01 · VPS 2 ГБ'));
    if (!card) throw new Error('нет карточки');
    await user.click(within(card).getByRole('button', { name: 'Продлить' }));
    const dialog = await screen.findByRole('dialog');
    const before = mockBilling.payments.length;
    await user.dblClick(within(dialog).getByRole('button', { name: '30 дней' }));
    await waitFor(() => expect(mockBilling.payments).toHaveLength(before + 1));
  });

  it('новая оплата: сервер — список с поиском и необязателен; сертификат на двух серверах сохраняется', async () => {
    renderPage(Page, '/servers/billing', ['/servers']);
    await waitFor(() => expect(cards().length).toBe(6));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Добавить оплату' }));
    let dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Название/), 'Без сервера');
    await user.type(within(dialog).getByLabelText(/Сумма/), '5');
    // «Сервер» — выпадающий список, по умолчанию «Без сервера», сохранить можно и так.
    expect(within(dialog).getByRole('combobox', { name: 'Сервер' })).toHaveTextContent('Без сервера');
    await user.click(within(dialog).getByRole('button', { name: 'Добавить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockBilling.items.find((i) => i.title === 'Без сервера')?.serverIds).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Добавить оплату' }));
    dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Название/), 'Новый VPS');
    await user.type(within(dialog).getByLabelText(/Сумма/), '5');
    await user.click(within(dialog).getByRole('radio', { name: 'Сертификат' }));
    expect(within(dialog).getByText('Где развёрнут')).toBeInTheDocument();
    for (const name of ['de-fra-01', 'nl-ams-02']) {
      await user.click(within(dialog).getByRole('combobox', { name: 'Где развёрнут: добавить сервер' }));
      await user.click(await screen.findByRole('option', { name }));
    }
    const picker = within(dialog).getByTestId('billing-servers');
    expect(within(picker).getByRole('button', { name: 'Убрать de-fra-01' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: '$' }));
    await user.click(within(dialog).getByRole('button', { name: 'год' }));
    await user.click(within(dialog).getByRole('button', { name: 'Добавить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const saved = mockBilling.items.find((i) => i.title === 'Новый VPS');
    expect(saved).toMatchObject({ kind: 'cert', currency: 'USD', periodUnit: 'year', amountMinor: 500 });
    expect(saved?.serverIds).toHaveLength(2);
  });

  it('статистика: столбцы по месяцам и разбивка по провайдерам; архив', async () => {
    renderPage(Page, '/servers/billing', ['/servers']);
    await waitFor(() => expect(cards().length).toBe(6));
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Статистика' }));
    // Прогноз: итоги вперёд, недели и месяцы; нажатие на оплату открывает «Продлить».
    expect(await screen.findByTestId('forecast-30')).toHaveTextContent(/≈/);
    expect(screen.getByTestId('forecast-months')).toBeInTheDocument();
    const weeks = screen.getByTestId('forecast-weeks');
    await user.click(within(weeks).getAllByRole('button')[0] as HTMLElement);
    expect(await screen.findByRole('dialog')).toHaveTextContent(/Продлить/);
    await user.click(screen.getByRole('button', { name: 'Готово' }));
    expect(await screen.findByTestId('billing-chart')).toBeInTheDocument();
    expect(await screen.findByTestId('billing-by-provider')).toHaveTextContent(/Aéza/);
    await user.click(screen.getByRole('radio', { name: 'Год' }));
    await waitFor(() => expect(screen.getByTestId('billing-by-provider')).toHaveTextContent(/Hetzner/));

    await user.click(screen.getByRole('radio', { name: /Оплаты/ }));
    await waitFor(() => expect(cards().length).toBe(6));
    const card = cards()[0];
    if (!card) throw new Error('нет карточки');
    await user.click(within(card).getByRole('button', { name: /Действия/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'В архив' }));
    await waitFor(() => expect(cards().length).toBe(5));
    await user.click(screen.getByRole('radio', { name: /Архив 1/ }));
    await waitFor(() => expect(cards().length).toBe(1));
    expect(within(cards()[0] as HTMLElement).queryByRole('button', { name: 'Продлить' })).toBeNull();
  });

  it('курс ЦБ: рядом время, когда панель его получила', async () => {
    const today = new Date();
    today.setHours(14, 0, 0, 0);
    mockBilling.rates.fetchedAt = today.toISOString();
    renderPage(Page, '/servers/billing', ['/servers']);
    const rates = await screen.findByTestId('billing-rates');
    expect(rates).toHaveTextContent('ЦБ: $ 81,5 ₽ · € 95,2 ₽ · Обновлено 14:00');
    // Подсказка называет дату курса, а не «сегодня»: дата курса считается по Москве.
    expect(rates).toHaveAttribute(
      'title',
      expect.stringMatching(/^Курс ЦБ РФ на \d+ [а-я]+\. Панель получает/),
    );
    expect(within(rates).getByText('Обновлено 14:00')).not.toHaveClass('text-warn');
    expect(rates).not.toHaveTextContent('ЦБ не отвечает');
  });

  it('курс ЦБ устарел (ЦБ не ответил панели): дата обновления выделена, в подсказке — почему', async () => {
    mockBilling.rates.date = '2026-09-20';
    mockBilling.rates.fetchedAt = new Date(2026, 8, 20, 9, 7).toISOString();
    renderPage(Page, '/servers/billing', ['/servers']);
    const rates = await screen.findByTestId('billing-rates');
    // Устаревание написано словами, а не только цветом.
    const updated = within(rates).getByText(/^Обновлено 20 сентября.* · ЦБ не отвечает$/);
    expect(updated).toHaveClass('text-warn');
    expect(rates).toHaveAttribute(
      'title',
      expect.stringMatching(/^ЦБ РФ не отвечает панели — показан последний известный курс, на 20 сентября/),
    );
    // В окне новой оплаты курс тоже не называется сегодняшним.
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Добавить оплату/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: '$' }));
    expect(within(dialog).getByText(/^Курс ЦБ на 20 сентября: 81,5 ₽$/)).toBeInTheDocument();
  });

  it('курса нет совсем: вместо пустоты — «курс не получен» с объяснением', async () => {
    mockBilling.rates = { USD: null, EUR: null, date: null, fetchedAt: null };
    renderPage(Page, '/servers/billing', ['/servers']);
    const rates = await screen.findByTestId('billing-rates');
    expect(rates).toHaveTextContent('ЦБ: курс не получен');
    expect(rates).toHaveAttribute('title', expect.stringMatching(/Оплаты в \$ и € пока не входят в итоги/));
  });
});
