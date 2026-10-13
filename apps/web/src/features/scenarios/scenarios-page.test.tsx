import {
  journalPage,
  type ScenarioRun,
  scenarioJournalQuerySchema,
  scenarioOverview,
  scenarioSchema,
} from '@nodeservice/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockState } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { ScenariosPage } from './scenarios-page';

const NODE = 'a1111111-1111-4111-8111-111111111111';
const crit = scenarioSchema.parse({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Критическое падение онлайна',
  enabled: true,
  scope: 'selected',
  nodes: [NODE],
  trigger: 'offline',
  holdMinutes: 1,
  actions: ['check_tcp', 'record_event', 'rename_host', 'notify'],
  renameText: '⚠️',
});
const quiet = scenarioSchema.parse({
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Падение онлайна → Telegram',
  trigger: 'online_drop',
  actions: ['record_event', 'notify'],
});
const now = Date.now();
const base = { ruleId: crit.id, ruleName: crit.name, nodeUuid: NODE, nodeName: 'Не используется' };
const runs: ScenarioRun[] = [
  {
    ...base,
    id: 'r2',
    t: now - 60_000,
    kind: 'restore',
    title: 'Host вернули после восстановления ноды',
    steps: [
      {
        text: 'Host «LTE #7» возвращён после восстановления ноды',
        tone: 'ok',
        word: 'вернули',
        detail: '«LTE #7»',
      },
    ],
    failed: false,
  },
  {
    ...base,
    id: 'r1',
    t: now - 600_000,
    kind: 'run',
    title: 'Сработал: нода потеряла связь, 1 мин',
    condition: 'нода потеряла связь',
    holdMinutes: 1,
    steps: [
      {
        action: 'check_tcp',
        n: 1,
        tone: 'ok',
        word: 'доступен',
        detail: 'из РФ 3 из 3, из других стран 3 из 3',
        text: 'TCP доступен: из РФ 3 из 3, из других стран 3 из 3',
      },
      {
        action: 'record_event',
        n: 2,
        tone: 'info',
        word: 'записано',
        detail: 'в «Нода не на связи»',
        incidentId: 'inc-1',
        text: 'Записано в событие «Нода не на связи»',
      },
      {
        action: 'rename_host',
        n: 3,
        tone: 'change',
        word: 'изменено',
        detail: '«LTE #7» → «LTE #7 ⚠️»',
        text: 'Изменено имя Host: «LTE #7» → «LTE #7 ⚠️»',
      },
      { action: 'notify', n: 4, tone: 'info', word: 'отправлено', text: 'Уведомление в Telegram' },
    ],
    failed: false,
  },
  // Запись до 0.94.0: без номеров шагов и слов-итогов.
  {
    ...base,
    id: 'r0',
    t: now - 1_200_000,
    kind: 'run',
    title: 'Сработал',
    steps: [
      { text: 'TCP доступен', tone: 'ok' },
      { text: 'Событие сохранено', tone: 'info' },
      { text: 'Remnawave ответила «доступ запрещён»', tone: 'crit' },
    ],
    failed: true,
  },
] as ScenarioRun[];

/** Сервер в тестах — те же расчёты, что у настоящего: сводка и журнал порциями из срабатываний `list`. */
function serve(list: ScenarioRun[], rules = [crit, quiet]) {
  server.use(
    http.get('*/api/scenarios/overview', () =>
      HttpResponse.json(scenarioOverview(rules, list, 0, Date.now(), 'UTC')),
    ),
    http.get('*/api/scenarios/journal', ({ request }) =>
      HttpResponse.json(
        journalPage(
          list,
          scenarioJournalQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams)),
          Date.now(),
          'UTC',
        ),
      ),
    ),
  );
}

