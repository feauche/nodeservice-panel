import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuthStore } from '@/features/auth/store';
import { resetNavigationLayout, setNavigationLayout } from '@/features/settings/navigation-layout';
import { PanelVersion } from '@/features/system/panel-version';
import { mockCustomSites, mockMe, resetMockState } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { AppShell, resetNavGroupState } from './app-shell';

function Page() {
  return (
    <AppShell title="Обзор">
      <div>содержимое</div>
    </AppShell>
  );
}

function VersionDetailsPage() {
  return (
    <PanelVersion
      version="0.66.1"
      commit="2a036bb5c716b404edc2b4a8f665f5be1074f2e"
      builtAt="2026-10-06T05:57:50Z"
    />
  );
}

describe('AppShell · меню пользователя', () => {
  beforeEach(() => {
    resetMockState({ authenticated: true });
    useAuthStore.setState({ me: mockMe, hydrated: true });
    resetNavGroupState();
    resetNavigationLayout();
  });

  it('в рейле открыты основные разделы и у Уведомлений виден счётчик', async () => {
    renderPage(Page, '/', [
      '/login',
      '/lock',
      '/servers',
      '/incidents',
      '/notifications',
      '/settings',
      '/settings/security',
    ]);
    expect(await screen.findByRole('link', { name: 'Серверы' })).toHaveAttribute('href', '/servers');
    expect(screen.getByRole('link', { name: 'Обзор' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Журнал' })).toHaveAttribute('href', '/audit');
    expect(screen.getByRole('link', { name: /Инциденты/ })).toHaveAttribute('href', '/incidents');
    expect(await screen.findByRole('link', { name: /Уведомления/ })).toHaveAttribute(
      'href',
      '/notifications',
    );
    expect(screen.getByRole('link', { name: 'Настройки' })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('link', { name: 'Джарвис' })).toHaveAttribute('href', '/assistant');
    expect(screen.getByRole('link', { name: 'База знаний' })).toHaveAttribute('href', '/knowledge');
    expect(await screen.findByTestId('panel-version')).toHaveTextContent('v0.55.0');
  });

  it('«Серверы» раскрываются в «Все серверы» и «Провайдеры»; шеврон сворачивает подпункты', async () => {
    const { router } = renderPage(Page, '/', ['/login', '/lock', '/servers', '/servers/providers']);
    const toggle = await screen.findByRole('button', { name: 'Показать подпункты «Серверы»' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // вне раздела подпункты скрыты (inert) и не в фокусе
    expect(screen.getByRole('link', { name: 'Серверы' })).toHaveAttribute('href', '/servers');
    const user = userEvent.setup();
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Скрыть подпункты «Серверы»' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('link', { name: 'Все серверы' })).toHaveAttribute('href', '/servers');
    expect(screen.getByRole('link', { name: 'Провайдеры' })).toHaveAttribute('href', '/servers/providers');
    await user.click(screen.getByRole('link', { name: 'Провайдеры' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/servers/providers'));
  });

  it('клик по самому пункту «Серверы» раскрывает подпункты, переход в другой раздел их не сворачивает', async () => {
    // Каждый раздел рисует свой AppShell — меню создаётся заново при переходе, как в приложении.
    const pages = { '/servers': Page, '/incidents': Page };
    const { router } = renderPage(Page, '/', ['/servers', '/incidents'], '/', pages);
    const user = userEvent.setup();
    const toggle = () => screen.getByRole('button', { name: /подпункты «Серверы»/ });
    expect(await screen.findByRole('button', { name: 'Показать подпункты «Серверы»' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    // не на шеврон, а на сам пункт
    await user.click(screen.getByRole('link', { name: 'Серверы' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/servers'));
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-expanded', 'true'));
    // уходим в «Инциденты» — группа остаётся раскрытой
    await user.click(screen.getByRole('link', { name: /Инциденты/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/incidents'));
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-expanded', 'true'));
    // свернули руками — и это тоже запоминается при следующем переходе
    await user.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    await user.click(screen.getByRole('link', { name: 'Обзор' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-expanded', 'false'));
  });

  it('в свёрнутом рейле «Серверы» — всплывающее меню с подпунктами', async () => {
    renderPage(Page, '/', ['/login', '/lock', '/servers', '/servers/providers']);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Свернуть меню' }));
    await user.click(screen.getByRole('button', { name: 'Серверы' }));
    expect(await screen.findByRole('menuitem', { name: 'Все серверы' })).toHaveAttribute('href', '/servers');
    expect(screen.getByRole('menuitem', { name: 'Провайдеры' })).toHaveAttribute(
      'href',
      '/servers/providers',
    );
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Развернуть меню' }));
  });

  it('добавляет до пяти своих сайтов отдельным блоком и открывает ссылку в новой вкладке', async () => {
    renderPage(Page, '/', ['/login', '/lock']);
    const user = userEvent.setup();
    expect(await screen.findByText('Свои сайты')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Добавить сайт' }));
    expect(await screen.findByRole('dialog', { name: 'Свои сайты' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Добавить сайт' }));
    await user.type(screen.getByRole('textbox', { name: 'Название сайта 1' }), 'Grafana');
    await user.type(screen.getByRole('textbox', { name: 'Ссылка сайта 1' }), 'panel.example.com');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));

    const link = await screen.findByRole('link', { name: 'Grafana' });
    expect(link).toHaveAttribute('href', 'https://panel.example.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(mockCustomSites.items).toHaveLength(1);
  });

  it('режим «Сверху» заменяет сайдбар полным верхним меню с группами', async () => {
    setNavigationLayout('top');
    renderPage(Page, '/', ['/login', '/lock', '/servers', '/servers/providers']);
    expect(await screen.findByTestId('top-navigation')).toBeInTheDocument();
    expect(screen.queryByTestId('app-shell-sidebar')).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Серверы/ }));
    expect(await screen.findByRole('menuitem', { name: 'Все серверы' })).toHaveAttribute('href', '/servers');
    expect(screen.getByRole('menuitem', { name: 'Remnawave' })).toHaveAttribute('href', '/servers/remnawave');
  });

  it('вариант A: версия в шапке, а новый релиз открывает детали и команду', async () => {
    server.use(
      http.get('/api/system/release', () =>
        HttpResponse.json({
          currentVersion: '0.55.0',
          latestVersion: '0.56.0',
          status: 'available',
          checkedAt: '2026-10-02T10:00:00.000Z',
          release: {
            name: 'NodeService Panel v0.56.0',
            url: 'https://github.com/feauche/nodeservice-panel/releases/tag/v0.56.0',
            publishedAt: '2026-10-02T09:00:00.000Z',
            notes:
              '## Что изменилось\n- Надёжнее доставка.\n- Новая диагностика.\n- Пункт 3.\n- Пункт 4.\n- Пункт 5.\n- Пункт 6.\n- Пункт 7.\n- Пункт 8.\n- Пункт 9 тоже виден.',
          },
        }),
      ),
    );
    renderPage(Page, '/', ['/login', '/lock']);
    const user = userEvent.setup();
    const indicator = await screen.findByRole('button', { name: 'Доступна v0.56.0' });
    expect(indicator).toBeInTheDocument();
    await user.click(indicator);
    const dialog = await screen.findByRole('dialog', { name: 'Версия NodeService' });
    expect(dialog).toHaveTextContent('Надёжнее доставка.');
    expect(dialog).toHaveTextContent('Пункт 9 тоже виден.');
    expect(dialog).toHaveClass('h-[620px]', 'grid-rows-[auto_minmax(0,1fr)_auto]');
    expect(screen.getByTestId('panel-version-scroll')).toHaveClass('min-h-0', 'overflow-y-auto');
    expect(screen.getByText('nodeservice update')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Открыть GitHub Release' })).toHaveAttribute(
      'href',
      'https://github.com/feauche/nodeservice-panel/releases/tag/v0.56.0',
    );
  });

  it('актуальная версия открывается в компактном окне без фиксированной высоты', async () => {
    server.use(
      http.get('/api/system/release', () =>
        HttpResponse.json({
          currentVersion: '0.64.0',
          latestVersion: '0.64.0',
          status: 'current',
          checkedAt: '2026-10-06T03:00:00.000Z',
          release: {
            name: 'NodeService Panel v0.64.0',
            url: 'https://github.com/feauche/nodeservice-panel/releases/tag/v0.64.0',
            publishedAt: '2026-10-06T02:00:00.000Z',
            notes: '- Текущая версия.',
          },
        }),
      ),
    );
    renderPage(Page, '/', ['/login', '/lock']);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('panel-version'));

    const dialog = await screen.findByRole('dialog', { name: 'Версия NodeService' });
    expect(dialog).toHaveTextContent('Установлена последняя стабильная версия.');
    expect(dialog).not.toHaveClass('h-[620px]');
    expect(dialog).toHaveClass('max-h-[calc(100dvh-40px)]');
    expect(dialog).toHaveClass('sm:max-w-[620px]');
  });

  it('полный хэш сборки переносится отдельно, копируется и не ломает дату', async () => {
    renderPage(VersionDetailsPage, '/');
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('panel-version'));

    const dialog = await screen.findByRole('dialog', { name: 'Версия NodeService' });
    const buildHash = within(dialog).getByText(/^[0-9a-f]{7,40}$/i);
    expect(buildHash).toHaveClass('break-all');
    expect(within(dialog).getByRole('button', { name: 'Скопировать хэш сборки' })).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(/T\d{2}:\d{2}:\d{2}Z\.\d{2}\./);
  });

  it('мобильная шапка имеет сплошной фон без отдельного композиционного слоя', async () => {
    renderPage(Page, '/', ['/login', '/lock']);
    expect(await screen.findByTestId('app-shell-panel')).not.toHaveClass('isolate');
    expect(screen.getByRole('banner')).toHaveClass('relative', 'z-10', 'bg-background');
  });

  it('«Выйти» сначала спрашивает; logout не вызывается до «Да»', async () => {
    const logoutCalls = vi.fn();
    server.use(
      http.post('/api/auth/logout', () => {
        logoutCalls();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { router } = renderPage(Page, '/', ['/login', '/lock', '/settings', '/settings/security']);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Учётная запись' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Выйти' }));

    expect(await screen.findByRole('alertdialog', { name: 'Выйти из панели?' })).toBeInTheDocument();
    expect(logoutCalls).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Нет' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(logoutCalls).not.toHaveBeenCalled();
    expect(useAuthStore.getState().me).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Учётная запись' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Выйти' }));
    await user.click(await screen.findByRole('button', { name: 'Да, выйти' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(logoutCalls).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().me).toBeNull();
  });
});
