import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetMockState } from '@/test/msw/handlers';
import { mockKnowledge } from '@/test/msw/knowledge-mock';
import { renderPage } from '@/test/render';
import { KnowledgePage } from './knowledge-page';

describe('KnowledgePage', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('список статей и просмотр выбранной', async () => {
    renderPage(KnowledgePage, '/knowledge');
    expect(await screen.findByRole('button', { name: /Лимит conntrack/ })).toBeInTheDocument();
    // первая статья открыта автоматически — виден её markdown
    expect(await screen.findByRole('heading', { name: 'Лимит conntrack' })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Перезапуск Xray/ }));
    expect(await screen.findByRole('heading', { name: 'Перезапуск Xray' })).toBeInTheDocument();
  });

  it('поиск фильтрует список', async () => {
    renderPage(KnowledgePage, '/knowledge');
    await screen.findByRole('button', { name: /Лимит conntrack/ });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Поиск по базе знаний'), 'диск');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Лимит conntrack/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /Очистка диска/ })).toBeInTheDocument();
  });

  it('создание новой статьи добавляет её в базу', async () => {
    renderPage(KnowledgePage, '/knowledge');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Новая статья' }));
    await user.type(screen.getByLabelText('Заголовок'), 'Проверка сети');
    await user.type(screen.getByLabelText('Содержимое'), '# Проверка\n\nПинг до шлюза.');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockKnowledge.items.some((d) => d.title === 'Проверка сети')).toBe(true));
  });

  it('удаление активной статьи убирает её в архив, а не стирает насовсем', async () => {
    renderPage(KnowledgePage, '/knowledge');
    await screen.findByRole('heading', { name: 'Лимит conntrack' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Удалить (в архив)' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'В архив' }));
    // статья не пропала из базы — она стала архивной
    await waitFor(() => {
      const doc = mockKnowledge.items.find((d) => d.title === 'Лимит conntrack');
      expect(doc?.archived).toBe(true);
    });
  });
});
