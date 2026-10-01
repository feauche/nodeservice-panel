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

  it('показывает автопроверки со значениями по умолчанию, «Сохранить» задизейблена', async () => {
    renderPage(AutochecksPage, '/settings/autochecks');
    expect(await screen.findByRole('textbox', { name: 'Серверы без агента' })).toHaveValue('15');
    expect(screen.getByRole('textbox', { name: 'Серверы с агентом' })).toHaveValue('60');
    expect(screen.getByRole('textbox', { name: 'Агент не в сети' })).toHaveValue('30');
    expect(screen.getByRole('textbox', { name: 'Метрики агента' })).toHaveValue('10');
    expect(screen.getAllByRole('switch')).toHaveLength(5);
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

  it('«Агент не в сети»: подсказка говорит, как часто агент подаёт сигнал; порог меньше 30 секунд не принимается', async () => {
    renderPage(AutochecksPage, '/settings/autochecks');
    const user = userEvent.setup();
    const input = await screen.findByRole('textbox', { name: 'Агент не в сети' });
    expect(
      screen.getByText(/Агент подаёт сигнал раз в 10 секунд\..*Порог — не меньше 30 секунд/),
    ).toBeInTheDocument();
    // Диапазон рядом с полем — с новым минимумом.
    expect(screen.getByText('30–600')).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, '10');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Не меньше 30');
    expect(mockAutochecks.value.agentOfflineAfterSeconds).toBe(30);
    // Порог не меньше минимума — сохраняется.
    await user.clear(input);
    await user.type(input, '45');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockAutochecks.value.agentOfflineAfterSeconds).toBe(45));
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

  it('«Проверки серверов раз в сутки»: подпись — что идёт само, а что только по кнопке; выключение сохраняется', async () => {
    renderPage(AutochecksPage, '/settings/autochecks');
    const toggle = await screen.findByRole('switch', { name: 'Проверки серверов раз в сутки' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    // Что будет при каждом значении и что сторонние скрипты сами не запускаются никогда.
    expect(
      screen.getByText(
        /Включено — раз в сутки панель сама замеряет процессор каждого сервера своей командой/,
      ),
    ).toHaveTextContent('Выключено — замер только по кнопке.');
    expect(
      screen.getByText(/Регион IP, геоблок, DPI до России и качество IP — сторонние скрипты/),
    ).toHaveTextContent(
      /по расписанию не запускаются.*только по кнопке во вкладке «Проверки» сервера или Джарвисом по вашей просьбе/,
    );
    const user = userEvent.setup();
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockAutochecks.value.serverChecksEnabled).toBe(false));
  });

  it('на дефолтах «По умолчанию» задизейблена', async () => {
    renderPage(AutochecksPage, '/settings/autochecks');
    await screen.findByRole('textbox', { name: 'Серверы без агента' });
    expect(screen.getByRole('button', { name: 'По умолчанию' })).toBeDisabled();
  });
});
