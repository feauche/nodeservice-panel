import { KB_SOURCE_LABELS, KB_SOURCES, type KbSource, kbDocCreateSchema } from '@nodeservice/shared';
import {
  ArchiveRestoreIcon,
  BookOpenIcon,
  GlobeIcon,
  HistoryIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  SendIcon,
  SparklesIcon,
  Trash2Icon,
  UserRoundIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Pill } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  useCreateKbDoc,
  useDeleteKbDoc,
  useKbDoc,
  useKbList,
  useKbVersions,
  useRevertKbDoc,
  useUpdateKbDoc,
} from './knowledge-api';
import { Markdown, type TocItem, tocFromMarkdown } from './markdown';

const VERSION_REASON: Record<string, string> = {
  edit: 'Правка',
  revert: 'Откат',
  review: 'Ревизия',
};
const fmtVersionTime = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const fmtDate = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });

const SOURCE_META: Record<KbSource, { cls: string; Icon: typeof GlobeIcon }> = {
  self: { cls: 'kb-src-self', Icon: UserRoundIcon },
  ai: { cls: 'kb-src-ai', Icon: SparklesIcon },
  web: { cls: 'kb-src-web', Icon: GlobeIcon },
  telegram: { cls: 'kb-src-tg', Icon: SendIcon },
};

/** Бейдж источника статьи — откуда взята информация. compact — только иконка (для списка). */
function SourceBadge({ source, compact }: { source: KbSource; compact?: boolean }) {
  const { cls, Icon } = SOURCE_META[source];
  const label = KB_SOURCE_LABELS[source];
  return (
    <span
      className={cn('kb-src', cls, compact && 'kb-src-compact')}
      title={compact ? `Источник: ${label}` : undefined}
    >
      <Icon className="size-3" aria-hidden="true" />
      {compact ? <span className="sr-only">{label}</span> : label}
    </span>
  );
}

type Selection = { mode: 'view'; id: string } | { mode: 'edit'; id: string } | { mode: 'new' } | null;

