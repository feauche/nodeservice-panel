import { AUTOCHECKS_DEFAULTS } from '@nodeservice/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { mockAutochecks } from '@/test/msw/autochecks-mock';
import { resetMockState } from '@/test/msw/handlers';
import { renderPage } from '@/test/render';
import { AutochecksPage } from './autochecks-page';

describe('AutochecksPage', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
  });

  it('показывает четыре автопроверки со значениями по умолчанию, «Сохранить» задизейблена', async () => {
    renderPage(AutochecksPage, '/settings/autochecks');
    expect(await screen.findByRole('textbox', { name: 'Серверы без агента' })).toHaveValue('15');
    expect(screen.getByRole('textbox', { name: 'Серверы с агентом' })).toHaveValue('60');
    expect(screen.getByRole('textbox', { name: 'Агент не в сети' })).toHaveValue('30');
    expect(screen.getByRole('textbox', { name: 'Метрики агента' })).toHaveValue('10');
    expect(screen.getAllByRole('switch')).toHaveLength(4);
    for (const s of screen.getAllByRole('switch')) expect(s).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  });

  it('выключенный тумблер блокирует поле интервала', async () => {
    renderPage(AutochecksPage, '/settings/autochecks');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Метрики агента' }));
    expect(screen.getByRole('textbox', { name: 'Метрики агента' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeEnabled();
  });

  it('смена интервала и «Сохранить» уходят в API', async () => {
    renderPage(AutochecksPage, '/settings/autochecks');
    const user = userEvent.setup();
    const input = await screen.findByRole('textbox', { name: 'Серверы без агента' });
    await user.clear(input);
    await user.type(input, '30');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockAutochecks.value.sshIntervalMinutes).toBe(30));
    // после сохранения форма чистая
    await waitFor(() => expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled());
  });

  it('интервал меньше минимума — ошибка у поля, API не вызывается', async () => {
    renderPage(AutochecksPage, '/settings/autochecks');
    const user = userEvent.setup();
    const input = await screen.findByRole('textbox', { name: 'Серверы без агента' });
    await user.clear(input);
    await user.type(input, '2');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mockAutochecks.value.sshIntervalMinutes).toBe(15);
  });

  it('«По умолчанию» возвращает раздел целиком и дизейблится', async () => {
    mockAutochecks.value = { ...AUTOCHECKS_DEFAULTS, sshIntervalMinutes: 45, metricsEnabled: false };
    renderPage(AutochecksPage, '/settings/autochecks');
    expect(await screen.findByRole('textbox', { name: 'Серверы без агента' })).toHaveValue('45');
    const user = userEvent.setup();
    const reset = screen.getByRole('button', { name: 'По умолчанию' });
    expect(reset).toBeEnabled();
    await user.click(reset);
    await waitFor(() => expect(mockAutochecks.value).toEqual(AUTOCHECKS_DEFAULTS));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Серверы без агента' })).toHaveValue('15'),
    );
    expect(screen.getByRole('button', { name: 'По умолчанию' })).toBeDisabled();
  });

  it('на дефолтах «По умолчанию» задизейблена', async () => {
    renderPage(AutochecksPage, '/settings/autochecks');
    await screen.findByRole('textbox', { name: 'Серверы без агента' });
    expect(screen.getByRole('button', { name: 'По умолчанию' })).toBeDisabled();
  });
});
