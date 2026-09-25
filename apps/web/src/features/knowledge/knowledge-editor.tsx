import {
  KB_CONTENT_MAX,
  KB_SOURCE_LABELS,
  KB_SOURCES,
  KB_TAGS_MAX,
  KB_TITLE_MAX,
  type KbDoc,
  type KbSource,
  kbDocCreateSchema,
} from '@nodeservice/shared';
import { useDeferredValue, useEffect, useId, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { useCreateKbDoc, useKbDoc, useUpdateKbDoc } from './knowledge-api';
import {
  clearDraft,
  type KbDraft,
  type KbFormValues,
  readDraft,
  sameValues,
  writeDraft,
} from './knowledge-draft';
import { applyFormat, type FormatAction } from './knowledge-format';
import { Markdown } from './markdown';

const EMPTY: KbFormValues = { title: '', tags: '', content: '', source: 'self' };

const toValues = (d: KbDoc): KbFormValues => ({
  title: d.title,
  tags: d.tags.join(', '),
  content: d.content,
  source: d.source,
});

const fmtCount = new Intl.NumberFormat('ru-RU');
const fmtClock = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fmtDayClock = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
});

const isToday = (iso: string): boolean => new Date(iso).toDateString() === new Date().toDateString();

/** «00:12» для сегодняшнего черновика, «25 сентября, 23:40» — для более старого. */
const draftTime = (iso: string): string =>
  isToday(iso) ? fmtClock.format(new Date(iso)) : fmtDayClock.format(new Date(iso));

const TOOLS: Array<Array<{ action: FormatAction; label: string; name: string; cls?: string }>> = [
  [
    { action: 'h2', label: 'H2', name: 'Заголовок 2' },
    { action: 'h3', label: 'H3', name: 'Заголовок 3' },
  ],
  [
    { action: 'bold', label: 'Ж', name: 'Жирный', cls: 'font-bold' },
    { action: 'italic', label: 'К', name: 'Курсив', cls: 'italic' },
  ],
  [
    { action: 'ul', label: 'Список', name: 'Список' },
    { action: 'ol', label: '1.', name: 'Нумерованный список' },
    { action: 'quote', label: 'Цитата', name: 'Цитата' },
  ],
  [
    { action: 'code', label: 'Код', name: 'Код' },
    { action: 'table', label: 'Таблица', name: 'Таблица' },
    { action: 'link', label: 'Ссылка', name: 'Ссылка' },
    { action: 'hr', label: 'Линия', name: 'Линия' },
  ],
];

/** Редактор статьи: слева markdown, справа живой предпросмотр; полю задана высота, длинный текст прокручивается внутри. */
export function Editor({ docId, onDone }: { docId?: string; onDone: (id: string | null) => void }) {
  const existing = useKbDoc(docId ?? null);

  if (docId && existing.isPending) return <EditorSkeleton />;
  if (docId && (existing.isError || !existing.data))
    return (
      <p className="rounded-2xl border border-crit/30 bg-crit-soft px-4 py-6 text-center text-[13px]">
        {apiErrorMessage(existing.error)}
      </p>
    );

  return (
    <EditorForm
      key={docId ?? 'new'}
      docId={docId}
      initial={existing.data ? toValues(existing.data) : EMPTY}
      pinned={existing.data?.pinned ?? false}
      onDone={onDone}
    />
  );
}

function EditorSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3" aria-busy="true">
      <div className="grid flex-none grid-cols-2 gap-2.5 sm:grid-cols-[minmax(0,1fr)_230px_180px]">
        <Skeleton className="col-span-2 h-9 rounded-[10px] sm:col-span-1" />
        <Skeleton className="h-9 rounded-[10px]" />
        <Skeleton className="h-9 rounded-[10px]" />
      </div>
      <Skeleton className="min-h-0 flex-1 rounded-2xl" />
    </div>
  );
}

