import { type RemnawaveNode, scenarioSchema } from '@nodeservice/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockState } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { ScenarioEditor } from './scenario-editor';

const initial = scenarioSchema.parse({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Проверка',
  trigger: 'offline',
  actions: ['check_tcp', 'record_event'],
});
const node = (uuid: string, name: string, address: string): RemnawaveNode => ({
  uuid,
  name,
  address,
  countryCode: null,
  isConnected: true,
  isDisabled: false,
  isConnecting: false,
  lastStatusMessage: null,
  usersOnline: 3,
  trafficUsedBytes: null,
  trafficLimitBytes: null,
});
const NODES = [
  node('a1111111-1111-4111-8111-111111111111', 'Германия - 1', '10.0.0.1'),
  node('b2222222-2222-4222-8222-222222222222', 'Турция - 1', '10.0.0.2'),
];
let saved: typeof initial | null = null;
const onDelete = vi.fn();
function Harness({ withDelete = false }: { withDelete?: boolean }) {
  const [draft, setDraft] = useState<typeof initial | null>(initial);
  return (
    draft && (
      <ScenarioEditor
        draft={draft}
        setDraft={setDraft}
        busy={false}
        onSave={() => {
          saved = draft;
        }}
        onClose={() => {}}
        onDelete={withDelete ? onDelete : undefined}
        error={null}
      />
    )
  );
}
const step = (title: string) => screen.getByRole('switch', { name: `Шаг «${title}»` });
const reading = () => screen.getByText(/Повтор не раньше чем через/);

beforeEach(() => {
  resetMockState({ authenticated: true });
  saved = null;
  onDelete.mockReset();
  server.use(
    http.get('*/api/scenarios/hosts', () => HttpResponse.json({ hosts: [] })),
    http.get('*/api/nodes/status', () =>
      HttpResponse.json({
        connected: true,
        domain: 'panel.example',
        checkedAt: null,
        error: null,
        stats: null,
        nodes: NODES,
        cert: null,
      }),
    ),
  );
});

