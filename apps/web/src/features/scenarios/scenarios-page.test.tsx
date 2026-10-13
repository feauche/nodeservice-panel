import { scenarioSchema } from '@nodeservice/shared';
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
const runs = [
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
];

beforeEach(() => {
  resetMockState({ authenticated: true });
  server.use(
    http.get('*/api/scenarios', () => HttpResponse.json({ items: [crit, quiet] })),
    http.get('*/api/scenarios/runs', () => HttpResponse.json({ items: runs })),
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
});

describe('Сценарии: список и журнал срабатываний (список C, журнал B)', () => {
  it('строка сценария: условие фразой с нодой по имени, шаги по порядку, итог последнего срабатывания', async () => {
    renderPage(() => <ScenariosPage />, '/scenarios');
    const row = await screen.findByRole('button', { name: `Сценарий «${crit.name}»` });
    expect(row).toHaveTextContent('Если нода потеряла связь держится 1 мин на ноде «Не используется»');
    expect(row).toHaveTextContent('1Проверить TCP');
    expect(row).toHaveTextContent('4Уведомить в Telegram');
    expect(row).toHaveTextContent('Не используется — Host вернули');
    expect(row).toHaveTextContent('срабатываний за сутки: 2');
    const other = screen.getByRole('button', { name: `Сценарий «${quiet.name}»` });
    expect(other).toHaveTextContent('Ещё не срабатывал');
    expect(other).toHaveTextContent('Выключен — не срабатывает');
  });

  it('журнал: срабатывание целиком — итог плашкой, шаги с номерами, событие ссылкой, возврат Host внутри', async () => {
    renderPage(() => <ScenariosPage />, '/scenarios');
    const journal = await screen.findByRole('region', { name: 'Журнал срабатываний' });
    const [fresh, legacy] = within(journal).getAllByRole('article');
    expect(within(journal).getAllByRole('article')).toHaveLength(2);
    expect(fresh).toHaveTextContent('Выполнено');
    expect(fresh).toHaveTextContent('«Не используется» — нода потеряла связь');
    // Сценариев два — в записи подписано, какой сработал.
    expect(fresh).toHaveTextContent('Критическое падение онлайна · держалось 1 мин');
    expect(fresh).toHaveTextContent('Проверить TCP — доступен · из РФ 3 из 3, из других стран 3 из 3');
    expect(fresh).toHaveTextContent('Изменить имя Host — изменено · «LTE #7» → «LTE #7 ⚠️»');
    expect(fresh).toHaveTextContent('Уведомить в Telegram — отправлено');
    expect(fresh).toHaveTextContent(/Вернуть Host · \d\d:\d\d — вернули · «LTE #7»/);
    expect(within(fresh).getByRole('link', { name: '«Нода не на связи»' })).toHaveAttribute(
      'href',
      '/incidents/inc-1',
    );
    // Старая запись: без номеров, ошибка шага — красной плашкой.
    expect(legacy).toHaveTextContent('Шаг не выполнен');
    expect(legacy).toHaveTextContent('Remnawave ответила «доступ запрещён»');
  });

  it('«Этот сценарий» показывает только срабатывания выбранного', async () => {
    const user = userEvent.setup();
    renderPage(() => <ScenariosPage />, '/scenarios');
    await screen.findByRole('region', { name: 'Журнал срабатываний' });
    await user.click(screen.getByRole('button', { name: `Сценарий «${quiet.name}»` }));
    await user.click(screen.getByRole('radio', { name: 'Этот сценарий' }));
    expect(await screen.findByText(`«${quiet.name}» ещё не срабатывал.`)).toBeVisible();
    await user.click(screen.getByRole('button', { name: `Сценарий «${crit.name}»` }));
    const journal = await screen.findByRole('region', { name: 'Журнал срабатываний' });
    expect(within(journal).getAllByRole('article')).toHaveLength(2);
    // В «Этот сценарий» имя сценария не повторяется.
    expect(within(journal).getAllByRole('article')[0]).not.toHaveTextContent('Критическое падение онлайна ·');
  });

  it('Host изменён и ещё не вернули — плашка «Host изменён» и строка «Вернуть Host — ждёт»', async () => {
    server.use(
      http.get('*/api/scenarios/runs', () => HttpResponse.json({ items: runs.filter((r) => r.id === 'r1') })),
      http.get('*/api/scenarios', () =>
        HttpResponse.json({ items: [{ ...crit, autoRestore: true }, quiet] }),
      ),
    );
    renderPage(() => <ScenariosPage />, '/scenarios');
    const [run] = within(await screen.findByRole('region', { name: 'Журнал срабатываний' })).getAllByRole(
      'article',
    );
    expect(run).toHaveTextContent('Host изменён');
    expect(run).toHaveTextContent('Вернуть Host — ждёт · вернётся после восстановления ноды');
  });

  it('шаг не вышел: красный крестик и «не вышло», следующие — «не выполнялся»', async () => {
    server.use(
      http.get('*/api/scenarios/runs', () =>
        HttpResponse.json({
          items: [
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
          ],
        }),
      ),
    );
    renderPage(() => <ScenariosPage />, '/scenarios');
    const [run] = within(await screen.findByRole('region', { name: 'Журнал срабатываний' })).getAllByRole(
      'article',
    );
    expect(run).toHaveTextContent('Шаг не выполнен');
    expect(run).toHaveTextContent('Изменить имя Host — не вышло · у ключа нет права менять Host');
    expect(run).toHaveTextContent('Записать событие — не выполнялся · шаг 1 не вышел');
    expect(await screen.findByRole('button', { name: `Сценарий «${crit.name}»` })).toHaveTextContent(
      'Не используется — шаг 1 не выполнен',
    );
  });

  it('переключатель включает сценарий прямо в списке, «Настроить» открывает окно', async () => {
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
    await user.click(screen.getByRole('button', { name: `Настроить сценарий «${crit.name}»` }));
    expect(await screen.findByRole('dialog')).toBeVisible();
  });
});
