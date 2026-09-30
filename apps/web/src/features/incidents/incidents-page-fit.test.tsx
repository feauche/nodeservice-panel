import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetMockState } from '@/test/msw/handlers';
import { mockIncidents } from '@/test/msw/incidents-mock';
import { renderPage } from '@/test/render';
import { FOOTER_HEIGHT } from './incidents-fit';
import { IncidentsPage } from './incidents-page';

/**
 * Реестр по высоте окна. В jsdom раскладки нет, поэтому высоту под реестр задаём сами — как её намерил бы
 * браузер (до нижнего поля, вместе со строкой страниц), и меняем по ходу теста, как при изменении окна.
 */
const room = vi.hoisted(() => ({ height: 0, subs: new Set<() => void>() }));
vi.mock('@/lib/use-available-height', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (cb: () => void) => {
    room.subs.add(cb);
    return () => room.subs.delete(cb);
  };
  return { useAvailableHeight: () => useSyncExternalStore(subscribe, () => room.height) };
});
vi.mock('@/lib/use-media', () => ({ useMediaQuery: () => true }));

/** Высота под сам реестр (как в отчёте проверки: 514 — окно 1440×900). */
const setRoom = (available: number) =>
  act(() => {
    room.height = available + FOOTER_HEIGHT;
    for (const cb of room.subs) cb();
  });

/**
 * Решённые по дням: perDay[d] — сколько сбоев закрыто d дней назад; внутри дня — с шагом в секунду от 00:10,
 * поэтому граница дня от времени прогона не зависит. Номер строки в списке — в названии: «Сбой N».
 */
const seedDays = (perDay: number[]) => {
  const [base] = mockIncidents.items;
  if (!base) throw new Error('нет мок-инцидента');
  const now = new Date();
  let n = 0;
  mockIncidents.items = perDay.flatMap((count, d) =>
    Array.from({ length: count }, (_, j) => {
      const closed =
        new Date(now.getFullYear(), now.getMonth(), now.getDate() - d).getTime() + 600_000 - j * 1000;
      n += 1;
      return {
        ...base,
        id: `7d9a2b1c-3e4f-4a5b-8c6d-${String(n).padStart(12, '0')}`,
        kind: 'cpu_high' as const,
        title: `Сбой ${n} · de-fra-01`,
        status: 'resolved' as const,
        openedAt: new Date(closed - 500).toISOString(),
        resolvedAt: new Date(closed).toISOString(),
        resolvedBy: 'auto' as const,
        attempts: [],
        proposal: null,
        analysis: null,
      };
    }),
  );
  return n;
};
const rowNumbers = () =>
  screen.getAllByTestId('incident-row').map((r) => Number(/Сбой (\d+)/.exec(r.textContent ?? '')?.[1]));
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const label = () => screen.getByTestId('incidents-footer').querySelector('p')?.textContent ?? '';
const pager = () => within(screen.getByRole('navigation', { name: 'Страницы решённых инцидентов' }));
/** Дождаться, пока страница придёт и реестр перестанет быть приглушённым. */
const settled = () =>
  waitFor(() => expect(screen.getByTestId('incidents-list')).toHaveAttribute('aria-busy', 'false'));

async function open(perDay: number[], available: number) {
  const total = seedDays(perDay);
  setRoom(available);
  renderPage(IncidentsPage, '/incidents', ['/incidents/$id', '/incidents/autofix']);
  const user = userEvent.setup();
  await screen.findByText(new RegExp(`из ${total}`));
  await settled();
  return { user, total };
}

describe('IncidentsPage: реестр по высоте окна', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('Н2: от последней страницы «Предыдущей» до первой показана каждая строка — у начала восемь сжатых, а не семь', async () => {
    // Окно 1440×900, сегодня один сбой, дальше по десять в день.
    const { user, total } = await open([1, 10, 10, 10, 10, 10, 10, 10, 10, 1], 514);
    await user.click(pager().getByRole('button', { name: 'В конец' }));
    await settled();
    const seen = new Set<number>();
    const pages: string[] = [];
    for (let guard = 0; guard < 40; guard += 1) {
      for (const n of rowNumbers()) seen.add(n);
      pages.push(label());
      const prev = pager().getByRole('button', { name: 'Предыдущая' });
      if ((prev as HTMLButtonElement).disabled) break;
      await user.click(prev);
      await settled();
    }
    expect(range(1, total).filter((n) => !seen.has(n))).toEqual([]);
    expect(pages.slice(-2)).toEqual(['Решённых: 9–15 из 82', 'Решённых: 1–8 из 82']);
    expect(rowNumbers()).toEqual(range(1, 8));
  });

  it('Н4: «Следующая» → «Предыдущая» возвращает ту же страницу (1024×768, по три сбоя в день)', async () => {
    const { user } = await open(
      Array.from({ length: 40 }, () => 3),
      366,
    );
    for (let i = 0; i < 6; i += 1) {
      await user.click(pager().getByRole('button', { name: 'Следующая' }));
      await settled();
      const before = { rows: rowNumbers(), label: label() };
      await user.click(pager().getByRole('button', { name: 'Следующая' }));
      await settled();
      await user.click(pager().getByRole('button', { name: 'Предыдущая' }));
      await settled();
      expect({ rows: rowNumbers(), label: label() }).toEqual(before);
    }
  });

  it('Н3: окно стало ниже, а потом выше — первая видимая строка страницы, открытой «Предыдущей», остаётся на экране', async () => {
    const { user } = await open(
      Array.from({ length: 18 }, (_, d) => (d === 17 ? 3 : 10)),
      561,
    );
    await user.click(pager().getByRole('button', { name: 'В конец' }));
    await settled();
    for (let i = 0; i < 3; i += 1) {
      await user.click(pager().getByRole('button', { name: 'Предыдущая' }));
      await settled();
    }
    const first = rowNumbers()[0];
    for (const available of [561 - 150, 561 + 240, 561]) {
      setRoom(available);
      await settled();
      expect(rowNumbers()[0], `высота под реестр ${available}`).toBe(first);
    }
    // И дальше листается встык.
    const last = rowNumbers().at(-1) as number;
    await user.click(pager().getByRole('button', { name: 'Следующая' }));
    await settled();
    expect(rowNumbers()[0]).toBe(last + 1);
  });

  it('Н5: полная страница из одной строки растягивается до нижнего поля', async () => {
    // Низкое окно, по одному сбою в день: помещается одна строка со своим заголовком, вторая — даже сжатой нет.
    await open(
      Array.from({ length: 20 }, () => 1),
      170,
    );
    expect(label()).toBe('Решённых: 1–1 из 20');
    expect(screen.getByTestId('incident-row')).toHaveStyle({ minHeight: '132px' });
  });
});
