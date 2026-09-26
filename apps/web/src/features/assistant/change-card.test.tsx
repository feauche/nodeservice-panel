import type { AssistantChange } from '@nodeservice/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { Toaster } from '@/components/ui/sonner';
import { toast } from '@/lib/notify';
import { mockAssistant } from '@/test/msw/assistant-mock';
import { mockAudit } from '@/test/msw/audit-mock';
import { resetMockState } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { ChangeCard } from './change-card';

// Тосты рисует Toaster, а ему (и next-themes) нужен matchMedia, которого в jsdom нет.
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

let seq = 0;
const NOW = () => new Date().toISOString();

/** Изменение на «сервере»: кладём в мок и возвращаем предложение, как его присылает чат. */
function seed(over: Partial<AssistantChange> = {}, outcome?: 'stale' | 'failed') {
  seq += 1;
  const change: AssistantChange = {
    id: `0192f100-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    operation: 'server.provider',
    title: 'Сменить провайдера',
    level: 'T1',
    target: { type: 'server', id: null, label: 'de-fra-01' },
    reason: 'В панели указан Hetzner, а вы сказали, что сервер у Aéza.',
    rows: [{ label: 'Провайдер', before: 'Hetzner', after: 'Aéza' }],
    consequence: 'Провайдер только помечает сервер и на его работу не влияет.',
    reversible: true,
    status: 'proposed',
    note: null,
    conversationId: null,
    createdAt: NOW(),
    decidedAt: null,
    decidedBy: null,
    expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    ...over,
  };
  mockAssistant.changes[change.id] = change;
  if (outcome) mockAssistant.applyOutcome[change.id] = outcome;
  return change;
}

function open(change: AssistantChange) {
  const Page = () => (
    <>
      <ChangeCard
        proposal={{
          kind: 'change',
          changeId: change.id,
          operation: change.operation,
          title: change.title,
          level: change.level,
        }}
      />
      <Toaster />
    </>
  );
  return renderPage(Page, '/assistant');
}

const card = () => screen.findByTestId('change-card');

describe('ChangeCard (J5, A1)', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    toast.dismiss();
  });

  it('предложено: заголовок, уровень, цель, причина, таблица «Было / Станет», последствие и две кнопки', async () => {
    open(seed());
    const c = await card();
    await within(c).findByText('Ждёт подтверждения');
    expect(c).toHaveAttribute('data-status', 'proposed');
    expect(within(c).getByText('Сменить провайдера')).toBeInTheDocument();
    expect(within(c).getByText('T1')).toBeInTheDocument();
    expect(within(c).getByText('de-fra-01')).toBeInTheDocument();
    expect(within(c).getByText(/В панели указан Hetzner/)).toBeInTheDocument();
    for (const h of ['Что', 'Было', 'Станет'])
      expect(within(c).getByRole('columnheader', { name: h })).toBeInTheDocument();
    const row = within(c).getByRole('row', { name: /Провайдер/ });
    expect(within(row).getByRole('rowheader', { name: 'Провайдер' })).toBeInTheDocument();
    expect(within(row).getByText('Hetzner')).toBeInTheDocument();
    expect(within(row).getByText('Aéza')).toBeInTheDocument();
    expect(
      within(c)
        .getByText(/Что будет:/)
        .closest('p'),
    ).toHaveTextContent('на его работу не влияет');
    expect(within(c).getByRole('button', { name: 'Применить' })).toBeEnabled();
    expect(within(c).getByRole('button', { name: 'Отклонить' })).toBeEnabled();
    expect(within(c).queryByRole('button', { name: 'Отменить изменение' })).not.toBeInTheDocument();
  });

  it('T2: уровень и пометка «Нужно ваше подтверждение»', async () => {
    open(
      seed({
        operation: 'incident.resolve',
        title: 'Закрыть инцидент',
        level: 'T2',
        target: { type: 'incident', id: null, label: 'Нода остановлена: nl-exit-2' },
        rows: [{ label: 'Статус', before: 'Открыт', after: 'Закрыт вручную' }],
        consequence: 'Если проблема осталась, панель заведёт новый инцидент. Закрытие кнопкой не отменяется.',
        reversible: false,
      }),
    );
    const c = await card();
    expect(await within(c).findByText('Нужно ваше подтверждение')).toBeInTheDocument();
    expect(within(c).getByText('T2')).toBeInTheDocument();
    expect(within(c).getByText('Нода остановлена: nl-exit-2')).toBeInTheDocument();
  });

  it('списки: добавленное и убранное показываются отдельными плитками, пустое — словом «пусто»', async () => {
    open(
      seed({
        operation: 'server.tags',
        title: 'Изменить теги',
        rows: [
          {
            label: 'Теги',
            before: 'prod, de, test',
            after: 'prod, de, vip',
            added: ['vip'],
            removed: ['test'],
          },
          { label: 'Ожидаемые порты', before: '—', after: '22, 443', added: ['22', '443'] },
        ],
      }),
    );
    const c = await card();
    const tags = await within(c).findByRole('row', { name: /Теги/ });
    expect(within(tags).getByText('test')).toHaveClass('line-through');
    expect(within(tags).getByText('vip')).toHaveClass('font-semibold');
    expect(within(tags).getAllByText('prod')).toHaveLength(2);
    const ports = within(c).getByRole('row', { name: /Ожидаемые порты/ });
    expect(within(ports).getByText('пусто')).toBeInTheDocument();
    expect(within(ports).getByText('443')).toBeInTheDocument();
  });

  it('пустое значение простой строки называется «не задано»', async () => {
    open(seed({ rows: [{ label: 'Заметка', before: '—', after: 'Оплачивает Lumax' }] }));
    const c = await card();
    expect(await within(c).findByText('не задано')).toBeInTheDocument();
  });

  it('«Применить»: применено, кто и когда, итог проверки и кнопка «Отменить изменение»; в Журнале запись', async () => {
    const change = seed();
    open(change);
    const c = await card();
    const user = userEvent.setup();
    await user.click(await within(c).findByRole('button', { name: 'Применить' }));
    await within(c).findByText('Применено');
    expect(c).toHaveAttribute('data-status', 'applied');
    expect(within(c).getByText(/Применил admin, только что\./)).toHaveTextContent(
      'Проверено: Провайдер: Aéza.',
    );
    expect(within(c).queryByRole('button', { name: 'Применить' })).not.toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: 'Отклонить' })).not.toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Отменить изменение' })).toBeInTheDocument();
    expect(await screen.findByText('Изменение применено.')).toBeInTheDocument();
    expect(mockAudit.entries[0]).toMatchObject({
      action: 'assistant.change.applied',
      targetDisplay: 'de-fra-01',
    });
  });

  it('«Отменить изменение»: возвращено прежнее, кнопок больше нет', async () => {
    const change = seed({
      status: 'applied',
      decidedBy: 'admin',
      decidedAt: NOW(),
      note: 'Проверено: Провайдер: Aéza.',
    });
    open(change);
    const c = await card();
    const user = userEvent.setup();
    await user.click(await within(c).findByRole('button', { name: 'Отменить изменение' }));
    await within(c).findByText('Отменено');
    expect(c).toHaveAttribute('data-status', 'reverted');
    expect(within(c).getByText(/Отменил admin, только что\./)).toHaveTextContent(
      'Возвращено прежнее значение: Провайдер: Hetzner.',
    );
    expect(within(c).queryByRole('button')).not.toBeInTheDocument();
    expect(await screen.findByText('Изменение отменено.')).toBeInTheDocument();
    expect(mockAudit.entries[0]?.action).toBe('assistant.change.reverted');
  });

  it('«Отклонить»: отклонено, ничего не менялось', async () => {
    open(seed());
    const c = await card();
    const user = userEvent.setup();
    await user.click(await within(c).findByRole('button', { name: 'Отклонить' }));
    await within(c).findByText('Отклонено');
    expect(within(c).getByText(/Отклонил admin, только что\. Ничего не менялось\./)).toBeInTheDocument();
    expect(within(c).queryByRole('button')).not.toBeInTheDocument();
    expect(await screen.findByText('Предложение отклонено.')).toBeInTheDocument();
  });

  it('необратимое изменение (закрытие инцидента) после применения без кнопки отмены', async () => {
    open(
      seed({
        operation: 'incident.resolve',
        title: 'Закрыть инцидент',
        level: 'T2',
        target: { type: 'incident', id: null, label: 'Нода остановлена' },
        rows: [{ label: 'Статус', before: 'Открыт', after: 'Закрыт вручную' }],
        reversible: false,
      }),
    );
    const c = await card();
    const user = userEvent.setup();
    await user.click(await within(c).findByRole('button', { name: 'Применить' }));
    await within(c).findByText('Применено');
    expect(within(c).queryByRole('button', { name: 'Отменить изменение' })).not.toBeInTheDocument();
  });

  it('состояние изменилось после предложения: ничего не применено, показано, что сейчас, и что делать', async () => {
    const change = seed({}, 'stale');
    open(change);
    const c = await card();
    const user = userEvent.setup();
    await user.click(await within(c).findByRole('button', { name: 'Применить' }));
    await within(c).findByText('Состояние изменилось');
    expect(c).toHaveAttribute('data-status', 'stale');
    expect(within(c).getByText(/Сейчас: Заметка: Проверка связи\./)).toBeInTheDocument();
    expect(within(c).getByText(/Попросите Джарвиса предложить заново/)).toBeInTheDocument();
    expect(within(c).queryByRole('button')).not.toBeInTheDocument();
    expect(await screen.findByText('Изменение не применено: подробности в карточке.')).toBeInTheDocument();
    expect(mockAudit.entries[0]).toMatchObject({ action: 'assistant.change.failed', result: 'failed' });
  });

  it('ошибка при применении: «Ошибка» и текст причины', async () => {
    open(seed({}, 'failed'));
    const c = await card();
    const user = userEvent.setup();
    await user.click(await within(c).findByRole('button', { name: 'Применить' }));
    await within(c).findByText('Ошибка');
    expect(within(c).getByText(/Название «ru-entry-9» уже занято/)).toBeInTheDocument();
    expect(within(c).queryByRole('button')).not.toBeInTheDocument();
  });

  it('устарело: не применили за сутки, кнопок нет', async () => {
    open(
      seed({
        status: 'expired',
        note: 'Предложение не применили за 24 ч: состояние могло измениться. Попросите Джарвиса предложить заново.',
      }),
    );
    const c = await card();
    await within(c).findByText('Устарело');
    expect(within(c).getByText(/не применили за 24 ч/)).toBeInTheDocument();
    expect(within(c).queryByRole('button')).not.toBeInTheDocument();
  });

  it('пока идёт применение: «Применяется», кнопка занята, «Отклонить» скрыта', async () => {
    const change = seed();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    server.use(
      http.post('/api/assistant/changes/:id/apply', async () => {
        await gate;
        return HttpResponse.json({
          ...change,
          status: 'applied',
          decidedBy: 'admin',
          decidedAt: NOW(),
          note: 'Проверено: Провайдер: Aéza.',
        });
      }),
    );
    open(change);
    const c = await card();
    const user = userEvent.setup();
    await user.click(await within(c).findByRole('button', { name: 'Применить' }));
    expect(await within(c).findByText('Применяется')).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Применяю…' })).toBeDisabled();
    expect(within(c).getByText('Проверяю результат после записи.')).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: 'Отклонить' })).not.toBeInTheDocument();
    release();
    await within(c).findByText('Применено');
  });

  it('409 (уже отклонено в другой вкладке): тост с текстом ошибки, карточка перечитывается', async () => {
    const change = seed();
    open(change);
    const c = await card();
    const user = userEvent.setup();
    await within(c).findByRole('button', { name: 'Применить' });
    mockAssistant.changes[change.id] = {
      ...change,
      status: 'rejected',
      decidedBy: 'admin',
      decidedAt: NOW(),
    };
    await user.click(within(c).getByRole('button', { name: 'Применить' }));
    expect(await screen.findByText(/уже в состоянии «rejected»/)).toBeInTheDocument();
    await waitFor(() => expect(c).toHaveAttribute('data-status', 'rejected'));
  });

  it('откат отказал (409): тост, карточка остаётся применённой', async () => {
    const change = seed({ status: 'applied', decidedBy: 'admin', decidedAt: NOW(), note: 'Проверено.' });
    server.use(
      http.post('/api/assistant/changes/:id/revert', () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Конфликт',
            status: 409,
            detail:
              'После применения значение уже менялось: откатывать нечего, чтобы не затереть чужую правку.',
          },
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    open(change);
    const c = await card();
    const user = userEvent.setup();
    await user.click(await within(c).findByRole('button', { name: 'Отменить изменение' }));
    expect(await screen.findByText(/откатывать нечего/)).toBeInTheDocument();
    expect(c).toHaveAttribute('data-status', 'applied');
  });

  it('состояние берётся с сервера, а не из сообщения: после перезагрузки карточка уже применена', async () => {
    const change = seed({
      status: 'applied',
      decidedBy: 'admin',
      decidedAt: NOW(),
      note: 'Проверено: Провайдер: Aéza.',
    });
    open(change);
    const c = await card();
    expect(await within(c).findByText('Применено')).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: 'Применить' })).not.toBeInTheDocument();
  });

  it('не загрузилось: сообщение и кнопка «Повторить»', async () => {
    const change = seed();
    let calls = 0;
    server.use(
      http.get('/api/assistant/changes/:id', () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ type: 'about:blank', title: 'Сбой', status: 500 }, { status: 500 })
          : HttpResponse.json(change);
      }),
    );
    open(change);
    const c = await card();
    expect(await within(c).findByText('Не удалось загрузить состояние изменения.')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(c).getByRole('button', { name: 'Повторить' }));
    expect(await within(c).findByRole('button', { name: 'Применить' })).toBeInTheDocument();
  });

  it('пока карточка грузится: скелетон и название из предложения', async () => {
    const change = seed();
    server.use(http.get('/api/assistant/changes/:id', async () => new Promise(() => {})));
    open(change);
    const c = await card();
    expect(c).toHaveAttribute('data-status', 'loading');
    expect(within(c).getByText('Сменить провайдера')).toBeInTheDocument();
    expect(c.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
});
