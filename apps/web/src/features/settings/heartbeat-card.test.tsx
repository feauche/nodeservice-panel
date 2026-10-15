import type { HeartbeatView } from '@nodeservice/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockState } from '@/test/msw/handlers';
import { mockHeartbeat, mockHeartbeatBeat } from '@/test/msw/heartbeat-mock';
import { renderPage } from '@/test/render';
import { beatState, minuteSlots } from './heartbeat-card';
import { NotificationsPage } from './notifications-page';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const URL_OK = 'https://hc-ping.com/5f2c1e7a-0b4d-4c8e-9a61-2d7f3b9ea91e';

function view(patch: Partial<HeartbeatView['status']> = {}, url = URL_OK): HeartbeatView {
  return {
    url,
    status: {
      everySeconds: 60,
      lastAttemptAt: null,
      lastOkAt: null,
      lastResult: null,
      consecutiveFailures: 0,
      recent: [],
      ...patch,
    },
  };
}
const at = (secAgo: number) => new Date(NOW - secAgo * 1000).toISOString();

describe('состояние сигнала', () => {
  it('без адреса — выключен и честно: никто не узнает', () => {
    const s = beatState(view({}, ''), NOW);
    expect(s).toMatchObject({ tone: 'muted', pill: 'Выключен', title: 'Сигнал не настроен' });
    expect(s.text).toContain('никто не узнает');
  });

  it('адрес есть, попыток ещё не было — ждёт первого сигнала', () => {
    expect(beatState(view(), NOW)).toMatchObject({ tone: 'info', pill: 'Ждёт первого сигнала' });
  });

  it('принят — «12 с назад» и время ответа', () => {
    const s = beatState(
      view({
        lastOkAt: at(12),
        lastResult: { ok: true, sent: true, at: at(12), httpStatus: 200, ms: 184, problem: null },
      }),
      NOW,
    );
    expect(s).toMatchObject({ tone: 'ok', pill: 'Сигнал идёт' });
    expect(s.text).toBe('Последний — 12 с назад, сервис принял за 184 мс.');
  });

  it('панель не готова — «придержан» с причиной без служебной приставки', () => {
    const s = beatState(
      view({
        consecutiveFailures: 4,
        lastResult: {
          ok: false,
          sent: false,
          at: at(20),
          httpStatus: null,
          ms: null,
          problem: 'не отправлен: поиск инцидентов не отрабатывал 4 мин',
        },
      }),
      NOW,
    );
    expect(s).toMatchObject({ tone: 'warn', title: 'Сигнал придержан' });
    expect(s.text).toContain('Панель отвечает, но поиск инцидентов не отрабатывал 4 мин.');
    expect(s.text).not.toContain('не отправлен:');
  });

  it('404 подряд — сколько раз, почему и когда приняли в последний раз', () => {
    const s = beatState(
      view({
        consecutiveFailures: 16,
        lastOkAt: at(16 * 60),
        lastResult: {
          ok: false,
          sent: true,
          at: at(5),
          httpStatus: 404,
          ms: 212,
          problem: 'сервис ответил 404',
        },
      }),
      NOW,
    );
    expect(s).toMatchObject({ tone: 'crit', pill: 'Сервис не принимает' });
    expect(s.text).toContain('Сервис ответил 404 — 16 раз подряд.');
    expect(s.text).toContain('адрес скопирован не целиком');
    expect(s.text).toContain('Последний принятый — 16 мин назад.');
  });
});

describe('полоса за последний час', () => {
  it('по минутам: попытка в своей минуте, худшая из нескольких, пустые — «нет данных»', () => {
    const slots = minuteSlots(
      [
        { at: at(59 * 60 + 10), outcome: 'ok' },
        { at: at(125), outcome: 'held' },
        { at: at(70), outcome: 'ok' },
        { at: at(65), outcome: 'failed' },
        { at: at(5), outcome: 'ok' },
        { at: at(61 * 60), outcome: 'failed' },
      ],
      NOW,
    );
    expect(slots).toHaveLength(60);
    expect(slots[0]).toBe('ok');
    expect(slots[57]).toBe('held');
    expect(slots[58]).toBe('failed');
    expect(slots[59]).toBe('ok');
    expect(slots.filter((s) => s === 'none')).toHaveLength(56);
  });
});

describe('блок в «Уведомлениях»', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('без адреса: инструкция раскрыта, проверка недоступна; адрес — проверка и сохранение общей кнопкой', async () => {
    renderPage(NotificationsPage, '/settings/notifications');
    const user = userEvent.setup();
    expect(await screen.findByText('Сигнал не настроен')).toBeInTheDocument();
    expect(screen.getByText('Как настроить сервис проверки').closest('details')).toHaveAttribute('open');
    const test = screen.getByRole('button', { name: 'Отправить проверку' });
    expect(test).toBeDisabled();

    const input = screen.getByLabelText(/Адрес сигнала/);
    await user.type(input, 'hc-ping.com/без-схемы');
    expect(screen.getByText('Введите адрес вида https://hc-ping.com/…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();

    await user.clear(input);
    await user.type(input, URL_OK);
    await user.click(screen.getByRole('button', { name: 'Отправить проверку' }));
    expect(await screen.findByText(/Сервис принял сигнал за 184 мс/)).toBeInTheDocument();
    // Проверка чужого (несохранённого) адреса не попадает в состояние.
    expect(mockHeartbeat.view.url).toBe('');

    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockHeartbeat.view.url).toBe(URL_OK));
    expect(await screen.findByText('Сигнал идёт', { selector: 'b' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /принято 1/ })).toBeInTheDocument();
  });

  it('адрес во внутренней сети — ошибка под полем от сервера, адрес не сохранён', async () => {
    renderPage(NotificationsPage, '/settings/notifications');
    const user = userEvent.setup();
    const input = await screen.findByLabelText(/Адрес сигнала/);
    await user.type(input, 'http://192.168.1.10/api/push/abc');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Нужен адрес внешнего сервиса, не внутренней сети')).toBeInTheDocument();
    expect(mockHeartbeat.view.url).toBe('');
  });

  it('панель не готова — сигнал придержан; проверка говорит, что обычные не уходят', async () => {
    mockHeartbeat.view.url = URL_OK;
    mockHeartbeat.notReady = ['поиск инцидентов не отрабатывал 4 мин'];
    mockHeartbeatBeat();
    renderPage(NotificationsPage, '/settings/notifications');
    const user = userEvent.setup();
    expect(await screen.findByText('Сигнал придержан')).toBeInTheDocument();
    expect(screen.getByText('Как настроить сервис проверки').closest('details')).not.toHaveAttribute('open');
    await user.click(screen.getByRole('button', { name: 'Отправить проверку' }));
    expect(await screen.findByText(/обычные сейчас не отправляются/)).toBeInTheDocument();
  });

  it('сервис отвечает 404 — состояние и итог проверки с подсказкой', async () => {
    mockHeartbeat.view.url = 'https://hc-ping.com/404-нет-такой';
    mockHeartbeatBeat();
    renderPage(NotificationsPage, '/settings/notifications');
    const user = userEvent.setup();
    expect(await screen.findByText('Сервис не принимает сигнал')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Отправить проверку' }));
    expect(await screen.findByText(/скопируйте его заново/)).toBeInTheDocument();
  });
});
