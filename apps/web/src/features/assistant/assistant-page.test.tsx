import { ASSISTANT_MESSAGE_MAX, type AssistantMessage } from '@nodeservice/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useServerModalStore } from '@/features/servers/server-modal-store';
import { mockAssistant } from '@/test/msw/assistant-mock';
import { resetMockState } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { mockServers } from '@/test/msw/servers-mock';
import { renderPage } from '@/test/render';
import { LAST_CONV_KEY } from './assistant-api';
import { AssistantPage } from './assistant-page';

describe('AssistantPage', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('без ключа: блок «выключен» со ссылкой на настройки', async () => {
    mockAssistant.enabled = false;
    renderPage(AssistantPage, '/assistant');
    expect(await screen.findByText('Джарвис выключен')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Настройки → Джарвис/ })).toBeInTheDocument();
  });

  it('с ключом: сообщение получает ответ с цитатой и предложением', async () => {
    mockAssistant.enabled = true;
    renderPage(AssistantPage, '/assistant');
    const user = userEvent.setup();
    const input = await screen.findByLabelText('Сообщение Джарвису');
    await user.type(input, 'Что с CPU?');
    await user.click(screen.getByRole('button', { name: 'Отправить' }));
    // ответ Джарвиса с предложением автопочинки
    expect(await screen.findByText('Перезапустить контейнер ноды')).toBeInTheDocument();
    const card = screen.getByTestId('proposal-card');
    expect(within(card).getByText('T2')).toBeInTheDocument();
    expect(within(card).getByText(/Почему:/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Выполнить' })).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Открыть инцидент' })).toBeInTheDocument();
    // цитата на базу знаний ведёт на конкретную статью (?open=<id>), а не просто в раздел
    const kbLink = screen.getByRole('link', { name: /Лимит conntrack/ });
    expect(kbLink.getAttribute('href')).toContain('open=');
  });

  it('изменения по подтверждению: Джарвис присылает карточки, применение делается кнопкой в самой карточке', async () => {
    mockAssistant.enabled = true;
    renderPage(AssistantPage, '/assistant');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Сообщение Джарвису'), 'предложи изменения');
    await user.click(screen.getByRole('button', { name: 'Отправить' }));
    const cards = await screen.findAllByTestId('change-card');
    expect(cards).toHaveLength(3);
    for (const c of cards) await within(c).findByRole('button', { name: 'Применить' });
    expect(
      cards.map(
        (c) =>
          within(c).getByText(/^(Сменить провайдера|Изменить теги|Изменить профиль сервера)$/).textContent,
      ),
    ).toEqual(['Сменить провайдера', 'Изменить теги', 'Изменить профиль сервера']);
    expect(screen.queryByTestId('proposal-card')).not.toBeInTheDocument();
    await user.click(within(cards[0] as HTMLElement).getByRole('button', { name: 'Применить' }));
    await within(cards[0] as HTMLElement).findByText('Применено');
    // остальные ждут своего решения: «Применить всё» нет
    expect(within(cards[1] as HTMLElement).getByRole('button', { name: 'Применить' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /Применить всё/ })).not.toBeInTheDocument();
  });

  it('без разрешения на изменения Джарвис карточек изменений не присылает', async () => {
    mockAssistant.enabled = true;
    mockAssistant.permissions = { ...mockAssistant.permissions, changes: false };
    renderPage(AssistantPage, '/assistant');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Сообщение Джарвису'), 'предложи изменения');
    await user.click(screen.getByRole('button', { name: 'Отправить' }));
    await screen.findByTestId('proposal-card');
    expect(screen.queryByTestId('change-card')).not.toBeInTheDocument();
  });

  it('имя сервера в ответе — ссылка: клик открывает карточку сервера', async () => {
    mockAssistant.enabled = true;
    useServerModalStore.getState().close();
    renderPage(AssistantPage, '/assistant');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Сообщение Джарвису'), 'Что с CPU?');
    await user.click(screen.getByRole('button', { name: 'Отправить' }));
    const link = await within(await screen.findByTestId('assistant-messages')).findByRole('button', {
      name: 'de-fra-01',
    });
    await user.click(link);
    expect(useServerModalStore.getState().serverId).toBe(
      mockServers.items.find((x) => x.name === 'de-fra-01')?.id,
    );
  });

  describe('ответ без пузыря, несколько сообщений, источники', () => {
    const ask = async (text: string) => {
      mockAssistant.enabled = true;
      useServerModalStore.getState().close();
      renderPage(AssistantPage, '/assistant');
      const user = userEvent.setup();
      await user.type(await screen.findByLabelText('Сообщение Джарвису'), text);
      await user.click(screen.getByRole('button', { name: 'Отправить' }));
      const list = await screen.findByTestId('assistant-messages');
      await within(list).findByText(/Инциденты по серверам за всё время/);
      return { user, list };
    };
    const idOf = (name: string) => mockServers.items.find((x) => x.name === name)?.id;

    it('имя сервера в ответе с точкой состояния: в норме — ok, SSH не отвечает — crit', async () => {
      const { list } = await ask('а по каким серверам больше инцидентов');
      // Чип в «Основано на:» тоже кнопка с этим именем, но без точки — берём ссылку из текста.
      const dotOf = (name: string) =>
        within(list)
          .getAllByRole('button', { name })
          .map((b) => b.querySelector('[data-health]'))
          .find(Boolean)
          ?.getAttribute('data-health');
      await waitFor(() => expect(dotOf('de-fra-01')).toBe('ok'));
      expect(dotOf('nl-ams-02')).toBe('crit');
    });

    it('точка у имени: SSH не пустил при живом агенте — «внимание»; остановленная нода — «сбой», не «офлайн»', async () => {
      const [first, second] = mockServers.items;
      if (!first || !second) throw new Error('нет мок-серверов');
      mockServers.items = [
        { ...first, sshOk: false },
        { ...second, sshOk: true, agentStatus: 'online', node: 'stopped' },
      ];
      const { list } = await ask('а по каким серверам больше инцидентов');
      const linkOf = (name: string) =>
        within(list)
          .getAllByRole('button', { name })
          .find((b) => b.querySelector('[data-health]'));
      await waitFor(() =>
        expect(linkOf('de-fra-01')?.querySelector('[data-health]')?.getAttribute('data-health')).toBe('warn'),
      );
      expect(linkOf('de-fra-01')).toHaveAttribute('title', 'Требует внимания');
      expect(linkOf('nl-ams-02')?.querySelector('[data-health]')?.getAttribute('data-health')).toBe('crit');
      expect(linkOf('nl-ams-02')).toHaveAttribute('title', 'Сбой');
      expect(within(list).queryByTitle(/офлайн/i)).not.toBeInTheDocument();
    });

    it('клик по имени с точкой открывает карточку сервера', async () => {
      const { user, list } = await ask('а по каким серверам больше инцидентов');
      await user.click(await within(list).findByRole('button', { name: 'nl-ams-02' }));
      expect(useServerModalStore.getState().serverId).toBe(idOf('nl-ams-02'));
    });

    it('два ответа подряд: значок Джарвиса только у первого, «сейчас посмотрю» приглушено', async () => {
      const { list } = await ask('а по каким серверам больше инцидентов');
      expect(within(list).getAllByTestId('assistant-avatar')).toHaveLength(1);
      const interim = within(list).getByText('Смотрю историю инцидентов за всё время.');
      expect(interim.closest('div')?.className).toContain('[&_p]:text-text-3');
    });

    it('«Основано на:» — одна строка на ответ и только если есть источники', async () => {
      const { list } = await ask('а по каким серверам больше инцидентов');
      expect(within(list).getAllByText('Основано на:')).toHaveLength(1);
    });

    it('без источников строки «Основано на:» нет', async () => {
      mockAssistant.enabled = true;
      renderPage(AssistantPage, '/assistant');
      const user = userEvent.setup();
      await user.type(await screen.findByLabelText('Сообщение Джарвису'), 'Сервер доступен снаружи?');
      await user.click(screen.getByRole('button', { name: 'Отправить' }));
      await screen.findByTestId('reachability-card');
      expect(screen.queryByText('Основано на:')).not.toBeInTheDocument();
    });

    it('чип сервера в источниках открывает карточку', async () => {
      const { user, list } = await ask('а по каким серверам больше инцидентов');
      const sources = await within(list).findByTestId('assistant-sources');
      await user.click(within(sources).getByRole('button', { name: 'de-fra-01' }));
      expect(useServerModalStore.getState().serverId).toBe(idOf('de-fra-01'));
    });
  });

  it('вопрос про доступность: под ответом матрица проверки снаружи', async () => {
    mockAssistant.enabled = true;
    renderPage(AssistantPage, '/assistant');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Сообщение Джарвису'), 'Сервер доступен снаружи?');
    await user.click(screen.getByRole('button', { name: 'Отправить' }));
    const card = await screen.findByTestId('reachability-card');
    expect(within(card).getByText(/Доступность de-fra-01 снаружи/)).toBeInTheDocument();
    expect(within(card).getByText('443: нет ответа с 3 проверенных точек')).toBeInTheDocument();
  });

  it('чип-подсказка отправляет вопрос', async () => {
    mockAssistant.enabled = true;
    renderPage(AssistantPage, '/assistant');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Что сейчас требует внимания?' }));
    // появляется пузырь пользователя с этим текстом
    await waitFor(() =>
      expect(screen.getAllByText('Что сейчас требует внимания?').length).toBeGreaterThan(0),
    );
    expect(await screen.findByText('Перезапустить контейнер ноды')).toBeInTheDocument();
  });

  it('режима «Анализ» нет: одно поле для всего, кнопка «Отправить», подсказка про статьи и термины', async () => {
    mockAssistant.enabled = true;
    renderPage(AssistantPage, '/assistant');
    const input = await screen.findByLabelText('Сообщение Джарвису');
    expect(screen.queryByRole('button', { name: 'Анализ' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Собрать статью' })).not.toBeInTheDocument();
    expect(input).toHaveAttribute('placeholder', 'Спросите или вставьте текст…');
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeInTheDocument();
    expect(
      screen.getByText(/Статью Джарвис сохранит в базу знаний, термины добавит в «Пояснения»/),
    ).toBeInTheDocument();
  });

  it('высота пустого поля не зависит от подсказки: с первой буквой чат не подпрыгивает', async () => {
    // В jsdom нет вёрстки: имитируем браузер, где длинная подсказка переносится и раздувает пустое поле.
    const orig = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
    Object.defineProperty(Element.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        const el = this as HTMLElement;
        return el.tagName === 'TEXTAREA' ? ((el as HTMLTextAreaElement).placeholder ? 52 : 30) : 0;
      },
    });
    try {
      mockAssistant.enabled = true;
      renderPage(AssistantPage, '/assistant');
      const user = userEvent.setup();
      const input = await screen.findByLabelText('Сообщение Джарвису');
      expect(input.style.height).toBe('30px');
      expect(input).toHaveAttribute('placeholder', 'Спросите или вставьте текст…');
      await user.type(input, 'п');
      expect(input.style.height).toBe('30px');
    } finally {
      if (orig) Object.defineProperty(Element.prototype, 'scrollHeight', orig);
    }
  });

  describe('«Джарвис думает» и переходы между разделами', () => {
    const typing = () => screen.queryByRole('status', { name: 'Джарвис думает' });
    // Тестовый роутер не знает про «/other» в типах приложения.
    const go = async (router: unknown, to: string) => {
      await act(async () => {
        await (router as { navigate: (o: { to: string }) => Promise<unknown> }).navigate({ to });
      });
    };
    const setup = () => {
      try {
        localStorage.clear();
      } catch {
        // без localStorage тест не имеет смысла, но и падать не должен
      }
      mockAssistant.enabled = true;
      return renderPage(AssistantPage, '/assistant', ['/other'], '/assistant', {
        '/other': () => <div data-testid="other-page" />,
      });
    };
    const ask = async (text: string) => {
      const user = userEvent.setup();
      await user.type(await screen.findByLabelText('Сообщение Джарвису'), text);
      await user.keyboard('{Enter}');
    };

    it('в существующей беседе индикатор остаётся после ухода и возврата и пропадает вместе с ответом', async () => {
      const { router } = setup();
      await ask('Первый вопрос');
      await waitFor(() => expect(Object.values(mockAssistant.messages)[0]?.length).toBeGreaterThanOrEqual(2));
      mockAssistant.chatDelayMs = 900;
      await ask('Второй вопрос');
      expect(await screen.findByRole('status', { name: 'Джарвис думает' })).toBeInTheDocument();

      await go(router, '/other');
      await screen.findByTestId('other-page');
      expect(typing()).toBeNull();
      await go(router, '/assistant');

      // Запрос ещё идёт: индикатор на месте сразу, поле ввода занято, вопрос показан один раз.
      expect(await screen.findByRole('status', { name: 'Джарвис думает' })).toBeInTheDocument();
      expect(await screen.findByLabelText('Сообщение Джарвису')).toBeDisabled();
      await waitFor(() => expect(screen.getAllByText('Второй вопрос')).toHaveLength(1));

      // Ответ пришёл: индикатора нет, поле свободно.
      await waitFor(() => expect(typing()).toBeNull(), { timeout: 4000 });
      await waitFor(() => expect(screen.getByLabelText('Сообщение Джарвису')).not.toBeDisabled());
      expect(screen.getAllByText('Второй вопрос')).toHaveLength(1);
      expect(Object.values(mockAssistant.messages)[0]?.length).toBe(4);
    });

    it('в новом чате после возврата виден вопрос и индикатор, а по готовности открывается созданная беседа', async () => {
      const { router } = setup();
      mockAssistant.chatDelayMs = 900;
      await ask('Вопрос в новом чате');
      expect(await screen.findByRole('status', { name: 'Джарвис думает' })).toBeInTheDocument();

      await go(router, '/other');
      await screen.findByTestId('other-page');
      await go(router, '/assistant');

      expect(await screen.findByRole('status', { name: 'Джарвис думает' })).toBeInTheDocument();
      await waitFor(() =>
        expect(
          within(screen.getByTestId('assistant-messages')).getAllByText('Вопрос в новом чате'),
        ).toHaveLength(1),
      );
      await waitFor(() =>
        expect(
          screen.queryByText('Спросите об инцидентах, серверах или о том, как что-то починить'),
        ).toBeNull(),
      );

      await waitFor(() => expect(typing()).toBeNull(), { timeout: 4000 });
      // Беседа открылась сама: вопрос показан из истории, ответ на месте, поле свободно.
      await waitFor(() =>
        expect(
          within(screen.getByTestId('assistant-messages')).getAllByText('Вопрос в новом чате'),
        ).toHaveLength(1),
      );
      await waitFor(() => expect(Object.values(mockAssistant.messages)[0]?.length).toBe(2));
      await waitFor(() => expect(screen.getByLabelText('Сообщение Джарвису')).not.toBeDisabled());
    });

    it('индикатор есть только у той беседы, где идёт запрос', async () => {
      const { router } = setup();
      await ask('Вопрос про первую беседу');
      await waitFor(() => expect(Object.values(mockAssistant.messages)[0]?.length).toBeGreaterThanOrEqual(2));
      await waitFor(() => expect(screen.getByLabelText('Сообщение Джарвису')).not.toBeDisabled());
      mockAssistant.chatDelayMs = 900;
      await ask('Ещё вопрос');
      expect(await screen.findByRole('status', { name: 'Джарвис думает' })).toBeInTheDocument();
      // Новый чат рядом не думает и принимает вопросы.
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Новый чат' }));
      expect(typing()).toBeNull();
      expect(screen.getByLabelText('Сообщение Джарвису')).not.toBeDisabled();
      await go(router, '/other');
      await waitFor(
        () => expect(mockAssistant.messages[mockAssistant.conversations[0]?.id ?? '']?.length).toBe(4),
        {
          timeout: 4000,
        },
      );
    });
  });

  describe('узкий экран (телефон и планшет): «Новый чат» и «История» в шапке чата', () => {
    const iso = new Date().toISOString();
    const say = (id: string, role: 'user' | 'assistant', content: string): AssistantMessage => ({
      id,
      role,
      content,
      citations: [],
      proposals: [],
      reachability: [],
      activity: [],
      createdAt: iso,
    });
    const OLD = '0192f000-0000-7000-8000-000000000b01';
    const OTHER = '0192f000-0000-7000-8000-000000000b02';
    const seed = () => {
      mockAssistant.enabled = true;
      mockAssistant.conversations = [
        { id: OLD, title: 'Нагрузка на серверах вечером', createdAt: iso },
        { id: OTHER, title: 'Почему упал de-fra-01', createdAt: iso },
      ];
      mockAssistant.messages = {
        [OLD]: [
          say('0192f000-0000-7000-8000-000000000c01', 'user', 'Нагрузка на серверах вечером'),
          say('0192f000-0000-7000-8000-000000000c02', 'assistant', 'Под нагрузкой один сервер из трёх.'),
        ],
        [OTHER]: [
          say('0192f000-0000-7000-8000-000000000c03', 'user', 'Почему упал de-fra-01'),
          say('0192f000-0000-7000-8000-000000000c04', 'assistant', 'Нода остановилась после обновления.'),
        ],
      };
    };
    const media = window.matchMedia;
    beforeEach(() => {
      // Окно уже 1024 px: запрос «от ширины lg» не совпадает — как на телефоне 390 px и планшете до 1023 px.
      window.matchMedia = ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia;
    });
    afterEach(() => {
      window.matchMedia = media;
    });
    /** Tailwind-класс hidden без префикса — display: none на узком экране (jsdom стилей не считает). */
    const hiddenOnPhone = (el: HTMLElement) => el.closest('.hidden') !== null;

    it('обе кнопки на виду, а боковой колонки со списком бесед нет', async () => {
      seed();
      renderPage(AssistantPage, '/assistant');
      await screen.findByLabelText('Сообщение Джарвису');
      const newChat = screen.getByRole('button', { name: 'Новый чат' });
      expect(hiddenOnPhone(newChat)).toBe(false);
      const history = screen.getByRole('button', { name: 'История' });
      expect(hiddenOnPhone(history)).toBe(false);
      expect(screen.queryByRole('button', { name: 'Нагрузка на серверах вечером' })).toBeNull();
    });

    it('«История» открывает список бесед; выбор беседы открывает её и закрывает список', async () => {
      seed();
      renderPage(AssistantPage, '/assistant');
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'История' }));
      const sheet = await screen.findByRole('dialog', { name: 'История бесед' });
      expect(within(sheet).getByRole('button', { name: 'Нагрузка на серверах вечером' })).toBeInTheDocument();
      await user.click(within(sheet).getByRole('button', { name: 'Почему упал de-fra-01' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      const list = screen.getByTestId('assistant-messages');
      expect(await within(list).findByText('Нода остановилась после обновления.')).toBeInTheDocument();
      // Открытая беседа подписана в шапке и отмечена в списке.
      expect(screen.getByTestId('assistant-conversation-title')).toHaveTextContent('Почему упал de-fra-01');
      await user.click(screen.getByRole('button', { name: 'История' }));
      const again = await screen.findByRole('dialog', { name: 'История бесед' });
      expect(within(again).getByRole('button', { name: 'Почему упал de-fra-01' })).toHaveAttribute(
        'aria-current',
        'true',
      );
    });

    it('«Новый чат» уводит из прошлой беседы, открытой при входе, к чистому листу', async () => {
      seed();
      localStorage.setItem(LAST_CONV_KEY, OLD);
      renderPage(AssistantPage, '/assistant');
      const list = await screen.findByTestId('assistant-messages');
      expect(await within(list).findByText('Под нагрузкой один сервер из трёх.')).toBeInTheDocument();
      // В шапке видно, что открыта прошлая беседа, а не новый чат.
      expect(screen.getByTestId('assistant-conversation-title')).toHaveTextContent(
        'Нагрузка на серверах вечером',
      );
      const user = userEvent.setup();
      const newChat = screen.getByRole('button', { name: 'Новый чат' });
      expect(hiddenOnPhone(newChat)).toBe(false);
      await user.click(newChat);
      expect(
        await screen.findByText('Спросите об инцидентах, серверах или о том, как что-то починить'),
      ).toBeInTheDocument();
      expect(within(list).queryByText('Под нагрузкой один сервер из трёх.')).toBeNull();
      expect(screen.queryByTestId('assistant-conversation-title')).toBeNull();
      expect(localStorage.getItem(LAST_CONV_KEY)).toBeNull();
    });

    it('на широком экране всё как раньше: список бесед слева, шапки с «Историей» нет', async () => {
      window.matchMedia = media;
      seed();
      renderPage(AssistantPage, '/assistant');
      expect(await screen.findByRole('button', { name: 'Нагрузка на серверах вечером' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Новый чат' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'История' })).toBeNull();
    });
  });

  it('слишком длинный текст: кнопка заблокирована, счётчик и пояснение на виду', async () => {
    mockAssistant.enabled = true;
    renderPage(AssistantPage, '/assistant');
    const user = userEvent.setup();
    const input = await screen.findByLabelText('Сообщение Джарвису');
    await user.click(input);
    await user.paste('а'.repeat(ASSISTANT_MESSAGE_MAX + 1));
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled();
    expect(
      screen.getByText('Текст длиннее предела: разбейте его на части и отправьте по очереди.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/100 001 \/ 100 000/)).toBeInTheDocument();
    // в пределе отправка снова доступна
    await user.clear(input);
    await user.paste('Что с CPU?');
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled();
  });

  it('длинную статью можно отправить целиком: предел один на все сообщения', async () => {
    mockAssistant.enabled = true;
    renderPage(AssistantPage, '/assistant');
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('Сообщение Джарвису'));
    await user.paste(`Что с CPU? ${'б'.repeat(30_000)}`);
    await user.click(screen.getByRole('button', { name: 'Отправить' }));
    expect(await screen.findByText('Перезапустить контейнер ноды')).toBeInTheDocument();
  });

  it('многострочное сообщение сохраняет абзацы и отступы в запросе и пузыре', async () => {
    mockAssistant.enabled = true;
    renderPage(AssistantPage, '/assistant');
    const user = userEvent.setup();
    const message = 'Проверь два пункта:\n\n  1. Первый сервер\n  2. Второй сервер\n\nНе объединяй строки.';
    await user.click(await screen.findByLabelText('Сообщение Джарвису'));
    await user.paste(message);
    await user.click(screen.getByRole('button', { name: 'Отправить' }));

    const bubbles = await screen.findAllByTestId('assistant-user-message');
    const bubble = bubbles.at(-1);
    expect(bubble).toHaveTextContent(message, { normalizeWhitespace: false });
    expect(bubble).toHaveClass('whitespace-pre-wrap', 'break-words');
    await waitFor(() => {
      const saved = Object.values(mockAssistant.messages)
        .flat()
        .find((item) => item.role === 'user');
      expect(saved?.content).toBe(message);
    });
  });

  it('оптимистичный пузырь не гаснет, если такой же текст уже есть в истории', async () => {
    // Регрессия: раньше пузырь снимался по совпадению текста, и повтор того же вопроса
    // (частый случай для быстрых вопросов) гас до ответа. Снимаем только по приросту истории.
    mockAssistant.enabled = true;
    const convId = '0192f000-0000-7000-8000-000000000abc';
    const question = 'Повторяющийся вопрос';
    const iso = new Date().toISOString();
    mockAssistant.conversations = [{ id: convId, title: question, createdAt: iso }];
    mockAssistant.messages = {
      [convId]: [
        {
          id: '0192f000-0000-7000-8000-000000000a01',
          role: 'user',
          content: question,
          citations: [],
          proposals: [],
          reachability: [],
          activity: [],
          createdAt: iso,
        },
        {
          id: '0192f000-0000-7000-8000-000000000a02',
          role: 'assistant',
          content: 'Первый ответ.',
          citations: [],
          proposals: [],
          reachability: [],
          activity: [],
          createdAt: iso,
        },
      ],
    };

    // Ответ на новый запрос держим «в воздухе», чтобы поймать состояние генерации.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    server.use(
      http.post('/api/assistant/chat', async () => {
        await gate;
        const reply = {
          id: '0192f000-0000-7000-8000-000000000a04',
          role: 'assistant' as const,
          content: 'Второй ответ.',
          citations: [],
          proposals: [],
          reachability: [],
          activity: [],
          createdAt: iso,
        };
        mockAssistant.messages[convId] = [
          ...(mockAssistant.messages[convId] ?? []),
          {
            id: '0192f000-0000-7000-8000-000000000a03',
            role: 'user',
            content: question,
            citations: [],
            proposals: [],
            reachability: [],
            activity: [],
            createdAt: iso,
          },
          reply,
        ];
        return HttpResponse.json({ conversationId: convId, message: reply, messages: [reply] });
      }),
    );

    renderPage(AssistantPage, '/assistant');
    const user = userEvent.setup();
    const bubbles = () => within(screen.getByTestId('assistant-messages')).queryAllByText(question);

    // Открываем беседу, где такой вопрос уже есть (один пузырь).
    await user.click(await screen.findByRole('button', { name: question }));
    await waitFor(() => expect(bubbles()).toHaveLength(1));

    // Отправляем ровно тот же текст — во время генерации пузырь должен остаться (итого два).
    await user.type(screen.getByLabelText('Сообщение Джарвису'), question);
    await user.click(screen.getByRole('button', { name: 'Отправить' }));
    await waitFor(() => expect(bubbles()).toHaveLength(2));

    // После ответа — по-прежнему два реальных пузыря пользователя.
    release();
    expect(await screen.findByText('Второй ответ.')).toBeInTheDocument();
    expect(bubbles()).toHaveLength(2);
  });
});