export function KnowledgePage({
  openId,
  onOpen,
}: {
  /** Открыть конкретную статью по ссылке (?open=<id>) — из цитаты ассистента. */
  openId?: string | undefined;
  onOpen?: ((id: string | undefined) => void) | undefined;
}) {
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const list = useKbList(q, archived);
  const items = list.data?.items ?? [];

  const selectedId = selection && 'id' in selection ? selection.id : null;

  // Ссылка ?open=<id> — открываем именно эту статью (например, клик по чипу-цитате в ассистенте).
  useEffect(() => {
    if (openId) setSelection({ mode: 'view', id: openId });
  }, [openId]);

  // Иначе — автовыбор первой статьи, если ничего не выбрано.
  useEffect(() => {
    if (!openId && !selection && items.length > 0 && items[0])
      setSelection({ mode: 'view', id: items[0].id });
  }, [items, selection, openId]);

  /** Выбор статьи в списке — обновляем и URL, чтобы ссылку можно было переслать/обновить. */
  const openArticle = (id: string) => {
    setSelection({ mode: 'view', id });
    onOpen?.(id);
  };

  return (
    <div className="flex h-[calc(100dvh-150px)] min-h-[460px] flex-col gap-4">
      <div className="flex-none">
        <h1 className="text-[23px]">База знаний</h1>
        <p className="mt-[5px] text-[13.5px] text-text-2">
          Инструкции и решения — их знает и применяет ассистент
        </p>
      </div>
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        {/* Боковая колонка */}
        <aside className="flex h-full min-h-0 flex-col gap-3 rounded-2xl border border-border bg-surface p-3">
          <div className="flex items-center gap-2 rounded-[10px] border border-border bg-surface-2 px-3">
            <SearchIcon className="size-4 flex-none text-text-3" aria-hidden="true" />
            <Input
              aria-label="Поиск по базе знаний"
              placeholder="Поиск по базе…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="h-9 border-0 bg-transparent px-0 text-[13px] focus-visible:ring-0 dark:bg-transparent"
            />
          </div>
          <Button
            type="button"
            onClick={() => setSelection({ mode: 'new' })}
            className="h-9 rounded-[10px] bg-brand-soft text-brand hover:brightness-105"
          >
            <PlusIcon className="size-4" aria-hidden="true" />
            Новая статья
          </Button>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {list.isPending && (
              <div className="flex flex-col gap-1.5">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-9 rounded-[8px]" />
                ))}
              </div>
            )}
            {!list.isPending && items.length === 0 && (
              <p className="px-2 py-6 text-center text-[12.5px] text-text-3">
                {q ? 'Ничего не найдено.' : archived ? 'В архиве пусто.' : 'Статей пока нет.'}
              </p>
            )}
            <ul className="flex flex-col gap-0.5">
              {items.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => openArticle(d.id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-[8px] px-2.5 py-2 text-left text-[12.5px] transition-colors',
                      selectedId === d.id
                        ? 'bg-brand-soft font-semibold text-brand'
                        : 'text-text-2 hover:bg-surface-2 hover:text-foreground',
                    )}
                  >
                    <span
                      className={cn(
                        'size-1.5 flex-none rounded-full',
                        selectedId === d.id ? 'bg-brand' : 'bg-border-2',
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">{d.title}</span>
                    <SourceBadge source={d.source} compact />
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <button
            type="button"
            onClick={() => {
              setArchived((v) => !v);
              setSelection(null);
            }}
            className="rounded-[8px] px-2.5 py-2 text-left text-[12px] text-text-3 transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            {archived ? '← Активные статьи' : 'Показать архив →'}
          </button>
        </aside>

        {/* Основная колонка */}
        <div className="h-full min-w-0">
          {selection?.mode === 'new' && (
            <Editor onDone={(id) => setSelection(id ? { mode: 'view', id } : null)} />
          )}
          {selection?.mode === 'edit' && (
            <Editor
              docId={selection.id}
              onDone={(id) => setSelection({ mode: 'view', id: id ?? selection.id })}
            />
          )}
          {selection?.mode === 'view' && (
            <Viewer
              id={selection.id}
              onEdit={() => setSelection({ mode: 'edit', id: selection.id })}
              onDeleted={() => setSelection(null)}
            />
          )}
          {!selection && !list.isPending && items.length === 0 && (
            <div className="grid h-full place-items-center rounded-2xl border border-dashed border-border">
              <div className="flex flex-col items-center gap-2 text-center">
                <span className="grid size-11 place-items-center rounded-full bg-surface-2 text-text-3">
                  <BookOpenIcon className="size-5" aria-hidden="true" />
                </span>
                <p className="text-[14px] font-semibold">База знаний пуста</p>
                <p className="max-w-[320px] text-[12.5px] text-text-3">
                  Собирай сюда инструкции и решения — ассистент будет их использовать.
                </p>
                <Button
                  type="button"
                  onClick={() => setSelection({ mode: 'new' })}
                  className="mt-1 h-9 rounded-[10px] bg-cta px-4 text-cta-foreground hover:bg-(--ns-cta-hover)"
                >
                  <PlusIcon className="size-4" aria-hidden="true" />
                  Создать статью
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Viewer({ id, onEdit, onDeleted }: { id: string; onEdit: () => void; onDeleted: () => void }) {
  const doc = useKbDoc(id);
  const update = useUpdateKbDoc();
  const remove = useDeleteKbDoc();
  const [confirmDel, setConfirmDel] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  // Оглавление считаем до ранних return, чтобы порядок хуков не менялся.
  const toc = useMemo(() => tocFromMarkdown(doc.data?.content ?? ''), [doc.data?.content]);

  if (doc.isPending) return <Skeleton className="h-full rounded-2xl" />;
  if (doc.isError || !doc.data)
    return (
      <p className="rounded-2xl border border-crit/30 bg-crit-soft px-4 py-6 text-center text-[13px]">
        {apiErrorMessage(doc.error)}
      </p>
    );

  const d = doc.data;
  const restore = async () => {
    try {
      await update.mutateAsync({ id: d.id, patch: { archived: false } });
      toast.success('Статья возвращена из архива.');
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };
  // «Удаление» активной статьи — это перенос в архив (не пропадает насовсем).
  const archiveArticle = async () => {
    try {
      await update.mutateAsync({ id: d.id, patch: { archived: true } });
      setConfirmDel(false);
      onDeleted();
      toast.success('Статья убрана в архив. Найти её можно в разделе «Архив».');
    } catch (err) {
      setConfirmDel(false);
      toast.error(apiErrorMessage(err));
    }
  };
  // Насовсем — только из архива.
  const permanentDelete = async () => {
    try {
      await remove.mutateAsync(d.id);
      setConfirmDel(false);
      onDeleted();
      toast.success('Статья удалена навсегда.');
    } catch (err) {
      setConfirmDel(false);
      toast.error(apiErrorMessage(err));
    }
  };

  return (
    <article className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="flex-none px-6 pt-6 sm:px-7 sm:pt-7">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="min-w-0 font-heading text-[22px] leading-tight font-bold">{d.title}</h1>
          <div className="flex flex-none items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onEdit}
              className="h-9 rounded-[10px] border-border bg-surface-2 px-3 text-[12.5px] text-text-2 hover:bg-surface-3 hover:text-foreground"
            >
              <PencilIcon className="size-3.5" aria-hidden="true" />
              Изменить
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setHistoryOpen(true)}
              className="size-9 rounded-[10px] border-border bg-surface-2 p-0 text-text-2 hover:bg-surface-3 hover:text-foreground"
              aria-label="История версий"
              title="История версий"
            >
              <HistoryIcon className="size-4" aria-hidden="true" />
            </Button>
            {d.archived && (
              <Button
                type="button"
                variant="outline"
                disabled={update.isPending}
                onClick={() => void restore()}
                className="size-9 rounded-[10px] border-border bg-surface-2 p-0 text-text-2 hover:bg-surface-3 hover:text-foreground"
                aria-label="Вернуть из архива"
                title="Вернуть из архива"
              >
                <ArchiveRestoreIcon className="size-4" aria-hidden="true" />
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmDel(true)}
              className="size-9 rounded-[10px] border-crit/35 bg-crit-soft p-0 text-crit hover:brightness-110"
              aria-label={d.archived ? 'Удалить навсегда' : 'Удалить (в архив)'}
              title={d.archived ? 'Удалить навсегда' : 'Удалить (в архив)'}
            >
              <Trash2Icon className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 border-b border-border pb-4">
          {d.archived && <Pill tone="warn">в архиве</Pill>}
          <SourceBadge source={d.source} />
          {d.tags.map((t) => (
            <span
              key={t}
              className="rounded-full border border-border bg-surface-2 px-2.5 py-0.5 font-mono text-[11px] text-text-3"
            >
              {t}
            </span>
          ))}
          <span className="ml-auto text-[11.5px] text-text-3">
            обновлено {fmtDate.format(new Date(d.updatedAt))}
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-5 overflow-hidden px-6 pb-6 sm:px-7 sm:pb-7">
        <div ref={contentRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <Markdown content={d.content} headingIds className="text-[13.5px]" />
        </div>
        {toc.length >= 2 && <ArticleToc items={toc} containerRef={contentRef} />}
      </div>

      <ConfirmDialog
        open={confirmDel}
        onOpenChange={setConfirmDel}
        kind={d.archived ? 'crit' : 'warn'}
        title={d.archived ? `Удалить «${d.title}» навсегда?` : `Убрать «${d.title}» в архив?`}
        description={
          d.archived
            ? 'Статья исчезнет из базы знаний навсегда — восстановить будет нельзя.'
            : 'Статья переедет в архив. Её можно вернуть в любой момент из раздела «Архив».'
        }
        yesLabel={d.archived ? 'Удалить навсегда' : 'В архив'}
        loading={update.isPending || remove.isPending}
        onConfirm={d.archived ? permanentDelete : archiveArticle}
      />

      <HistoryDialog id={d.id} title={d.title} open={historyOpen} onOpenChange={setHistoryOpen} />
    </article>
  );
}

/** История версий статьи: список снимков и откат к любому. */
/**
 * Оглавление статьи справа (как в вики): переход по заголовкам + подсветка текущего раздела.
 * Скролл — внутри контейнера статьи (containerRef), поэтому переходы работают в его прокрутке.
 */
function ArticleToc({
  items,
  containerRef,
}: {
  items: TocItem[];
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [activeId, setActiveId] = useState<string | null>(items[0]?.id ?? null);

  // Подсветка текущего раздела при прокрутке. IntersectionObserver может отсутствовать (jsdom) — тогда просто без подсветки.
  useEffect(() => {
    const root = containerRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;
    const heads = items
      .map((it) => root.querySelector<HTMLElement>(`#${CSS.escape(it.id)}`))
      .filter((el): el is HTMLElement => el !== null);
    if (heads.length === 0) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length === 0) return;
        const top = visible.reduce((a, b) => (a.boundingClientRect.top <= b.boundingClientRect.top ? a : b));
        setActiveId(top.target.id);
      },
      { root, rootMargin: '0px 0px -68% 0px', threshold: 0 },
    );
    for (const h of heads) obs.observe(h);
    return () => obs.disconnect();
  }, [items, containerRef]);

  const jump = (item: TocItem) => {
    const el = containerRef.current?.querySelector<HTMLElement>(`#${CSS.escape(item.id)}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveId(item.id);
  };

  return (
    <nav aria-label="Содержание статьи" className="hidden w-52 flex-none overflow-y-auto pt-0.5 xl:block">
      <p className="mb-2 px-3 text-[10.5px] font-semibold uppercase tracking-wide text-text-3">Содержание</p>
      <ul className="flex flex-col">
        {items.map((it) => (
          <li key={it.id}>
            <button
              type="button"
              onClick={() => jump(it)}
              className={cn(
                '-ml-px block w-full border-l-2 py-1 pr-2 text-left text-[12px] leading-snug transition-colors',
                it.level === 1 ? 'pl-3' : it.level === 2 ? 'pl-5' : 'pl-7',
                activeId === it.id
                  ? 'border-brand font-medium text-foreground'
                  : 'border-border/60 text-text-3 hover:border-text-3 hover:text-text-2',
              )}
            >
              {it.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function HistoryDialog({
  id,
  title,
  open,
  onOpenChange,
}: {
  id: string;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const versions = useKbVersions(id, open);
  const revert = useRevertKbDoc();
  const items = versions.data?.items ?? [];

  const doRevert = async (versionId: string) => {
    try {
      await revert.mutateAsync({ id, versionId });
      onOpenChange(false);
      toast.success('Статья восстановлена из версии.');
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-120px)] gap-0 overflow-hidden rounded-2xl border-border bg-surface p-0 sm:max-w-[520px]">
        <DialogHeader className="border-b border-border px-5 pt-5 pb-4 text-left">
          <DialogTitle className="font-heading text-[16px]">История версий</DialogTitle>
          <DialogDescription className="text-[12.5px] text-text-2">
            <span className="font-medium text-foreground">«{title}»</span> — снимок сохраняется перед каждым
            изменением. Можно откатить к любому.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[440px] overflow-y-auto px-5 py-3">
          {versions.isPending && <Skeleton className="h-24 rounded-[10px]" />}
          {!versions.isPending && items.length === 0 && (
            <p className="py-8 text-center text-[12.5px] text-text-3">
              Пока нет сохранённых версий — они появятся после первого изменения статьи.
            </p>
          )}
          <ul className="flex flex-col gap-1.5">
            {items.map((v) => (
              <li
                key={v.id}
                className="flex items-center justify-between gap-3 rounded-[10px] border border-border bg-surface-2 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium">{v.title}</div>
                  <div className="mt-0.5 text-[11.5px] text-text-3">
                    {VERSION_REASON[v.reason ?? ''] ?? 'Изменение'} ·{' '}
                    {fmtVersionTime.format(new Date(v.createdAt))}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={revert.isPending}
                  onClick={() => void doRevert(v.id)}
                  className="h-8 flex-none rounded-[9px] border-border bg-surface px-3 text-[12px] text-text-2 hover:bg-surface-3 hover:text-foreground"
                >
                  <RotateCcwIcon className="size-3.5" aria-hidden="true" />
                  Вернуть
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Editor({ docId, onDone }: { docId?: string; onDone: (id: string | null) => void }) {
  const existing = useKbDoc(docId ?? null);
  const create = useCreateKbDoc();
  const update = useUpdateKbDoc();
  const [form, setForm] = useState<{ title: string; tags: string; content: string; source: KbSource }>({
    title: '',
    tags: '',
    content: '',
    source: 'self',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const contentRef = useRef<HTMLTextAreaElement>(null);

  /** Вставка markdown-заготовки в позицию курсора (панель редактора). */
  const insert = (before: string, after = '', placeholder = '') => {
    const el = contentRef.current;
    const value = form.content;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const picked = value.slice(start, end) || placeholder;
    const next = value.slice(0, start) + before + picked + after + value.slice(end);
    setForm((f) => ({ ...f, content: next }));
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + before.length + picked.length;
      el?.setSelectionRange(pos, pos);
    });
  };
  const TOOLBAR: Array<{ label: string; title: string; run: () => void }> = [
    { label: 'H2', title: 'Подзаголовок', run: () => insert('## ', '', 'Заголовок') },
    { label: 'Список', title: 'Список', run: () => insert('- ', '', 'пункт') },
    { label: 'Код', title: 'Блок кода', run: () => insert('```\n', '\n```', 'команда') },
    { label: '‹код›', title: 'Инлайн-код', run: () => insert('`', '`', 'code') },
    {
      label: 'Таблица',
      title: 'Таблица',
      run: () => insert('| Колонка 1 | Колонка 2 |\n| --- | --- |\n| значение | значение |\n'),
    },
    { label: 'Жирный', title: 'Жирный', run: () => insert('**', '**', 'текст') },
    { label: 'Ссылка', title: 'Ссылка', run: () => insert('[', '](https://)', 'текст') },
  ];
  const loaded = useMemo(() => existing.data, [existing.data]);

  useEffect(() => {
    if (docId && loaded)
      setForm({
        title: loaded.title,
        tags: loaded.tags.join(', '),
        content: loaded.content,
        source: loaded.source,
      });
    if (!docId) setForm({ title: '', tags: '', content: '', source: 'self' });
  }, [docId, loaded]);

  const busy = create.isPending || update.isPending;

  const submit = async () => {
    const tags = form.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const parsed = kbDocCreateSchema.safeParse({
      title: form.title,
      content: form.content,
      tags,
      source: form.source,
    });
    if (!parsed.success) {
      const byPath: Record<string, string> = {};
      for (const issue of parsed.error.issues) byPath[String(issue.path[0])] ??= issue.message;
      setErrors(byPath);
      return;
    }
    setErrors({});
    try {
      if (docId) {
        const d = await update.mutateAsync({ id: docId, patch: parsed.data });
        toast.success('Статья сохранена.');
        onDone(d.id);
      } else {
        const d = await create.mutateAsync(parsed.data);
        toast.success('Статья создана.');
        onDone(d.id);
      }
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-6 sm:px-7 sm:pt-7">
        <h2 className="mb-4 font-heading text-[17px] font-bold">
          {docId ? 'Редактирование статьи' : 'Новая статья'}
        </h2>
        <div className="flex flex-col gap-4">
          <label htmlFor="kb-title" className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-text-2">Заголовок</span>
            <Input
              id="kb-title"
              value={form.title}
              onChange={(e) => {
                setForm({ ...form, title: e.target.value });
                setErrors((p) => ({ ...p, title: '' }));
              }}
              aria-label="Заголовок"
              aria-invalid={errors.title ? true : undefined}
              className="h-10 rounded-[10px] bg-surface-2"
            />
            {errors.title && <span className="text-[11.5px] text-crit">{errors.title}</span>}
          </label>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_240px]">
            <label htmlFor="kb-tags" className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium text-text-2">Теги (через запятую)</span>
              <Input
                id="kb-tags"
                value={form.tags}
                onChange={(e) => setForm({ ...form, tags: e.target.value })}
                aria-label="Теги"
                placeholder="xray, сеть"
                className="h-10 rounded-[10px] bg-surface-2 font-mono text-[13px]"
              />
            </label>
            <div className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium text-text-2">Источник</span>
              <Select value={form.source} onValueChange={(v) => setForm({ ...form, source: v as KbSource })}>
                <SelectTrigger aria-label="Источник">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KB_SOURCES.map((sv) => (
                    <SelectItem key={sv} value={sv}>
                      {KB_SOURCE_LABELS[sv]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[11px] font-semibold tracking-[0.03em] text-text-3 uppercase">
                Вставить
              </span>
              {TOOLBAR.map((t) => (
                <button
                  key={t.label}
                  type="button"
                  title={t.title}
                  onClick={t.run}
                  className="cursor-pointer rounded-[8px] border border-border bg-surface-2 px-2.5 py-1.5 text-[12px] font-semibold text-text-2 transition-colors hover:border-brand/40 hover:text-foreground"
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-semibold tracking-[0.03em] text-text-3 uppercase">
                  Markdown
                </span>
                <textarea
                  id="kb-content"
                  ref={contentRef}
                  value={form.content}
                  onChange={(e) => setForm({ ...form, content: e.target.value })}
                  aria-label="Содержимое"
                  className="min-h-[360px] w-full resize-y rounded-[10px] border border-border bg-surface-2 px-3 py-2.5 font-mono text-[12.5px] leading-relaxed outline-none focus-visible:border-brand/50"
                  placeholder="# Заголовок&#10;&#10;Текст, **жирный**, `код`, списки…"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-semibold tracking-[0.03em] text-text-3 uppercase">
                  Предпросмотр
                </span>
                <div className="min-h-[360px] overflow-auto rounded-[10px] border border-border bg-surface-2 px-4 py-3">
                  {form.content.trim() ? (
                    <Markdown content={form.content} />
                  ) : (
                    <p className="text-[12.5px] text-text-3">Здесь появится оформленный вид статьи.</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="flex flex-none items-center gap-3 border-t border-border px-6 py-4 sm:px-7">
        <Button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className="rounded-[10px] bg-cta px-4 text-cta-foreground hover:bg-(--ns-cta-hover)"
        >
          {busy ? 'Сохраняю…' : 'Сохранить'}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => onDone(docId ?? null)}
          className="rounded-[10px] border-border bg-surface-2 px-4 text-text-2 hover:bg-surface-3 hover:text-foreground"
        >
          Отмена
        </Button>
      </div>
    </div>
  );
}
