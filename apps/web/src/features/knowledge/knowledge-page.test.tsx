import { KB_CONTENT_MAX } from '@nodeservice/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetMockState } from '@/test/msw/handlers';
import { mockKnowledge } from '@/test/msw/knowledge-mock';
import { renderPage } from '@/test/render';
import { KnowledgePage } from './knowledge-page';

const contentField = () => screen.getByLabelText('Содержимое') as HTMLTextAreaElement;

describe('KnowledgePage', () => {
  beforeEach(() => resetMockState({ authenticated: true }));

  it('список статей и просмотр выбранной', async () => {
    renderPage(KnowledgePage, '/knowledge');
    expect(await screen.findByRole('button', { name: /Лимит conntrack/ })).toBeInTheDocument();
    // сверху закреплённые («Правила парка» обновлены позже), первая открыта автоматически — виден её markdown
    expect(await screen.findByRole('heading', { name: 'Правила парка' })).toBeInTheDocument();
    const list = screen.getAllByRole('button', {
      name: /Правила парка|Пояснения|Лимит conntrack|Перезапуск Xray/,
    });
    expect(list[0]).toHaveTextContent('Правила парка');
    expect(list[1]).toHaveTextContent('Пояснения');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Лимит conntrack/ }));
    expect(await screen.findByRole('heading', { name: 'Лимит conntrack' })).toBeInTheDocument();
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
    await user.type(contentField(), '# Проверка\n\nПинг до шлюза.');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mockKnowledge.items.some((d) => d.title === 'Проверка сети')).toBe(true));
    // после сохранения — снова просмотр статьи, а не редактор
    expect(await screen.findByRole('heading', { name: 'Проверка сети' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Содержимое')).not.toBeInTheDocument();
  });

  it('удаление активной статьи убирает её в архив, а не стирает насовсем', async () => {
    renderPage(KnowledgePage, '/knowledge');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Лимит conntrack/ }));
    await screen.findByRole('heading', { name: 'Лимит conntrack' });
    await user.click(screen.getByRole('button', { name: 'Удалить (в архив)' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'В архив' }));
    // статья не пропала из базы — она стала архивной
    await waitFor(() => {
      const doc = mockKnowledge.items.find((d) => d.title === 'Лимит conntrack');
      expect(doc?.archived).toBe(true);
    });
  });

  it('закреплённые «Правила парка» и «Пояснения»: сверху, без кнопки удаления', async () => {
    renderPage(KnowledgePage, '/knowledge');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Правила парка' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Удалить/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Пояснения/ }));
    expect(await screen.findByRole('heading', { name: 'Пояснения' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Удалить/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Лимит conntrack/ }));
    await screen.findByRole('heading', { name: 'Лимит conntrack' });
    expect(screen.getByRole('button', { name: 'Удалить (в архив)' })).toBeInTheDocument();
  });

  it('закреплённая в списке: булавка и разделитель под ней, у остальных булавки нет', async () => {
    renderPage(KnowledgePage, '/knowledge');
    const rules = await screen.findByRole('button', { name: /Правила парка/ });
    const pinned = screen.getByRole('button', { name: /Пояснения/ });
    expect(rules.querySelector('svg.lucide-pin')).not.toBeNull();
    expect(pinned.querySelector('svg.lucide-pin')).not.toBeNull();
    const other = screen.getByRole('button', { name: /Лимит conntrack/ });
    expect(other.querySelector('svg.lucide-pin')).toBeNull();
    // разделитель стоит сразу под последней закреплённой статьёй
    expect(pinned.closest('li')?.nextElementSibling?.getAttribute('aria-hidden')).toBe('true');
    expect(rules.closest('li')?.nextElementSibling?.getAttribute('aria-hidden')).not.toBe('true');
    // в карточке списка нет ни удаления, ни архива
    expect(within(pinned).queryByRole('button')).not.toBeInTheDocument();
  });

  it('в списке под названием — выдержка без повтора названия', async () => {
    renderPage(KnowledgePage, '/knowledge');
    const item = await screen.findByRole('button', { name: /Лимит conntrack/ });
    expect(item.textContent).toMatch(/^Лимит conntrackЕсли таблица/);
  });

  it('шапка статьи: бейдж источника, дата и действия', async () => {
    renderPage(KnowledgePage, '/knowledge');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Лимит conntrack/ }));
    const title = await screen.findByRole('heading', { name: 'Лимит conntrack' });
    const header = title.closest('header') as HTMLElement;
    expect(within(header).getByText('Веб')).toBeInTheDocument();
    expect(within(header).getByText(/^Обновлено /)).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Изменить' })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'История версий' })).toBeInTheDocument();
  });

  describe('«Правила парка» — пометка «Читает Джарвис»', () => {
    const BANNER =
      'Джарвис читает эту статью в начале каждой беседы и разбора инцидента, но сам не меняет. Пустые разделы он не видит.';

    it('у «Правил парка» есть пометка в шапке и плашка над текстом', async () => {
      renderPage(KnowledgePage, '/knowledge');
      const title = await screen.findByRole('heading', { name: 'Правила парка' });
      const header = title.closest('header') as HTMLElement;
      expect(within(header).getByText('Читает Джарвис')).toBeInTheDocument();
      expect(within(header).getByText('Вручную')).toBeInTheDocument();
      expect(screen.getByTestId('fleet-rules-banner')).toHaveTextContent(BANNER);
    });

    it('у других статей, в том числе закреплённой «Пояснения», пометки и плашки нет', async () => {
      renderPage(KnowledgePage, '/knowledge');
      const user = userEvent.setup();
      await screen.findByRole('heading', { name: 'Правила парка' });
      for (const title of ['Пояснения', 'Лимит conntrack']) {
        await user.click(screen.getByRole('button', { name: new RegExp(title) }));
        await screen.findByRole('heading', { name: title });
        expect(screen.queryByText('Читает Джарвис')).not.toBeInTheDocument();
        expect(screen.queryByTestId('fleet-rules-banner')).not.toBeInTheDocument();
      }
    });

    it('в списке пометки нет, она только в открытой статье', async () => {
      renderPage(KnowledgePage, '/knowledge');
      const item = await screen.findByRole('button', { name: /Правила парка/ });
      expect(within(item).queryByText('Читает Джарвис')).not.toBeInTheDocument();
    });

    it('в редакторе плашки и пометки нет', async () => {
      renderPage(KnowledgePage, '/knowledge');
      const user = userEvent.setup();
      await screen.findByTestId('fleet-rules-banner');
      await user.click(screen.getByRole('button', { name: 'Изменить' }));
      await screen.findByLabelText('Содержимое');
      expect(screen.queryByTestId('fleet-rules-banner')).not.toBeInTheDocument();
      expect(screen.queryByText('Читает Джарвис')).not.toBeInTheDocument();
    });
  });

  describe('редактор', () => {
    const openNew = async () => {
      const utils = renderPage(KnowledgePage, '/knowledge');
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Новая статья' }));
      await screen.findByLabelText('Содержимое');
      return { user, ...utils };
    };

    it('у поля фиксированная высота: без resize и авторазмера, прокрутка своя', async () => {
      await openNew();
      const cls = contentField().className;
      expect(cls).toContain('resize-none');
      expect(cls).toContain('overflow-y-auto');
      expect(cls).not.toMatch(/resize-y|resize-both|field-sizing|min-h-\[/);
    });

    it('счётчик знаков считает и предупреждает о лимите', async () => {
      const { user } = await openNew();
      expect(screen.getByText(/^0 из 100 000 знаков$/)).toBeInTheDocument();
      await user.type(contentField(), 'Привет!');
      expect(screen.getByText(/^7 из 100 000 знаков$/)).toBeInTheDocument();
    });

    it('тулбар вставляет разметку на место выделения', async () => {
      const { user } = await openNew();
      const field = contentField();
      await user.type(field, 'слово');
      field.setSelectionRange(0, 5);
      await user.click(screen.getByRole('button', { name: 'Жирный' }));
      expect(field.value).toBe('**слово**');
      // повторное нажатие снимает разметку
      await waitFor(() => expect(field.selectionStart).toBe(2));
      await user.click(screen.getByRole('button', { name: 'Жирный' }));
      expect(field.value).toBe('слово');
    });

    it('тулбар: заголовки, курсив, списки, цитата, код, таблица, ссылка, линия', async () => {
      const { user } = await openNew();
      const field = contentField();
      const click = (name: string) => user.click(screen.getByRole('button', { name }));
      const reset = async () => {
        await user.clear(field);
      };

      await click('Заголовок 2');
      expect(field.value).toBe('## Заголовок');
      await reset();

      await click('Заголовок 3');
      expect(field.value).toBe('### Заголовок');
      await reset();

      await click('Курсив');
      expect(field.value).toBe('*Текст*');
      await reset();

      await user.type(field, 'а\nб');
      field.setSelectionRange(0, 3);
      await click('Нумерованный список');
      expect(field.value).toBe('1. а\n2. б');
      await reset();

      await user.type(field, 'а');
      field.setSelectionRange(0, 1);
      await click('Цитата');
      expect(field.value).toBe('> а');
      await reset();

      await click('Код');
      expect(field.value).toBe('```\nКоманда\n```\n');
      await reset();

      await user.type(field, 'текст');
      await click('Таблица');
      expect(field.value).toBe(
        'текст\n\n| Колонка 1 | Колонка 2 |\n| --- | --- |\n| Значение | Значение |\n',
      );
      await reset();

      await click('Ссылка');
      expect(field.value).toBe('[Текст](https://)');
      await reset();

      await user.type(field, 'до');
      await click('Линия');
      expect(field.value).toBe('до\n\n---\n');
    });

    it('предпросмотр справа обновляется по мере набора', async () => {
      const { user } = await openNew();
      expect(screen.getByText('Здесь появится оформленный вид статьи.')).toBeInTheDocument();
      await user.type(contentField(), 'Это **важно**');
      await waitFor(() => expect(document.querySelector('strong')?.textContent).toBe('важно'));
      expect(screen.queryByText('Здесь появится оформленный вид статьи.')).not.toBeInTheDocument();
    });

    it('на узком экране предпросмотр — во вкладке рядом с «Текст»', async () => {
      const { user } = await openNew();
      const text = screen.getByRole('tab', { name: 'Текст' });
      const preview = screen.getByRole('tab', { name: 'Предпросмотр' });
      expect(text).toHaveAttribute('aria-selected', 'true');
      expect(preview).toHaveAttribute('aria-selected', 'false');
      await user.click(preview);
      expect(preview).toHaveAttribute('aria-selected', 'true');
      expect(text).toHaveAttribute('aria-selected', 'false');
      // текстовая панель скрыта на узком экране, но остаётся в дереве — набранное не теряется
      expect(screen.getByRole('tabpanel', { name: 'Текст' })).toHaveClass('max-md:hidden', { exact: false });
    });

    it('черновик сохраняется и предлагается к восстановлению при следующем открытии', async () => {
      const first = await openNew();
      await first.user.type(screen.getByLabelText('Заголовок'), 'Черновик сети');
      await first.user.type(contentField(), 'Половина инструкции');
      expect(
        await screen.findByText(/^Черновик сохранён в \d{2}:\d{2}$/, {}, { timeout: 3000 }),
      ).toBeInTheDocument();
      expect(localStorage.getItem('ns-kb-draft:new')).toContain('Половина инструкции');
      first.unmount();

      const second = await openNew();
      expect(await screen.findByText(/Найден несохранённый черновик/)).toBeInTheDocument();
      // пока не восстановили — поля пустые
      expect(contentField().value).toBe('');
      await second.user.click(screen.getByRole('button', { name: 'Восстановить' }));
      expect(contentField().value).toBe('Половина инструкции');
      expect((screen.getByLabelText('Заголовок') as HTMLInputElement).value).toBe('Черновик сети');
      expect(screen.queryByText(/Найден несохранённый черновик/)).not.toBeInTheDocument();
    });

    it('«Отбросить» удаляет черновик', async () => {
      const first = await openNew();
      await first.user.type(contentField(), 'Временно');
      await waitFor(() => expect(localStorage.getItem('ns-kb-draft:new')).not.toBeNull(), { timeout: 3000 });
      first.unmount();

      const second = await openNew();
      await second.user.click(await screen.findByRole('button', { name: 'Отбросить' }));
      expect(localStorage.getItem('ns-kb-draft:new')).toBeNull();
      expect(contentField().value).toBe('');
    });

    it('после сохранения черновик исчезает', async () => {
      const { user } = await openNew();
      await user.type(screen.getByLabelText('Заголовок'), 'Готовая статья');
      await user.type(contentField(), 'Текст');
      await waitFor(() => expect(localStorage.getItem('ns-kb-draft:new')).not.toBeNull(), { timeout: 3000 });
      await user.click(screen.getByRole('button', { name: 'Сохранить' }));
      await waitFor(() => expect(mockKnowledge.items.some((d) => d.title === 'Готовая статья')).toBe(true));
      await waitFor(() => expect(localStorage.getItem('ns-kb-draft:new')).toBeNull());
    });

    it('отмена с правками спрашивает подтверждение, без правок — закрывает сразу', async () => {
      const { user } = await openNew();
      await user.click(screen.getByRole('button', { name: 'Отмена' }));
      // правок не было — сразу назад, к списку
      expect(await screen.findByRole('button', { name: 'Новая статья' })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Новая статья' }));
      await user.type(await screen.findByLabelText('Содержимое'), 'Что-то');
      await user.click(screen.getByRole('button', { name: 'Отмена' }));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'Отбросить' }));
      expect(await screen.findByRole('button', { name: 'Новая статья' })).toBeInTheDocument();
      expect(localStorage.getItem('ns-kb-draft:new')).toBeNull();
    });

    it('слишком длинный текст: счётчик красный, сохранить нельзя', async () => {
      const { user } = await openNew();
      await user.type(screen.getByLabelText('Заголовок'), 'Огромная');
      const field = contentField();
      // вставка, а не набор: 100 тысяч нажатий user.type в тесте не нужны
      await user.click(field);
      await user.paste('а'.repeat(KB_CONTENT_MAX + 1));
      const counter = screen.getByText(/из 100 000 знаков/);
      expect(counter).toHaveClass('text-crit');
      expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    });

    it('редактирование существующей статьи: поля заполнены, у закреплённой название закрыто', async () => {
      renderPage(KnowledgePage, '/knowledge');
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: /Лимит conntrack/ }));
      await screen.findByRole('heading', { name: 'Лимит conntrack' });
      await user.click(screen.getByRole('button', { name: 'Изменить' }));
      expect(await screen.findByRole('heading', { name: 'Изменение статьи' })).toBeInTheDocument();
      expect(contentField().value).toContain('# Лимит conntrack');
      expect((screen.getByLabelText('Заголовок') as HTMLInputElement).value).toBe('Лимит conntrack');
      expect((screen.getByLabelText('Заголовок') as HTMLInputElement).readOnly).toBe(false);
      await user.click(screen.getByRole('button', { name: 'Отмена' }));

      await user.click(await screen.findByRole('button', { name: /Пояснения/ }));
      await screen.findByRole('heading', { name: 'Пояснения' });
      await user.click(screen.getByRole('button', { name: 'Изменить' }));
      await screen.findByRole('heading', { name: 'Изменение статьи' });
      expect((screen.getByLabelText('Заголовок') as HTMLInputElement).readOnly).toBe(true);
    });

    it('localStorage недоступен: редактор работает, черновик просто не сохраняется', async () => {
      const boom = () => {
        throw new Error('QuotaExceededError');
      };
      const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom);
      const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom);
      try {
        const { user } = await openNew();
        await user.type(contentField(), 'Пишем без хранилища');
        await new Promise((r) => setTimeout(r, 1200));
        expect(screen.queryByText(/Черновик сохранён/)).not.toBeInTheDocument();
        expect(screen.queryByText(/Найден несохранённый черновик/)).not.toBeInTheDocument();
        expect(contentField().value).toBe('Пишем без хранилища');
      } finally {
        set.mockRestore();
        get.mockRestore();
      }
    });
  });
});
