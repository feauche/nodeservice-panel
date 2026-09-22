import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { mockAudit, seedAudit } from '@/test/msw/audit-mock';
import { resetMockState } from '@/test/msw/handlers';
import { renderPage } from '@/test/render';
import { AuditPage } from './audit-page';
import { type AuditSearch, matchesSearch, periodFrom } from './audit-search';
import { pageItems } from './pagination';

/** Обёртка вместо роутера: параметры страницы живут в состоянии. */
function Harness() {
  const [search, setSearch] = useState<AuditSearch>({});
  return (
    <AuditPage
      search={search}
      onSearch={(patch) =>
        setSearch((prev) => {
          const next = { ...prev, ...patch } as Record<string, unknown>;
          for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
          return next as AuditSearch;
        })
      }
    />
  );
}

const rows = () => screen.getAllByRole('row').filter((r) => r.hasAttribute('data-seq'));

describe('AuditPage', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    seedAudit(57);
    // Адаптивный размер страницы: (1208 − 64) / 44 − 1 = 25 строк.
    Object.defineProperty(window, 'innerHeight', { value: 1208, configurable: true, writable: true });
  });

  it('показывает записи новыми сверху с подписями, бейджем источника и пагинацией', async () => {
    renderPage(Harness, '/audit');
    await screen.findAllByText('Вход в панель');
    const list = rows();
    expect(list).toHaveLength(25);
    expect(list[0]).toHaveAttribute('data-seq', '57');
    expect(within(list[0] as HTMLElement).getByText('вручную')).toBeInTheDocument();
    expect(screen.getAllByText('авто').length).toBeGreaterThan(0);
    expect(screen.getByText('1–25 из 57')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Страницы журнала' })).toBeInTheDocument();
  });

  it('переход по номеру страницы', async () => {
    renderPage(Harness, '/audit');
    await screen.findByText('1–25 из 57');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '3' }));
    await screen.findByText('51–57 из 57');
    expect(rows()).toHaveLength(7);
    expect(screen.getByRole('button', { name: '3' })).toHaveAttribute('aria-current', 'page');
  });

  it('фильтр по результату и поиск сужают список; «Сбросить» возвращает всё', async () => {
    renderPage(Harness, '/audit');
    await screen.findByText('1–25 из 57');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^Результат/ }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Отказано' }));
    await user.keyboard('{Escape}'); // открытое меню прячет остальную страницу от a11y-запросов
    await waitFor(() => expect(screen.getByText(/из 9$/)).toBeInTheDocument());
    expect(rows().every((r) => within(r as HTMLElement).queryByText('Отказано'))).toBe(true);

    await user.type(screen.getByLabelText('Поиск по журналу'), 'root');
    await waitFor(() =>
      expect(screen.getByText('По этим фильтрам записей нет.', { exact: false })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: 'Сбросить' }));
    await screen.findByText('1–25 из 57');
  });

  it('«Скопировать» в деталях кладёт текстовый отчёт по записи в буфер', async () => {
    renderPage(Harness, '/audit');
    await screen.findByText('1–25 из 57');
    const user = userEvent.setup();
    const row = rows().find((r) =>
      within(r as HTMLElement).queryByText('Изменён внешний вид'),
    ) as HTMLElement;
    await user.click(row);
    await screen.findByTestId('audit-details');
    await user.click(screen.getByRole('button', { name: 'Скопировать' }));
    const report = await navigator.clipboard.readText();
    expect(report).toContain('=== NodeService: запись Журнала ===');
    expect(report).toContain('settings.appearance.updated');
    expect(report).toContain('Изменения:');
    expect(report).toContain('brandName');
  });

  it('клик по строке раскрывает детали: IP, ключ действия, diff изменений', async () => {
    renderPage(Harness, '/audit');
    await screen.findByText('1–25 из 57');
    const user = userEvent.setup();
    const row = rows().find((r) =>
      within(r as HTMLElement).queryByText('Изменён внешний вид'),
    ) as HTMLElement;
    await user.click(row);
    const details = await screen.findByTestId('audit-details');
    expect(within(details).getByText('settings.appearance.updated')).toBeInTheDocument();
    expect(within(details).getByText('203.0.113.7')).toBeInTheDocument();
    expect(within(details).getByText('brandName')).toBeInTheDocument();
    expect(within(details).getByText('Lumax[#accent]VPN')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Скрыть детали' }));
    expect(screen.queryByTestId('audit-details')).not.toBeInTheDocument();
    // метаданные входа — по-русски, не сырой JSON
    await user.click(rows()[0] as HTMLElement);
    const login = await screen.findByTestId('audit-details');
    expect(within(login).getByText('Способ входа')).toBeInTheDocument();
    expect(within(login).getByText('пароль + код 2FA')).toBeInTheDocument();
  });

  it('пустой журнал — понятное сообщение; экспорт ведёт на /api/audit/export с фильтрами', async () => {
    mockAudit.entries = [];
    renderPage(Harness, '/audit');
    await screen.findByText(/Журнал пока пуст/);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Экспорт/ }));
    const csv = await screen.findByRole('menuitem', { name: /CSV/ });
    expect(csv).toHaveAttribute('href', '/api/audit/export?format=csv');
  });

  it('утилиты: номера страниц с многоточием, период, совпадение live-записи с фильтрами', () => {
    expect(pageItems(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageItems(5, 20)).toEqual([1, '…', 4, 5, 6, '…', 20]);
    expect(pageItems(1, 20)).toEqual([1, 2, 3, 4, '…', 20]);
    expect(pageItems(20, 20)).toEqual([1, '…', 17, 18, 19, 20]);
    const now = new Date('2026-08-29T12:00:00Z');
    expect(periodFrom('7d', now)).toBe('2026-08-22T12:00:00.000Z');
    expect(periodFrom('all', now)).toBeUndefined();
    seedAudit(3);
    const e = mockAudit.entries[0] as NonNullable<(typeof mockAudit.entries)[0]>;
    expect(matchesSearch(e, {})).toBe(true);
    expect(matchesSearch(e, { category: ['system'] })).toBe(e.category === 'system');
    expect(matchesSearch(e, { q: e.actorDisplay })).toBe(true);
  });
});
