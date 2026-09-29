import { normalizeTag, similarTag, TAG_MAX_LENGTH } from '@nodeservice/shared';
import { Loader2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { DialogActions, DialogSecondaryButton } from '@/components/dialog-actions';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { useDeleteTag, useRenameTag } from './servers-api';
import { useTagCounts } from './tag-input';

const servers = (n: number) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} сервер`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} сервера`;
  return `${n} серверов`;
};

const btn =
  'h-[30px] cursor-pointer rounded-[9px] border border-border bg-surface-2 px-2.5 text-[12.5px] font-medium text-text-2 hover:text-foreground disabled:opacity-50';

type Pending = { kind: 'merge' | 'delete'; tag: string; to?: string } | null;

/**
 * «Управление тегами» (витрина `tags-variants.html`): все теги парка с числом серверов; опечатку можно слить
 * с похожим популярным тегом, любой — переименовать или убрать. Меняется сразу на всех серверах, пишется в Журнал.
 */
export function TagsManageDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const counts = useTagCounts();
  const rename = useRenameTag();
  const del = useDeleteTag();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<Pending>(null);
  useEffect(() => {
    if (!open) {
      setEditing(null);
      setPending(null);
    }
  }, [open]);
  const busy = rename.isPending || del.isPending;
  const tags = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const doRename = (from: string, to: string) =>
    rename.mutate(
      { from, to },
      {
        onSuccess: (r) => {
          toast.success(
            counts[to]
              ? `«${from}» слит с «${to}» на ${servers(r.updated)}.`
              : `«${from}» → «${to}» на ${servers(r.updated)}.`,
          );
          setEditing(null);
          setPending(null);
        },
        onError: (e) => toast.error(apiErrorMessage(e)),
      },
    );
  const doDelete = (tag: string) =>
    del.mutate(tag, {
      onSuccess: (r) => {
        toast.success(`Тег «${tag}» убран с ${servers(r.updated)}.`);
        setPending(null);
      },
      onError: (e) => toast.error(apiErrorMessage(e)),
    });

  const draftTag = normalizeTag(draft);

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        showCloseButton={false}
        className="rounded-2xl border-border-2 bg-surface p-6 sm:max-w-[600px]"
      >
        <DialogHeader className="text-left">
          <DialogTitle className="font-heading text-[17px]">Управление тегами</DialogTitle>
          <DialogDescription className="text-[12.5px] text-text-3">
            Переименование и слияние меняют тег сразу на всех серверах. Всё попадает в Журнал.
          </DialogDescription>
        </DialogHeader>

        {pending ? (
          <div className="mt-3 flex flex-col gap-3 text-[13px]">
            <p className="m-0 rounded-[11px] border border-border bg-surface-2 px-3.5 py-3 leading-relaxed">
              {pending.kind === 'merge' ? (
                <>
                  На {servers(counts[pending.tag] ?? 0)} тег «{pending.tag}» заменится на «{pending.to}». У «
                  {pending.to}» станет {servers((counts[pending.to ?? ''] ?? 0) + (counts[pending.tag] ?? 0))}{' '}
                  (без повторов). Отменить — переименовать обратно.
                </>
              ) : (
                <>
                  Тег «{pending.tag}» уберётся с {servers(counts[pending.tag] ?? 0)}. Сами серверы не
                  меняются.
                </>
              )}
            </p>
            <DialogActions>
              <DialogSecondaryButton disabled={busy} onClick={() => setPending(null)}>
                Отмена
              </DialogSecondaryButton>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  pending.kind === 'merge' ? doRename(pending.tag, pending.to ?? '') : doDelete(pending.tag)
                }
                className={cn(
                  'inline-flex h-11 min-w-0 flex-1 cursor-pointer items-center justify-center gap-2 rounded-[11px] px-4 text-[13.5px] font-semibold sm:max-w-[210px]',
                  pending.kind === 'delete' ? 'bg-crit text-white' : 'bg-cta text-cta-foreground',
                )}
              >
                {busy && <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />}
                {pending.kind === 'merge' ? 'Слить' : 'Убрать тег'}
              </button>
            </DialogActions>
          </div>
        ) : (
          <div className="mt-2 flex max-h-[60vh] flex-col overflow-y-auto" data-testid="tags-manage">
            {tags.length === 0 && (
              <p className="m-0 py-6 text-center text-[12.5px] text-text-3">Тегов пока нет.</p>
            )}
            {tags.map(([tag, n]) => {
              const like = similarTag(tag, counts);
              return (
                <div
                  key={tag}
                  className="flex flex-wrap items-center gap-2 border-t border-border py-2.5 first:border-t-0"
                >
                  {editing === tag ? (
                    <form
                      className="flex min-w-0 flex-1 items-center gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (!draftTag || draftTag === tag) return setEditing(null);
                        if (counts[draftTag]) setPending({ kind: 'merge', tag, to: draftTag });
                        else doRename(tag, draftTag);
                      }}
                    >
                      <Input
                        autoFocus
                        aria-label={`Новое имя тега ${tag}`}
                        maxLength={TAG_MAX_LENGTH}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        className="h-[30px] min-w-0 flex-1 rounded-[9px] bg-surface-2 text-[13px]"
                      />
                      <button type="submit" disabled={busy} className={btn}>
                        {draftTag && counts[draftTag] && draftTag !== tag
                          ? `Слить с «${draftTag}»`
                          : 'Сохранить'}
                      </button>
                      <button type="button" className={btn} onClick={() => setEditing(null)}>
                        Отмена
                      </button>
                    </form>
                  ) : (
                    <>
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span
                          className={cn(
                            'rounded-full px-2.5 py-0.5 text-[12.5px] font-medium',
                            like ? 'bg-warn-soft text-warn' : 'bg-brand-soft text-brand',
                          )}
                        >
                          {tag}
                        </span>
                        {like && <span className="text-[11.5px] text-warn">похоже на «{like.tag}»</span>}
                      </span>
                      <span className="w-[86px] text-[12px] text-text-3">{servers(n)}</span>
                      {like && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setPending({ kind: 'merge', tag, to: like.tag })}
                          className="h-[30px] cursor-pointer rounded-[9px] bg-cta px-2.5 text-[12.5px] font-semibold text-cta-foreground"
                        >
                          Слить с «{like.tag}»
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        className={btn}
                        onClick={() => {
                          setEditing(tag);
                          setDraft(tag);
                        }}
                      >
                        Переименовать
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className={cn(btn, 'text-crit')}
                        onClick={() => setPending({ kind: 'delete', tag })}
                      >
                        Убрать
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
