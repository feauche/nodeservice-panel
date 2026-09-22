import { type TerminalSnippet, type TerminalSnippets, terminalSnippetsSchema } from '@nodeservice/shared';
import { Loader2Icon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { DialogPrimaryButton, DialogSecondaryButton } from '@/components/dialog-actions';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useSnippets, useUpdateSnippets } from '@/features/settings/settings-api';
import { apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Row = TerminalSnippet;

/**
 * Редактор сниппетов терминала: название и команда в строку. Список общий для всех серверов
 * и заменяется целиком по «Сохранить». Команда по клику в меню вставляется в терминал без Enter.
 */
export function SnippetsDialog({ open, onOpenChange }: Props) {
  const snippets = useSnippets();
  const update = useUpdateSnippets();
  const [rows, setRows] = useState<Row[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // При открытии — копия сохранённого списка; правки живут в диалоге до «Сохранить».
  // biome-ignore lint/correctness/useExhaustiveDependencies: только при открытии
  useEffect(() => {
    if (open) {
      setRows(snippets.data?.items.map((i) => ({ ...i })) ?? []);
      setErrors({});
    }
  }, [open, snippets.data]);

  const patch = (id: string, field: 'name' | 'command', value: string) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
    setErrors((p) => ({ ...p, [`${id}.${field}`]: '' }));
  };
  const add = () => setRows((prev) => [...prev, { id: crypto.randomUUID(), name: '', command: '' }]);
  const remove = (id: string) => setRows((prev) => prev.filter((r) => r.id !== id));

  const save = async () => {
    const parsed = terminalSnippetsSchema.safeParse({ items: rows } satisfies TerminalSnippets);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const [, idx, field] = issue.path;
        const row = typeof idx === 'number' ? rows[idx] : undefined;
        if (row && (field === 'name' || field === 'command')) next[`${row.id}.${field}`] ??= issue.message;
        else next.form ??= issue.message;
      }
      setErrors(next);
      return;
    }
    try {
      await update.mutateAsync(parsed.data);
      toast.success('Сниппеты сохранены.');
      onOpenChange(false);
    } catch (err) {
      setErrors({ form: apiErrorMessage(err) });
    }
  };

  const busy = update.isPending;
  const inputClass = 'h-9 rounded-[9px] bg-surface-2 text-[13px]';

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        showCloseButton={false}
        overlayClassName="z-[110]"
        className="z-[110] flex max-h-[calc(100vh-48px)] flex-col gap-0 overflow-hidden rounded-2xl border-border-2 bg-surface p-0 sm:max-w-[640px]"
      >
        <DialogHeader className="flex-none gap-1 px-6 pt-5 pb-1">
          <DialogTitle className="font-heading text-[18px]">Сниппеты терминала</DialogTitle>
          <DialogDescription className="text-[13px] text-text-2">
            Именованные команды под рукой в каждом терминале. По клику команда вставляется в строку ввода, но
            не отправляется: Enter вы нажимаете сами.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-4">
          {rows.length === 0 ? (
            <p className="rounded-[10px] border border-dashed border-border-2 px-4 py-6 text-center text-[13px] text-text-3">
              Пока пусто. Добавьте первую команду, например «Соединения» →{' '}
              <span className="font-mono">ss -s</span>.
            </p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {rows.map((r, i) => {
                const nameErr = errors[`${r.id}.name`];
                const cmdErr = errors[`${r.id}.command`];
                return (
                  <li
                    key={r.id}
                    className="grid grid-cols-[180px_minmax(0,1fr)_32px] items-start gap-2 max-sm:grid-cols-[minmax(0,1fr)_32px]"
                  >
                    <div className="min-w-0 max-sm:col-span-1">
                      <Input
                        aria-label={`Название сниппета ${i + 1}`}
                        placeholder="Название"
                        value={r.name}
                        disabled={busy}
                        aria-invalid={nameErr ? true : undefined}
                        onChange={(e) => patch(r.id, 'name', e.target.value)}
                        className={cn(inputClass, nameErr && 'border-crit')}
                      />
                      {nameErr && <p className="mt-1 text-[11.5px] text-crit">{nameErr}</p>}
                    </div>
                    <div className="min-w-0 max-sm:order-3 max-sm:col-span-2">
                      <Input
                        aria-label={`Команда сниппета ${i + 1}`}
                        placeholder="Команда, например ss -s"
                        value={r.command}
                        disabled={busy}
                        spellCheck={false}
                        autoCapitalize="none"
                        aria-invalid={cmdErr ? true : undefined}
                        onChange={(e) => patch(r.id, 'command', e.target.value)}
                        className={cn(inputClass, 'font-mono text-[12.5px]', cmdErr && 'border-crit')}
                      />
                      {cmdErr && <p className="mt-1 text-[11.5px] text-crit">{cmdErr}</p>}
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Удалить сниппет ${r.name || i + 1}`}
                      title="Удалить"
                      onClick={() => remove(r.id)}
                      className="grid size-9 cursor-pointer place-items-center rounded-[9px] text-text-3 transition-colors hover:bg-crit-soft hover:text-crit disabled:opacity-50"
                    >
                      <Trash2Icon className="size-4" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={add}
            className="mt-3 inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[9px] border border-border bg-surface-2 px-3 text-[12.5px] font-medium text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground disabled:opacity-50"
          >
            <PlusIcon className="size-4" aria-hidden="true" />
            Добавить сниппет
          </button>
          {errors.form && (
            <p role="alert" className="mt-3 text-[12px] text-crit">
              {errors.form}
            </p>
          )}
        </div>

        <div className="flex flex-none items-center gap-3 border-t border-border bg-bg-2 px-6 py-3.5 max-sm:flex-col max-sm:items-stretch">
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
            Список общий для всех серверов. Команда в одну строку, без перевода строки.
          </p>
          <div className="flex gap-2 max-sm:flex-col">
            <DialogSecondaryButton
              disabled={busy}
              onClick={() => onOpenChange(false)}
              className="h-10 flex-none rounded-[10px] px-4 sm:max-w-none"
            >
              Отмена
            </DialogSecondaryButton>
            <DialogPrimaryButton
              disabled={busy}
              onClick={() => void save()}
              className="h-10 flex-none rounded-[10px] px-4 sm:max-w-none"
            >
              {busy && <Loader2Icon className="animate-spin" aria-hidden="true" />}
              Сохранить
            </DialogPrimaryButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
