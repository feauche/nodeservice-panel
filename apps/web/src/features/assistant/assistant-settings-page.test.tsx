import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { mockAssistant } from '@/test/msw/assistant-mock';
import { resetMockState } from '@/test/msw/handlers';
import { renderPage } from '@/test/render';
import { AssistantSettingsPage } from './assistant-settings-page';

/** Подраздел — адрес `?s=`: в панели на него ведут ссылки левой рейки «Настроек». */
const go = async (router: { navigate: (o: never) => Promise<void> }, s: string) =>
  act(async () => {
    await router.navigate({ to: '/settings/assistant', search: { s } } as never);
  });

describe('AssistantSettingsPage', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('включение ключом делает Ассистента доступным', async () => {
    mockAssistant.enabled = false;
    renderPage(AssistantSettingsPage, '/settings/assistant');
    expect(await screen.findByText('Выключен')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Ключ (API key провайдера)'), 'sk-ant-test-0123456789');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Включён')).toBeInTheDocument();
    expect(mockAssistant.enabled).toBe(true);
  });

  it('меняет подробность ответа и сохраняет её', async () => {
    mockAssistant.enabled = true;
    mockAssistant.level = 'intermediate';
    const { router } = renderPage(AssistantSettingsPage, '/settings/assistant');
    const user = userEvent.setup();
    await screen.findByText('Включён');

    await go(router, 'behavior');
    await user.click(screen.getByRole('radio', { name: 'Кратко' }));
    expect(screen.getByText('Токенов: меньше')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockAssistant.level).toBe('pro'));
  });

  it('старый адрес разрешений открывает безопасный раздел подключения', async () => {
    mockAssistant.enabled = true;
    const { router } = renderPage(AssistantSettingsPage, '/settings/assistant');
    await screen.findByText('Включён');
    await go(router, 'permissions');
    expect(screen.getByRole('heading', { name: 'Подключение' })).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('раздел «Данные для провайдера» описывает полный парк и строгий режим чтения', async () => {
    mockAssistant.enabled = true;
    const { router } = renderPage(AssistantSettingsPage, '/settings/assistant');

    await screen.findByText('Включён');
    await go(router, 'privacy');
    expect(screen.getByText(/Метрики, состояние серверов и их названия/)).toBeInTheDocument();
    expect(screen.getByText(/Сохранённые метрики нод, результаты прошлых проверок/)).toBeInTheDocument();
    expect(screen.getByText('Ассистент не запускает проверки и изменения.')).toBeInTheDocument();
    expect(screen.queryByText(/SSH/)).not.toBeInTheDocument();
    expect(screen.queryByText('Автоматический разбор')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('несохранённое видно в панели и не теряется при переходе между подразделами; «Отменить» возвращает как было', async () => {
    mockAssistant.enabled = true;
    mockAssistant.level = 'intermediate';
    const { router } = renderPage(AssistantSettingsPage, '/settings/assistant');
    const user = userEvent.setup();
    await screen.findByText('Включён');
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    await go(router, 'behavior');
    await user.click(screen.getByRole('radio', { name: 'Подробно' }));
    expect(screen.getByText('Есть несохранённые изменения')).toBeInTheDocument();
    await go(router, 'privacy');
    await go(router, 'behavior');
    expect(screen.getByRole('radio', { name: 'Подробно' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Отменить' }));
    expect(screen.getByRole('radio', { name: 'Обычно' })).toBeChecked();
    expect(screen.queryByText('Есть несохранённые изменения')).not.toBeInTheDocument();
  });

  it('убрать ключ выключает Ассистента', async () => {
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
