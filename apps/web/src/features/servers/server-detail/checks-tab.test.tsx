import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockAutochecks } from '@/test/msw/autochecks-mock';
import { resetMockState } from '@/test/msw/handlers';
import { mockServerChecks, seedServerChecks } from '@/test/msw/server-checks-mock';
import { mockServers } from '@/test/msw/servers-mock';
import { renderPage } from '@/test/render';
import { ChecksTab } from './checks-tab';

const server = () => {
  const s = mockServers.items[0];
  if (!s) throw new Error('нет мок-сервера');
  return s;
};

describe('ChecksTab', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('лёгкие и тяжёлые — отдельно; статусы и вывод по раскрытию; «Объяснить» показывает пересказ', async () => {
    seedServerChecks(server().id);
    renderPage(() => <ChecksTab server={server()} />, '/');
    const geo = await screen.findByTestId('check-geoblock');
    expect(within(geo).getAllByText('Готово').length).toBeGreaterThan(0);
    expect(within(screen.getByTestId('check-dpi')).getAllByText('Ошибка').length).toBeGreaterThan(0);
    expect(within(screen.getByTestId('check-yabs')).getAllByText('Не запускалась').length).toBeGreaterThan(0);
    expect(screen.getByText('Тяжёлые — только вручную')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(geo).getByRole('button', { name: /Подробнее/ }));
    expect(within(geo).getByTestId('check-output').textContent).toContain('spotify.com');
    await user.click(within(geo).getByRole('button', { name: 'Объяснить' }));
    expect(await within(geo).findByText(/не открывается только Spotify/)).toBeInTheDocument();
  });

  it('ручной запуск: строка идёт, вывод появляется и проверка завершается', async () => {
    renderPage(() => <ChecksTab server={server()} />, '/');
    const cpu = await screen.findByTestId('check-cpu');
    const user = userEvent.setup();
    await user.click(within(cpu).getByRole('button', { name: /Запустить/ }));
    await waitFor(() => expect(mockServerChecks.runs.find((r) => r.check === 'cpu')?.status).toBe('ok'));
    await waitFor(() => expect(within(cpu).getAllByText('Готово').length).toBeGreaterThan(0), {
      timeout: 4000,
    });
  });

  it('доступность из России — отдельный ручной пункт с таблицей российских и зарубежных точек', async () => {
    renderPage(() => <ChecksTab server={server()} />, '/');
    const list = await screen.findByRole('list', { name: 'Каждый день, автоматически' });
    const access = within(list).getByTestId('check-russia_access');
    expect(within(access).getByText('Доступность из России')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(access).getByRole('button', { name: /Запустить/ }));
    await waitFor(
      () => expect(mockServerChecks.runs.find((r) => r.check === 'russia_access')?.status).toBe('ok'),
      { timeout: 4000 },
    );
    await waitFor(() => expect(within(access).getAllByText('Доступна').length).toBeGreaterThan(0), {
      timeout: 4000,
    });
    await user.click(within(access).getByRole('button', { name: /Подробнее/ }));
    expect(within(access).getByText('Из России')).toBeInTheDocument();
    expect(within(access).getByText('Контроль из других стран')).toBeInTheDocument();
    expect(within(access).getByText('Россия - 1')).toBeInTheDocument();
    expect(within(access).getByText('Германия - 1')).toBeInTheDocument();
  });

  it('свои проверки раз в сутки; сторонние скрипты отдельно и только по кнопке', async () => {
    seedServerChecks(server().id);
    renderPage(() => <ChecksTab server={server()} />, '/');
    await screen.findByTestId('check-cpu');
    expect(screen.getByText(/Доступность из России и процессор/)).toHaveTextContent(
      /раз в сутки, следующий замер — через .*Сторонние скрипты запускаются только по кнопке\./,
    );
    const auto = screen.getByRole('list', { name: 'Каждый день, автоматически' });
    expect(
      within(auto)
        .getAllByRole('listitem')
        .map((li) => li.dataset.testid),
    ).toEqual(['check-russia_access', 'check-cpu']);
    const scripts = screen.getByRole('list', { name: 'Сторонние скрипты — по кнопке' });
    expect(
      within(scripts)
        .getAllByRole('listitem')
        .map((li) => li.dataset.testid),
    ).toEqual(['check-ip_region', 'check-geoblock', 'check-dpi', 'check-ip_quality']);
    expect(screen.getByText('версия закреплена и сверяется перед запуском')).toBeInTheDocument();
  });

  it('суточный замер выключен в настройках — так и сказано, «автоматически» не обещаем', async () => {
    mockAutochecks.value = { ...mockAutochecks.value, serverChecksEnabled: false };
    seedServerChecks(server().id);
    renderPage(() => <ChecksTab server={server()} />, '/');
    await screen.findByTestId('check-cpu');
    expect(screen.getByText(/Суточные проверки доступности и процессора выключены/)).toHaveTextContent(
      'все проверки запускаются по кнопке',
    );
    expect(screen.queryByText('Каждый день, автоматически')).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Своя проверка — по кнопке' })).toBeInTheDocument();
  });

  it('запуск отменён: скачанный скрипт не совпал с проверенным — «Отменена», а не «Ошибка», и причина словами', async () => {
    const id = server().id;
    mockServerChecks.runs.push({
      id: '0192c000-cccc-7000-8000-00000000abcd',
      serverId: id,
      check: 'ip_region',
      status: 'cancelled',
      trigger: 'manual',
      actorDisplay: 'admin',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      finishedAt: new Date().toISOString(),
      output: 'Скачанный скрипт не совпал с проверенной версией — запуск отменён.\n',
      error:
        'Скачанный скрипт не совпал с проверенной версией, записанной в панели, — запуск отменён, на сервере он не запускался. Файл могли подменить по дороге к серверу или на сайте, где он хранится.',
      explanation: null,
    });
    renderPage(() => <ChecksTab server={server()} />, '/');
    const region = await screen.findByTestId('check-ip_region');
    expect(within(region).getAllByText('Отменена').length).toBeGreaterThan(0);
    expect(within(region).queryByText('Ошибка')).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(region).getByRole('button', { name: /Подробнее/ }));
    expect(
      within(region).getByText(/^Скачанный скрипт не совпал с проверенной версией, записанной в панели,/),
    ).toBeInTheDocument();
  });

  it('тяжёлая проверка — только после подтверждения', async () => {
    renderPage(() => <ChecksTab server={server()} />, '/');
    const yabs = await screen.findByTestId('check-yabs');
    const user = userEvent.setup();
    await user.click(within(yabs).getByRole('button', { name: /Запустить/ }));
    expect(mockServerChecks.runs.some((r) => r.check === 'yabs')).toBe(false);
    expect(await screen.findByText(/Тяжёлая проверка/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Запустить' }));
    await waitFor(() => expect(mockServerChecks.runs.some((r) => r.check === 'yabs')).toBe(true));
  });
});
