import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { mockAssistant } from '@/test/msw/assistant-mock';
import { resetMockState } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderPage } from '@/test/render';
import { AssistantPage } from './assistant-page';

describe('AssistantPage', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('без ключа: блок «выключен» со ссылкой на настройки', async () => {
    mockAssistant.enabled = false;
    renderPage(AssistantPage, '/assistant');
    expect(await screen.findByText('AI-ассистент выключен')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Настройки → Ассистент/ })).toBeInTheDocument();
  });

  it('с ключом: сообщение получает ответ с цитатой и предложением', async () => {
    mockAssistant.enabled = true;
    renderPage(AssistantPage, '/assistant');
    const user = userEvent.setup();
    const input = await screen.findByLabelText('Сообщение ассистенту');
    await user.type(input, 'Что с CPU?');
    await user.click(screen.getByRole('button', { name: 'Отправить' }));
    // ответ ассистента с предложением автопочинки
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

  it('вопрос про доступность: под ответом матрица проверки снаружи', async () => {
    mockAssistant.enabled = true;
    renderPage(AssistantPage, '/assistant');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Сообщение ассистенту'), 'Сервер доступен снаружи?');
    await user.click(screen.getByRole('button', { name: 'Отправить' }));
    const card = await screen.findByTestId('reachability-card');
    expect(within(card).getByText(/Доступность de-fra-01 снаружи/)).toBeInTheDocument();
    expect(within(card).getByText('443: закрыт со всех')).toBeInTheDocument();
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

  it('режим «Анализ»: собирает статью и показывает ссылку на неё', async () => {
    mockAssistant.enabled = true;
    renderPage(AssistantPage, '/assistant');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Анализ' }));
    await user.type(screen.getByLabelText('Текст для анализа'), 'Скопированная страница про Reality');
    await user.click(screen.getByRole('button', { name: 'Собрать статью' }));
    expect(await screen.findByRole('link', { name: /Настройка Xray Reality/ })).toBeInTheDocument();
  });

  it('оптимистичный пузырь не гаснет, если такой же текст уже есть в истории', async () => {
    // Регрессия: раньше пузырь снимался по совпадению текста, и повтор того же вопроса
    // (частый случай для быстрых вопросов) гас до ответа. Снимаем только по приросту истории.
    mockAssistant.enabled = true;
    const convId = '0192f000-0000-7000-8000-000000000abc';
    const question = 'Повторяющийся вопрос';
    const iso = new Date().toISOString();
    mockAssistant.conversations = [{ id: convId, title: question, mode: 'agent', createdAt: iso }];
    mockAssistant.messages = {
      [convId]: [
        {
          id: '0192f000-0000-7000-8000-000000000a01',
          role: 'user',
          content: question,
          citations: [],
          proposals: [],
          reachability: [],
          createdAt: iso,
        },
        {
          id: '0192f000-0000-7000-8000-000000000a02',
          role: 'assistant',
          content: 'Первый ответ.',
          citations: [],
          proposals: [],
          reachability: [],
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
            createdAt: iso,
          },
          reply,
        ];
        return HttpResponse.json({ conversationId: convId, message: reply });
      }),
    );

    renderPage(AssistantPage, '/assistant');
    const user = userEvent.setup();
    const bubbles = () => within(screen.getByTestId('assistant-messages')).queryAllByText(question);

    // Открываем беседу, где такой вопрос уже есть (один пузырь).
    await user.click(await screen.findByRole('button', { name: question }));
    await waitFor(() => expect(bubbles()).toHaveLength(1));

    // Отправляем ровно тот же текст — во время генерации пузырь должен остаться (итого два).
    await user.type(screen.getByLabelText('Сообщение ассистенту'), question);
    await user.click(screen.getByRole('button', { name: 'Отправить' }));
    await waitFor(() => expect(bubbles()).toHaveLength(2));

    // После ответа — по-прежнему два реальных пузыря пользователя.
    release();
    expect(await screen.findByText('Второй ответ.')).toBeInTheDocument();
    expect(bubbles()).toHaveLength(2);
  });
});
