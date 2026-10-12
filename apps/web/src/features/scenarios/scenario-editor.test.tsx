import { scenarioSchema } from '@nodeservice/shared';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
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
function Harness() {
  const [draft, setDraft] = useState<typeof initial | null>(initial);
  return (
    draft && (
      <ScenarioEditor
        draft={draft}
        setDraft={setDraft}
        busy={false}
        onSave={() => {}}
        onClose={() => {}}
        error={null}
      />
    )
  );
}
beforeEach(() => {
  resetMockState({ authenticated: true });
  server.use(http.get('*/api/scenarios/hosts', () => HttpResponse.json({ hosts: [] })));
});
describe('Редактор сценария: взаимодействие', () => {
  it('вся карточка меняет именно своё действие; галочка переключает то же действие', async () => {
    const user = userEvent.setup();
    renderPage(Harness, '/scenarios');
    await screen.findByRole('dialog');
    for (const name of [
      'Проверить TCP',
      'Записать событие',
      'Уведомить в Telegram',
      'Скрыть Host',
      'Изменить имя Host',
    ]) {
      const checkbox = screen.getByRole('checkbox', { name });
      const checked = checkbox.getAttribute('aria-checked');
      const card = checkbox.closest('label');
      if (!card) throw Error('Нет карточки действия');
      await user.click(card);
      expect(checkbox.getAttribute('aria-checked')).not.toBe(checked);
      await user.click(checkbox);
      expect(checkbox.getAttribute('aria-checked')).toBe(checked);
    }
    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('можно очистить время и ввести 2 вместо 0; пустое время запрещает сохранение', async () => {
    const user = userEvent.setup();
    renderPage(Harness, '/scenarios');
    await screen.findByRole('dialog');
    const hold = screen.getByRole('spinbutton', { name: /Подтверждение всей группы/ });
    await user.clear(hold);
    expect(hold).toHaveValue(null);
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    await user.type(hold, '0');
    expect(hold).toHaveValue(0);
    await user.clear(hold);
    await user.type(hold, '2');
    expect(hold).toHaveValue(2);
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeEnabled();
  });
  it('показывает И/ИЛИ и пояснение TCP, предупреждает об отключённой категории Telegram', async () => {
    const user = userEvent.setup();
    renderPage(Harness, '/scenarios');
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Добавить условие' }));
    await user.click(screen.getByRole('button', { name: 'Добавить условие' }));
    expect(screen.getByText(/Check-Host подтвердил недоступность/)).toBeVisible();
    await user.click(screen.getByRole('radio', { name: 'ИЛИ · любое' }));
    await user.click(screen.getByRole('checkbox', { name: 'Уведомить в Telegram' }));
    expect(await screen.findByText(/Сообщение не придёт: Telegram не подключён/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Настройки уведомлений →' })).toHaveAttribute(
      'href',
      '/settings/notifications',
    );
  });
});
