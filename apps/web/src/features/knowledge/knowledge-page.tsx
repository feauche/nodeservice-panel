import { KB_SOURCE_LABELS, type KbDocSummary, type KbSource } from '@nodeservice/shared';
import {
  ArchiveRestoreIcon,
  BookOpenIcon,
  GlobeIcon,
  HistoryIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  SendIcon,
  Trash2Icon,
  UserRoundIcon,
} from 'lucide-react';
import { type ComponentType, type SVGProps, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { JarvisIcon } from '@/components/jarvis-icon';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Pill } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import {
  useDeleteKbDoc,
  useKbDoc,
  useKbList,
  useKbVersions,
  useRevertKbDoc,
  useUpdateKbDoc,
} from './knowledge-api';
import { Editor } from './knowledge-editor';
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

const fmtDay = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const fmtDayYear = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

/** «26 сентября»; год — только если не текущий. */
function fmtUpdated(iso: string): string {
  const d = new Date(iso);
  return (d.getFullYear() === new Date().getFullYear() ? fmtDay : fmtDayYear).format(d);
}

/**
 * Высота страницы на десктопе = область контента оболочки (100dvh − рамка 16 − шапка 58 − границы 2)
 * минус верхний отступ 24 и такой же нижний. Оболочка оставляет снизу 60px, поэтому лишние 36px
 * (на телефоне 44px — там верхний отступ 16) «съедаем» отрицательным полем: низ равен верху.
 */
const PAGE = 'flex flex-col gap-4 -mb-11 md:-mb-9 lg:h-[calc(100dvh-124px)] lg:min-h-[460px]';
/** Ниже 1024px панели идут друг под другом: список — невысокий и с прокруткой, правая панель — почти в экран. */
const STACKED_MAIN = 'max-lg:h-[calc(100dvh-150px)] max-lg:min-h-[480px]';
/** Редактору на телефоне нужно больше места: тулбар и подвал переносятся на несколько строк. */
const STACKED_EDITOR = 'max-lg:h-[max(720px,calc(100dvh-150px))] max-lg:flex-none';

const SOURCE_META: Record<KbSource, { cls: string; Icon: ComponentType<SVGProps<SVGSVGElement>> }> = {
  self: { cls: 'kb-src-self', Icon: UserRoundIcon },
  ai: { cls: 'kb-src-ai', Icon: JarvisIcon },
  web: { cls: 'kb-src-web', Icon: GlobeIcon },
  telegram: { cls: 'kb-src-tg', Icon: SendIcon },
};

/** Бейдж источника статьи — откуда взята информация. */
function SourceBadge({ source }: { source: KbSource }) {
  const { cls, Icon } = SOURCE_META[source];
  return (
    <span className={cn('kb-src', cls)}>
      <Icon className="size-3" aria-hidden="true" />
      {KB_SOURCE_LABELS[source]}
    </span>
  );
}

type Selection = { mode: 'view'; id: string } | { mode: 'edit'; id: string } | { mode: 'new' } | null;

/** Сводка статьи в списке: серверная выдержка начинается с заголовка — его повторять незачем. */
function excerptOf(d: KbDocSummary): string {
  const t = d.excerpt.trim();
  return (t.startsWith(d.title) ? t.slice(d.title.length) : t).trim();
}

