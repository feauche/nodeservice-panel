import { ASSISTANT_PERMISSIONS_DEFAULT } from '@nodeservice/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { mockAssistant } from '@/test/msw/assistant-mock';
import { resetMockState } from '@/test/msw/handlers';
import { renderPage } from '@/test/render';
import { AssistantSettingsPage } from './assistant-settings-page';

describe('AssistantSettingsPage', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('включение ключом делает Джарвиса доступным', async () => {
    mockAssistant.enabled = false;
    renderPage(AssistantSettingsPage, '/settings/assistant');
    expect(await screen.findByText('Выключен')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Ключ (API key провайдера)'), 'sk-ant-test-0123456789');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Включён')).toBeInTheDocument();
    expect(mockAssistant.enabled).toBe(true);
  });

  it('меняет подробность и разрешения и сохраняет их', async () => {
    mockAssistant.enabled = true;
    mockAssistant.level = 'intermediate';
    mockAssistant.permissions = { ...ASSISTANT_PERMISSIONS_DEFAULT };
    renderPage(AssistantSettingsPage, '/settings/assistant');
    const user = userEvent.setup();
    await screen.findByText('Включён');

    await user.click(screen.getByRole('button', { name: 'Разрешения' }));
    // Автоглоссарий выключить нельзя: переключателя нет, он работает всегда
    expect(screen.queryByRole('switch', { name: /Автоглоссарий/ })).not.toBeInTheDocument();
    expect(screen.getByText('Автоглоссарий «Пояснения»')).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Еженедельная ревизия' }));

    await user.click(screen.getByRole('button', { name: 'Поведение' }));
    await user.click(screen.getByRole('radio', { name: 'Кратко' }));
    expect(screen.getByText('Токенов: меньше')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockAssistant.level).toBe('pro'));
    expect(mockAssistant.permissions.kbReview).toBe(false);
    expect(mockAssistant.permissions.kbWrite).toBe(true);
  });

  it('готовые наборы: применяются одним нажатием и подсвечиваются, ручная правка их сбрасывает', async () => {
    mockAssistant.enabled = true;
    mockAssistant.permissions = { ...ASSISTANT_PERMISSIONS_DEFAULT };
    renderPage(AssistantSettingsPage, '/settings/assistant');
    const user = userEvent.setup();
    await screen.findByText('Включён');
    await user.click(screen.getByRole('button', { name: 'Разрешения' }));
    expect(screen.getByRole('radio', { name: /Обычный/ })).toBeChecked();

    await user.click(screen.getByRole('radio', { name: /Максимальный автоматизм/ }));
    expect(screen.getByRole('radio', { name: /Максимальный автоматизм/ })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Автоматический разбор' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Логи ноды' })).toBeChecked();

    await user.click(screen.getByRole('switch', { name: 'Логи ноды' }));
    expect(screen.getByText('Сейчас настроено вручную.')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /Осторожный/ }));
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockAssistant.permissions.reach).toBe(false));
    expect(mockAssistant.permissions.terminalHints).toBe(true);
    expect(mockAssistant.permissions.autoAnalysis).toBe(false);
  });

  it('автоматический разбор зависит от разбора по кнопке и выключается вместе с ним', async () => {
    mockAssistant.enabled = true;
    mockAssistant.permissions = { ...ASSISTANT_PERMISSIONS_DEFAULT, autoAnalysis: true };
    renderPage(AssistantSettingsPage, '/settings/assistant');
    const user = userEvent.setup();
    await screen.findByText('Включён');
    await user.click(screen.getByRole('button', { name: 'Разрешения' }));
    const auto = screen.getByRole('switch', { name: 'Автоматический разбор' });
    expect(auto).toBeChecked();
    await user.click(screen.getByRole('switch', { name: 'Разбор по кнопке' }));
    expect(auto).not.toBeChecked();
    expect(auto).toBeDisabled();
    expect(screen.getByText('Сначала включите «Разбор по кнопке».')).toBeInTheDocument();
  });

  it('у каждого разрешения есть метки риска, у серверных чтений это видно сразу', async () => {
    mockAssistant.enabled = true;
    renderPage(AssistantSettingsPage, '/settings/assistant');
    const user = userEvent.setup();
    await screen.findByText('Включён');
    await user.click(screen.getByRole('button', { name: 'Разрешения' }));
    expect(screen.getByText('Серверы, только чтение')).toBeInTheDocument();
    expect(screen.getAllByText('Ходит на серверы').length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText('Данные уходят провайдеру').length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText('Только с вашего подтверждения')).toHaveLength(2);
  });

  it('«Изменения по подтверждению»: отдельная группа «Изменения» под «Инциденты», подсказка, метка риска, наборы и сохранение', async () => {
    mockAssistant.enabled = true;
    mockAssistant.permissions = { ...ASSISTANT_PERMISSIONS_DEFAULT };
    renderPage(AssistantSettingsPage, '/settings/assistant');
    const user = userEvent.setup();
    await screen.findByText('Включён');
    await user.click(screen.getByRole('button', { name: 'Разрешения' }));

    const groups = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(groups.indexOf('Инциденты')).toBeGreaterThanOrEqual(0);
    expect(groups.findIndex((t) => t?.startsWith('Изменения'))).toBe(groups.indexOf('Инциденты') + 1);
    expect(screen.getByText('только с вашего подтверждения')).toBeInTheDocument();
    expect(screen.getByText(/карточкой с «было → станет»\. Применяете вы;/)).toBeInTheDocument();
    expect(screen.getByText(/записывается в Журнал/)).toBeInTheDocument();

    const sw = screen.getByRole('switch', { name: 'Изменения по подтверждению' });
    expect(sw).toBeChecked();
    // Наборы: «Осторожный» выключает, «Обычный» и «Максимальный автоматизм» включают
    await user.click(screen.getByRole('radio', { name: /Осторожный/ }));
    expect(sw).not.toBeChecked();
    await user.click(screen.getByRole('radio', { name: /Обычный/ }));
    expect(sw).toBeChecked();
    await user.click(screen.getByRole('radio', { name: /Максимальный автоматизм/ }));
    expect(sw).toBeChecked();

    await user.click(sw);
    expect(sw).not.toBeChecked();
    expect(screen.getByText('Сейчас настроено вручную.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockAssistant.permissions.changes).toBe(false));
    expect(mockAssistant.permissions.proposals).toBe(true);
  });

  it('раздел «Данные для провайдера» показывает только то, что разрешено', async () => {
    mockAssistant.enabled = true;
    mockAssistant.permissions = { ...ASSISTANT_PERMISSIONS_DEFAULT, nodeLogs: false, terminalHints: false };
    renderPage(AssistantSettingsPage, '/settings/assistant');
    const user = userEvent.setup();
    await screen.findByText('Включён');
    await user.click(screen.getByRole('button', { name: 'Данные для провайдера' }));
    expect(screen.getByText(/Метрики, состояние серверов и их названия/)).toBeInTheDocument();
    expect(screen.queryByText(/журнала ноды/)).not.toBeInTheDocument();
    expect(screen.queryByText(/последние строки терминала/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Имена самых тяжёлых процессов/)).toBeInTheDocument();
  });

  it('несохранённое видно в панели и точкой у раздела; «Отменить» возвращает как было', async () => {
    mockAssistant.enabled = true;
    mockAssistant.level = 'intermediate';
    renderPage(AssistantSettingsPage, '/settings/assistant');
    const user = userEvent.setup();
    await screen.findByText('Включён');
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Поведение' }));
    await user.click(screen.getByRole('radio', { name: 'Подробно' }));
    expect(screen.getByText('Есть несохранённые изменения')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /Поведение/ })).getByRole('img')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Отменить' }));
    expect(screen.getByRole('radio', { name: 'Обычно' })).toBeChecked();
    expect(screen.queryByText('Есть несохранённые изменения')).not.toBeInTheDocument();
  });

  it('убрать ключ выключает Джарвиса', async () => {
    mockAssistant.enabled = true;
    renderPage(AssistantSettingsPage, '/settings/assistant');
    expect(await screen.findByText('Включён')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Убрать ключ' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Да, убрать' }));
    await waitFor(() => expect(mockAssistant.enabled).toBe(false));
  });
});
