import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { mockAssistant } from '@/test/msw/assistant-mock';
import { resetMockState } from '@/test/msw/handlers';
import { renderPage } from '@/test/render';
import { AssistantSettingsPage } from './assistant-settings-page';

describe('AssistantSettingsPage', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('включение ключом делает ассистента доступным', async () => {
    mockAssistant.enabled = false;
    renderPage(AssistantSettingsPage, '/settings/assistant');
    expect(await screen.findByText('выключен')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Ключ (API key провайдера)'), 'sk-ant-test-0123456789');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('включён')).toBeInTheDocument();
    expect(mockAssistant.enabled).toBe(true);
  });

  it('меняет уровень и разрешения и сохраняет их', async () => {
    mockAssistant.enabled = true;
    mockAssistant.level = 'intermediate';
    mockAssistant.permissions = { kbWrite: true, glossary: true, kbReview: true };
    renderPage(AssistantSettingsPage, '/settings/assistant');
    const user = userEvent.setup();
    await screen.findByText('включён');

    // выключаем разрешение «Автоглоссарий»
    await user.click(screen.getByRole('switch', { name: 'Автоглоссарий «Пояснения»' }));

    // меняем уровень на «Профессионал» через свой селект
    await user.click(screen.getByRole('combobox', { name: 'Уровень' }));
    await user.click(await screen.findByRole('option', { name: 'Профессионал' }));

    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockAssistant.level).toBe('pro'));
    expect(mockAssistant.permissions.glossary).toBe(false);
    expect(mockAssistant.permissions.kbWrite).toBe(true);
  });

  it('убрать ключ выключает ассистента', async () => {
    mockAssistant.enabled = true;
    renderPage(AssistantSettingsPage, '/settings/assistant');
    expect(await screen.findByText('включён')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Убрать ключ' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Да, убрать' }));
    await waitFor(() => expect(mockAssistant.enabled).toBe(false));
  });
});