describe('Редактор сценария «Если → то»', () => {
  it('шаги включаются переключателем и встают по порядку; Telegram всегда последний', async () => {
    const user = userEvent.setup();
    renderPage(() => <Harness />, '/scenarios');
    await screen.findByRole('dialog');
    expect(step('Проверить TCP')).toHaveAttribute('aria-checked', 'true');
    await user.click(step('Уведомить в Telegram'));
    await user.click(step('Скрыть Host'));
    expect(step('Скрыть Host')).toHaveAttribute('aria-checked', 'true');
    expect(reading()).toHaveTextContent(
      '1) проверить TCP, 2) записать событие, 3) скрыть Host, 4) уведомить в Telegram',
    );
    await user.click(step('Проверить TCP'));
    expect(reading()).toHaveTextContent('1) записать событие, 2) скрыть Host, 3) уведомить в Telegram');
    // Переставлять можно только включённые шаги, Telegram — никогда.
    expect(screen.getByRole('button', { name: 'Переставить шаг «Записать событие»' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Переставить шаг «Проверить TCP»' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Переставить шаг «Уведомить/ })).toBeNull();
    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('время можно стереть и ввести заново; причина недоступного сохранения — словами', async () => {
    const user = userEvent.setup();
    renderPage(() => <Harness />, '/scenarios');
    await screen.findByRole('dialog');
    const hold = screen.getByRole('textbox', { name: 'Подтверждение, минут' });
    const save = screen.getByRole('button', { name: 'Сохранить сценарий' });
    await user.clear(hold);
    expect(hold).toHaveValue('');
    expect(save).toBeDisabled();
    expect(screen.getByText('Время — от 1 до 60 мин')).toBeVisible();
    await user.type(hold, '0');
    expect(save).toBeDisabled();
    await user.clear(hold);
    await user.type(hold, '2');
    expect(save).toBeEnabled();
    expect(reading()).toHaveTextContent('держится 2 мин');
    await user.click(save);
    expect(saved?.holdMinutes).toBe(2);
  });

  it('условия: до трёх, «и/или», пояснения; без Telegram — предупреждение и ссылка на настройки', async () => {
    const user = userEvent.setup();
    renderPage(() => <Harness />, '/scenarios');
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Условие' }));
    await user.click(screen.getByRole('button', { name: 'Условие' }));
    expect(screen.queryByRole('button', { name: 'Условие' })).toBeNull();
    expect(screen.getByText(/Check-Host подтвердил недоступность/)).toBeVisible();
    // Между условиями одна и та же связка: менять можно на любой из них.
    expect(screen.getAllByRole('combobox', { name: 'Как сочетать условия' })).toHaveLength(2);
    await user.click(screen.getAllByRole('combobox', { name: 'Как сочетать условия' })[1] as HTMLElement);
    await user.click(await screen.findByRole('option', { name: 'или — хватит любого' }));
    expect(reading()).toHaveTextContent(
      'нода потеряла связь или подтверждено падение онлайна или TCP недоступен',
    );
    await user.click(screen.getByRole('button', { name: 'Удалить условие 2' }));
    expect(reading()).toHaveTextContent('нода потеряла связь или TCP недоступен');
    await user.click(step('Уведомить в Telegram'));
    expect(await screen.findByText(/Сообщение не придёт: Telegram не подключён/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Настройки уведомлений' })).toHaveAttribute(
      'href',
      '/settings/notifications',
    );
  });

  it('выбранные ноды: без выбора сохранить нельзя, «Выбрать все» и «Очистить», счёт и имена в пересказе', async () => {
    const user = userEvent.setup();
    renderPage(() => <Harness />, '/scenarios');
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: /любой ноде/ }));
    await user.click(screen.getByRole('radio', { name: 'Выбранные' }));
    let list = await screen.findByRole('group', { name: 'Ноды сценария' });
    expect(screen.getByText('Выбрано 0 из 2')).toBeVisible();
    // Окошко выбора закрывается своим Esc, окно сценария остаётся.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Ноды сценария' })).toBeNull();
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Сохранить сценарий' })).toBeDisabled();
    expect(screen.getByText('Выберите ноды')).toBeVisible();
    expect(reading()).toHaveTextContent('(ноды не выбраны)');
    await user.click(screen.getByRole('button', { name: /выберите ноды/ }));
    list = await screen.findByRole('group', { name: 'Ноды сценария' });
    await user.click(within(list).getByRole('checkbox', { name: 'Турция - 1' }));
    expect(screen.getByText('Выбрано 1 из 2')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Выбрать все' }));
    expect(screen.getByText('Выбрано 2 из 2')).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: /2 выбранных нодах/ })).toBeVisible();
    expect(reading()).toHaveTextContent('на нодах «Германия - 1» и «Турция - 1»');
    expect(screen.getByRole('button', { name: 'Сохранить сценарий' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: /2 выбранных нодах/ }));
    list = await screen.findByRole('group', { name: 'Ноды сценария' });
    await user.click(screen.getByRole('button', { name: 'Очистить' }));
    expect(screen.getByText('Выбрано 0 из 2')).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: 'Найти ноду' }), 'герм');
    expect(within(list).getAllByRole('checkbox')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Выбрать все' }));
    await user.keyboard('{Escape}');
    expect(reading()).toHaveTextContent('на ноде «Германия - 1»');
  });

  it('пример сообщения Telegram — теми же строками, что отправит сервер', async () => {
    const user = userEvent.setup();
    renderPage(() => <Harness />, '/scenarios');
    await screen.findByRole('dialog');
    await user.click(step('Уведомить в Telegram'));
    const preview = (await screen.findByText(/🟡 Сценарий: Проверка/)).parentElement;
    if (!preview) throw Error('Нет примера сообщения');
    expect(preview).toHaveTextContent('Нода: Германия - 1');
    expect(preview).toHaveTextContent('Условие: Нода потеряла связь');
    expect(preview).toHaveTextContent('Результат: TCP недоступен; Записано в событие «Нода не на связи»');
  });

  it('нет права «Изменение Host» — предупреждение прямо в шаге с Host', async () => {
    server.use(
      http.get('*/api/nodes/permissions', () =>
        HttpResponse.json({
          items: [
            { scope: 'hosts:list', label: 'Чтение Host', why: '', state: 'granted', checkedAt: null },
            { scope: 'hosts:update', label: 'Изменение Host', why: '', state: 'denied', checkedAt: null },
          ],
        }),
      ),
    );
    const user = userEvent.setup();
    renderPage(() => <Harness />, '/scenarios');
    await screen.findByRole('dialog');
    expect(screen.queryByText(/нет права «Изменение Host»/)).toBeNull();
    await user.click(step('Изменить имя Host'));
    expect(await screen.findByText(/нет права «Изменение Host» — Remnawave отказала/)).toBeVisible();
  });

  it('удаление — только после подтверждения', async () => {
    const user = userEvent.setup();
    renderPage(() => <Harness withDelete />, '/scenarios');
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Удалить' }));
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: 'Да, удалить' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