function ArticleItem({
  d,
  active,
  onOpen,
}: {
  d: KbDocSummary;
  active: boolean;
  onOpen: (id: string) => void;
}) {
  const excerpt = excerptOf(d);
  return (
    <button
      type="button"
      onClick={() => onOpen(d.id)}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex w-full cursor-pointer flex-col gap-1 rounded-[10px] px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand',
        active ? 'bg-brand-soft' : 'hover:bg-surface-2',
      )}
    >
      <span className="flex items-center gap-1.5">
        {d.pinned && <PinIcon className="size-3.5 flex-none text-ai" aria-hidden="true" />}
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[13.5px] font-semibold',
            active ? 'text-brand' : 'text-foreground',
          )}
        >
          {d.title}
        </span>
      </span>
      {excerpt && <span className="line-clamp-1 text-[12px] text-text-3">{excerpt}</span>}
      {d.tags.length > 0 && (
        <span className="flex flex-wrap gap-1">
          {d.tags.slice(0, 3).map((t) => (
            <span
              key={t}
              className="rounded-[6px] border border-border bg-surface-2 px-1.5 py-px font-mono text-[10.5px] text-text-3"
            >
              {t}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

export function KnowledgePage({
  openId,
  onOpen,
}: {
  /** Открыть конкретную статью по ссылке (?open=<id>) — из цитаты Джарвиса. */
  openId?: string | undefined;
  onOpen?: ((id: string | undefined) => void) | undefined;
}) {
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const list = useKbList(q, archived);
  const items = list.data?.items ?? [];
  const pinned = items.filter((d) => d.pinned);
  const rest = items.filter((d) => !d.pinned);

  const selectedId = selection && 'id' in selection ? selection.id : null;
  const editing = selection?.mode === 'new' || selection?.mode === 'edit';

  // Ссылка ?open=<id> — открываем именно эту статью (например, клик по чипу-цитате в Джарвисе).
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
    <div className={PAGE}>
      <div className="flex-none">
        <h1 className="text-[23px]">
          {selection?.mode === 'new'
            ? 'Новая статья'
            : selection?.mode === 'edit'
              ? 'Изменение статьи'
              : 'База знаний'}
        </h1>
        <p className="mt-[5px] text-[13.5px] text-text-2">
          {editing
            ? 'Слева — текст с разметкой, справа — готовый вид статьи'
            : 'Инструкции и решения — их знает и применяет Джарвис'}
        </p>
      </div>

      {editing ? (
        <div className={cn('min-h-0 flex-1', STACKED_EDITOR)}>
          {selection?.mode === 'new' && (
            <Editor key="new" onDone={(id) => setSelection(id ? { mode: 'view', id } : null)} />
          )}
          {selection?.mode === 'edit' && (
            <Editor
              key={selection.id}
              docId={selection.id}
              onDone={(id) => setSelection({ mode: 'view', id: id ?? selection.id })}
            />
          )}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
          {/* Список статей */}
          <aside className="flex min-h-0 flex-col gap-3 rounded-2xl border border-border bg-surface p-3 max-lg:max-h-[360px]">
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
              className="h-9 flex-none rounded-[10px] bg-cta text-cta-foreground hover:bg-(--ns-cta-hover)"
            >
              <PlusIcon className="size-4" aria-hidden="true" />
              Новая статья
            </Button>

            <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
              {list.isPending && (
                <div className="flex flex-col gap-1.5" aria-busy="true">
                  {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-[60px] rounded-[10px]" />
                  ))}
                </div>
              )}
              {!list.isPending && items.length === 0 && (
                <p className="px-2 py-6 text-center text-[12.5px] text-text-3">
                  {q ? 'Ничего не найдено.' : archived ? 'В архиве пусто.' : 'Статей пока нет.'}
                </p>
              )}
              <ul className="flex flex-col gap-0.5">
                {pinned.map((d) => (
                  <li key={d.id}>
                    <ArticleItem d={d} active={selectedId === d.id} onOpen={openArticle} />
                  </li>
                ))}
                {pinned.length > 0 && rest.length > 0 && (
                  <li aria-hidden="true" className="my-1.5 h-px bg-border" />
                )}
                {rest.map((d) => (
                  <li key={d.id}>
                    <ArticleItem d={d} active={selectedId === d.id} onOpen={openArticle} />
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
              className="flex-none cursor-pointer border-t border-border px-2.5 pt-3 pb-1 text-left text-[12px] text-text-3 transition-colors hover:text-foreground"
            >
              {archived ? '← Активные статьи' : 'Показать архив →'}
            </button>
          </aside>

          {/* Статья */}
          <div className={cn('min-h-0 min-w-0', STACKED_MAIN)}>
            {selection?.mode === 'view' && (
              <Viewer
                key={selection.id}
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
                    Собирайте здесь инструкции и решения: Джарвис будет их использовать.
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
            {!selection && list.isPending && <ViewerSkeleton />}
          </div>
        </div>
      )}
    </div>
  );
}

function ViewerSkeleton() {
  return (
    <div
      className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-surface"
      aria-busy="true"
    >
      <div className="flex flex-none items-center gap-3 border-b border-border px-6 py-4 sm:px-7">
        <Skeleton className="h-6 w-56 rounded-[8px]" />
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="ml-auto h-9 w-24 rounded-[10px]" />
      </div>
      <div className="flex flex-col gap-3 px-6 py-6 sm:px-7">
        <Skeleton className="h-4 w-3/4 rounded-[6px]" />
        <Skeleton className="h-4 w-full rounded-[6px]" />
        <Skeleton className="h-4 w-5/6 rounded-[6px]" />
        <Skeleton className="mt-3 h-24 w-full rounded-[10px]" />
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

  if (doc.isPending) return <ViewerSkeleton />;
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
    <article className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface animate-fade">
      {/* Шапка закреплена: прокручивается только тело статьи */}
      <header className="flex flex-none flex-wrap items-center justify-between gap-x-4 gap-y-2.5 border-b border-border px-6 py-4 sm:px-7">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <h2 className="min-w-0 font-heading text-[20px] leading-tight font-bold">{d.title}</h2>
          {d.archived && <Pill tone="warn">В архиве</Pill>}
          <SourceBadge source={d.source} />
          {d.tags.map((t) => (
            <span
              key={t}
              className="rounded-[6px] border border-border bg-surface-2 px-1.5 py-px font-mono text-[10.5px] text-text-3"
            >
              {t}
            </span>
          ))}
        </div>
        <div className="flex flex-none flex-wrap items-center gap-2 max-sm:w-full">
          <span className="mr-1 text-[11.5px] text-text-3 max-sm:w-full">
            Обновлено {fmtUpdated(d.updatedAt)}
          </span>
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
          {/* Служебную закреплённую статью удалить нельзя: её ведёт Джарвис */}
          {!d.pinned && (
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
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-5 overflow-hidden pr-2 pl-6 sm:pl-7">
        <div ref={contentRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto py-5 pr-4 sm:py-6">
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
    <nav
      aria-label="Содержание статьи"
      className="hidden w-52 flex-none overflow-y-auto py-5 sm:py-6 xl:block"
    >
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

/** История версий статьи: список снимков и откат к любому. */
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