beforeEach(() => {
  resetMockState({ authenticated: true });
  server.use(
    http.get('*/api/scenarios', () => HttpResponse.json({ items: [crit, quiet] })),
    http.get('*/api/nodes/status', () =>
      HttpResponse.json({
        connected: true,
        domain: 'panel.example',
        checkedAt: null,
        error: null,
        stats: null,
        nodes: [
          {
            uuid: NODE,
            name: 'Не используется',
            address: '10.0.0.1',
            countryCode: null,
            isConnected: true,
            isDisabled: false,
            isConnecting: false,
            lastStatusMessage: null,
            usersOnline: 0,
            trafficUsedBytes: null,
            trafficLimitBytes: null,
          },
        ],
        cert: null,
      }),
    ),
  );
  serve(runs);
});

describe('Сценарии: плитки, строки, журнал и окно (витрина scenarios-2026-10b, страница A и окно A)', () => {
  it('плитки сверху; строка сценария — условие, шаги значками, последнее срабатывание, полоска с числом', async () => {
    renderPage(() => <ScenariosPage />, '/scenarios');
    const row = await screen.findByRole('button', { name: `Открыть сценарий «${crit.name}»` });
    expect(row).toHaveTextContent('нода потеряла связь · держится 1 мин · ноде «Не используется»');
    expect(
      within(row).getByRole('img', {
        name: /^Шаги: Проверить TCP, Записать событие, Изменить имя Host, Уведомить в Telegram$/,
      }),
    ).toBeVisible();
    expect(await within(row).findByText('Не используется')).toBeVisible();
    // За сутки два срабатывания, одно — с ошибкой шага.
    expect(row).toHaveTextContent('2 за сутки · 1 с замечанием');
    const other = screen.getByRole('button', { name: `Открыть сценарий «${quiet.name}»` });
    expect(other).toHaveTextContent('Выключен');
    expect(other).toHaveTextContent('выключен — не срабатывает');
    expect(screen.getByText('Включено').closest('section')).toHaveTextContent('1из 2');
    expect(screen.getByText('Срабатываний за сутки').closest('section')).toHaveTextContent('2');
  });

  it('журнал: по суткам с итогом дня, строка раскрывается до шагов — событие ссылкой, возврат Host внутри', async () => {
    const user = userEvent.setup();
    renderPage(() => <ScenariosPage />, '/scenarios');
    await user.click(await screen.findByRole('radio', { name: 'Журнал срабатываний' }));
    const day = await screen.findByRole('region', { name: /^Сегодня/ });
    expect(day).toHaveTextContent('2 срабатывания · 1 не вышло');
    const [fresh, legacy] = within(day).getAllByRole('button', { expanded: false });
    if (!fresh || !legacy) throw new Error('нет строк');
    // Сценариев два — в строке подписано, какой сработал; возврат Host — плашкой.
    expect(fresh).toHaveTextContent('Критическое падение онлайна');
    expect(fresh).toHaveTextContent(/Host вернули · \d\d:\d\d/);
    await user.click(fresh);
    expect(day).toHaveTextContent('Проверить TCP — доступен · из РФ 3 из 3, из других стран 3 из 3');
    expect(day).toHaveTextContent('Изменить имя Host — изменено · «LTE #7» → «LTE #7 ⚠️»');
    expect(day).toHaveTextContent(/Вернуть Host · \d\d:\d\d — вернули · «LTE #7»/);
    expect(within(day).getByRole('link', { name: '«Нода не на связи»' })).toHaveAttribute(
      'href',
      '/incidents/inc-1',
    );
    // Старая запись: без номеров, ошибка шага — «Шаг не выполнен».
    expect(legacy).toHaveTextContent('шаг не выполнен');
    expect(screen.getByText('Показано 2 из 2 · хранятся 30 дней')).toBeVisible();
  });

  it('окно сценария: вкладка «Срабатывания» — полоска и числа, отбор «Не вышло» оставляет только ошибку', async () => {
    const user = userEvent.setup();
    renderPage(() => <ScenariosPage />, '/scenarios');
    await user.click(await screen.findByRole('button', { name: `Открыть сценарий «${crit.name}»` }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('tab', { name: /Срабатывания/ }));
    expect(await within(dialog).findByText('Последние 20 срабатываний')).toBeVisible();
    expect(
      within(dialog).getByRole('img', { name: /Последние срабатывания: не вышло, выполнено/ }),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('radio', { name: /Не вышло/ }));
    expect(await within(dialog).findByText('Показано 1 из 1 · хранятся 30 дней')).toBeVisible();
  });

  it('Host изменён и ещё не вернули — плашка «Host ещё помечен», в шагах «Вернуть Host — ещё помечен»', async () => {
    serve(
      runs.filter((r) => r.id === 'r1'),
      [{ ...crit, autoRestore: true }, quiet],
    );
    const user = userEvent.setup();
    renderPage(() => <ScenariosPage />, '/scenarios');
    await user.click(await screen.findByRole('radio', { name: 'Журнал срабатываний' }));
    const row = await screen.findByRole('button', { expanded: false });
    expect(row).toHaveTextContent('Host ещё помечен');
    await user.click(row);
    expect(await screen.findByText(/нода не восстановилась — вернётся сам/)).toBeVisible();
  });

  it('шаг не вышел: в шагах «не вышло», следующие — «не выполнялся»; в строке сценария — итог', async () => {
    serve([
      {
        ...base,
        id: 'f1',
        t: now - 30_000,
        kind: 'run',
        title: 'Сработал: нода потеряла связь, 1 мин',
        condition: 'нода потеряла связь',
        holdMinutes: 1,
        failed: true,
        steps: [
          {
            action: 'rename_host',
            n: 1,
            tone: 'crit',
            failed: true,
            word: 'не вышло',
            detail: 'у ключа нет права менять Host',
            text: 'у ключа нет права менять Host',
          },
          {
            action: 'record_event',
            n: 2,
            tone: 'info',
            skipped: true,
            word: 'не выполнялся',
            detail: 'шаг 1 не вышел',
            text: '',
          },
        ],
      },
    ] as ScenarioRun[]);
    const user = userEvent.setup();
    renderPage(() => <ScenariosPage />, '/scenarios');
    await user.click(await screen.findByRole('radio', { name: 'Журнал срабатываний' }));
    await user.click(await screen.findByRole('button', { expanded: false }));
    const day = screen.getByRole('region', { name: /^Сегодня/ });
    expect(day).toHaveTextContent('Изменить имя Host — не вышло · у ключа нет права менять Host');
    expect(day).toHaveTextContent('Записать событие — не выполнялся · шаг 1 не вышел');
  });

  it('переключатель включает сценарий прямо в списке, нажатие на строку открывает окно', async () => {
    let saved: unknown = null;
    server.use(
      http.put('*/api/scenarios', async ({ request }) => {
        saved = await request.json();
        return HttpResponse.json(saved as object);
      }),
    );
    const user = userEvent.setup();
    renderPage(() => <ScenariosPage />, '/scenarios');
    await user.click(await screen.findByRole('switch', { name: `Сценарий «${quiet.name}» включён` }));
    expect(
      (saved as { items: Array<{ id: string; enabled: boolean }> }).items.find((r) => r.id === quiet.id)
        ?.enabled,
    ).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: `Открыть сценарий «${crit.name}»` }));
    expect(await screen.findByRole('dialog')).toBeVisible();
  });

  it('сценариев нет — три готовых, нажатие открывает окно нового сценария', async () => {
    server.use(http.get('*/api/scenarios', () => HttpResponse.json({ items: [] })));
    serve([], []);
    const user = userEvent.setup();
    renderPage(() => <ScenariosPage />, '/scenarios');
    await user.click(await screen.findByRole('button', { name: /Нода потеряла связь — скрыть Host/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('textbox', { name: 'Название' })).toHaveValue(
      'Нода потеряла связь — скрыть Host',
    );
  });
});