function EditorForm({
  docId,
  initial,
  pinned,
  onDone,
}: {
  docId?: string | undefined;
  initial: KbFormValues;
  pinned: boolean;
  onDone: (id: string | null) => void;
}) {
  const create = useCreateKbDoc();
  const update = useUpdateKbDoc();
  const base = useRef(initial);
  const [form, setForm] = useState<KbFormValues>(initial);
  const [draft, setDraft] = useState<KbDraft | null>(() => {
    const d = readDraft(docId);
    return d && !sameValues(d, initial) ? d : null;
  });
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [tab, setTab] = useState<'text' | 'preview'>('text');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmCancel, setConfirmCancel] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const latest = useRef(form);
  const leaving = useRef(false);
  const tabsId = useId();

  const dirty = !sameValues(form, base.current);
  const preview = useDeferredValue(form.content);
  const length = form.content.length;
  const tooLong = length > KB_CONTENT_MAX;
  const busy = create.isPending || update.isPending;

  useEffect(() => {
    latest.current = form;
  }, [form]);

  // Автосохранение черновика: по паузе в наборе, только если есть отличия от сохранённой версии.
  useEffect(() => {
    if (sameValues(form, base.current)) return;
    const t = setTimeout(() => {
      const at = writeDraft(docId, form);
      if (at) setSavedAt(at);
    }, 700);
    return () => clearTimeout(t);
  }, [form, docId]);

  // Ушли из редактора, не дождавшись паузы (выбрали другую статью, обновили вкладку) — досохраняем черновик.
  useEffect(
    () => () => {
      if (!leaving.current && !sameValues(latest.current, base.current)) writeDraft(docId, latest.current);
    },
    [docId],
  );

  const patch = (next: Partial<KbFormValues>) => setForm((f) => ({ ...f, ...next }));

  const format = (action: FormatAction) => {
    const el = textRef.current;
    if (!el) return;
    const r = applyFormat(action, el.value, el.selectionStart, el.selectionEnd);
    patch({ content: r.value });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(r.selStart, r.selEnd);
    });
  };

  const restoreDraft = () => {
    if (!draft) return;
    setForm({ title: draft.title, tags: draft.tags, content: draft.content, source: draft.source });
    setDraft(null);
  };
  const dropDraft = () => {
    clearDraft(docId);
    setDraft(null);
    setSavedAt(null);
  };

  const cancel = () => {
    leaving.current = true;
    clearDraft(docId);
    onDone(docId ?? null);
  };

  const submit = async () => {
    if (tooLong) return;
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
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0]);
        if (next[field]) continue;
        next[field] =
          field === 'title'
            ? form.title.trim()
              ? `Заголовок не длиннее ${KB_TITLE_MAX} знаков.`
              : 'Нужен заголовок.'
            : field === 'tags'
              ? `Теги: не больше ${KB_TAGS_MAX}, без пробелов и не длиннее 32 знаков.`
              : issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    try {
      const d = docId
        ? await update.mutateAsync({ id: docId, patch: parsed.data })
        : await create.mutateAsync(parsed.data);
      leaving.current = true;
      clearDraft(docId);
      toast.success(docId ? 'Статья сохранена.' : 'Статья создана.');
      onDone(d.id);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  const errorText = errors.title ?? errors.tags ?? errors.content;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="grid flex-none grid-cols-2 gap-2.5 sm:grid-cols-[minmax(0,1fr)_230px_180px]">
        <Input
          id="kb-title"
          value={form.title}
          readOnly={pinned}
          title={pinned ? 'Название служебной статьи менять нельзя.' : undefined}
          onChange={(e) => {
            patch({ title: e.target.value });
            setErrors((p) => ({ ...p, title: '' }));
          }}
          aria-label="Заголовок"
          aria-invalid={errors.title ? true : undefined}
          placeholder="Заголовок статьи"
          className="col-span-2 h-9 rounded-[10px] bg-surface-2 sm:col-span-1"
        />
        <Input
          id="kb-tags"
          value={form.tags}
          onChange={(e) => {
            patch({ tags: e.target.value });
            setErrors((p) => ({ ...p, tags: '' }));
          }}
          aria-label="Теги"
          aria-invalid={errors.tags ? true : undefined}
          placeholder="Теги через запятую"
          className="h-9 rounded-[10px] bg-surface-2 font-mono text-[13px]"
        />
        <Select value={form.source} onValueChange={(v) => patch({ source: v as KbSource })}>
          <SelectTrigger aria-label="Источник" className="h-9">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="text-text-3">Источник:</span>
              <SelectValue />
            </span>
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
      {errorText && (
        <p role="alert" className="-mt-1 flex-none text-[12px] text-crit">
          {errorText}
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-surface">
        <div
          role="toolbar"
          aria-label="Форматирование"
          className="flex flex-none flex-wrap items-center gap-y-1 border-b border-border px-2.5 py-1.5"
        >
          {TOOLS.map((group, gi) => (
            <div key={group[0]?.action} className="flex items-center">
              {gi > 0 && <span className="mx-1.5 h-4 w-px bg-border max-md:hidden" aria-hidden="true" />}
              {group.map((t) => (
                <button
                  key={t.action}
                  type="button"
                  aria-label={t.name}
                  title={t.name}
                  // Без фокуса на кнопке выделение в поле не сбрасывается, а набор не прерывается.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => format(t.action)}
                  className={cn(
                    'h-8 min-w-8 cursor-pointer rounded-[8px] px-2.5 text-[12.5px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand',
                    t.cls,
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          ))}
        </div>

        {draft && (
          <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-brand-soft px-4 py-2 text-[12.5px] animate-fade">
            <span className="min-w-0 flex-1">
              Найден несохранённый черновик от {draftTime(draft.savedAt)}. Восстановить его?
            </span>
            <div className="flex flex-none items-center gap-1.5">
              <Button
                type="button"
                onClick={restoreDraft}
                className="h-7 rounded-[8px] bg-cta px-3 text-[12px] text-cta-foreground hover:bg-(--ns-cta-hover)"
              >
                Восстановить
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={dropDraft}
                className="h-7 rounded-[8px] border-border bg-surface px-3 text-[12px] text-text-2 hover:bg-surface-3 hover:text-foreground"
              >
                Отбросить
              </Button>
            </div>
          </div>
        )}

        <div
          role="tablist"
          aria-label="Режим показа"
          className="flex flex-none gap-1 border-b border-border px-2.5 py-1.5 md:hidden"
        >
          {(
            [
              ['text', 'Текст'],
              ['preview', 'Предпросмотр'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`${tabsId}-${id}`}
              aria-selected={tab === id}
              aria-controls={`${tabsId}-${id}-panel`}
              onClick={() => setTab(id)}
              className={cn(
                'h-8 flex-1 cursor-pointer rounded-[8px] text-[12.5px] font-medium transition-colors',
                tab === id ? 'bg-brand-soft text-brand' : 'text-text-2 hover:bg-surface-2',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] md:grid-cols-2">
          <div
            role="tabpanel"
            id={`${tabsId}-text-panel`}
            aria-labelledby={`${tabsId}-text`}
            className={cn('min-h-0 min-w-0 border-border md:border-r', tab === 'preview' && 'max-md:hidden')}
          >
            <textarea
              id="kb-content"
              ref={textRef}
              value={form.content}
              onChange={(e) => patch({ content: e.target.value })}
              aria-label="Содержимое"
              placeholder="# Заголовок&#10;&#10;Текст, **жирный**, `код`, списки…"
              className="block h-full w-full resize-none overflow-y-auto bg-transparent px-5 py-4 font-mono text-[12.5px] leading-[1.7] outline-none placeholder:text-text-3"
            />
          </div>
          <div
            role="tabpanel"
            id={`${tabsId}-preview-panel`}
            aria-labelledby={`${tabsId}-preview`}
            className={cn('min-h-0 min-w-0 overflow-y-auto px-5 py-4', tab === 'text' && 'max-md:hidden')}
          >
            {preview.trim() ? (
              <Markdown content={preview} className="text-[13.5px]" />
            ) : (
              <p className="text-[12.5px] text-text-3">Здесь появится оформленный вид статьи.</p>
            )}
          </div>
        </div>

        <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 text-[12px] text-text-3 max-sm:basis-full">
            <span className={cn('whitespace-nowrap tabular-nums', tooLong && 'font-medium text-crit')}>
              {fmtCount.format(length)} из {fmtCount.format(KB_CONTENT_MAX)} знаков
            </span>
            {savedAt && (
              <>
                <span aria-hidden="true" className="max-sm:hidden">
                  ·
                </span>
                <span role="status" className="whitespace-nowrap">
                  Черновик сохранён в {fmtClock.format(new Date(savedAt))}
                </span>
              </>
            )}
          </div>
          <div className="ml-auto flex flex-none items-center gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => (dirty ? setConfirmCancel(true) : cancel())}
              className="h-9 rounded-[10px] border-border bg-surface-2 px-4 text-text-2 hover:bg-surface-3 hover:text-foreground"
            >
              Отмена
            </Button>
            <Button
              type="button"
              disabled={busy || tooLong}
              onClick={() => void submit()}
              className="h-9 rounded-[10px] bg-cta px-4 text-cta-foreground hover:bg-(--ns-cta-hover)"
            >
              {busy ? 'Сохраняю…' : 'Сохранить'}
            </Button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        kind="warn"
        title="Отбросить изменения?"
        description="Несохранённый текст и черновик будут удалены."
        yesLabel="Отбросить"
        noLabel="Продолжить"
        onConfirm={cancel}
      />
    </div>
  );
}
