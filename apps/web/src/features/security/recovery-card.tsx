import { CopyIcon, DownloadIcon, EyeIcon, KeyRoundIcon } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DialogActions, DialogPrimaryButton, DialogSecondaryButton } from '@/components/dialog-actions';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { GhostButton } from '@/features/auth/components/cta-button';
import { Pill, SettingsRow } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { useRegenerateRecoveryCodes, useSecurityOverview, useViewRecoveryCodes } from './security-api';
import { formatDate } from './security-format';
import { StepUpCancelledError } from './step-up';

/** Строки «Коды восстановления» внутри карточки 2FA: остаток, показать (step-up), перевыпустить. */
export function RecoveryRows() {
  const overview = useSecurityOverview();
  const regenerate = useRegenerateRecoveryCodes();
  const view = useViewRecoveryCodes();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [codes, setCodes] = useState<{ items: CodeItem[]; mode: 'new' | 'view' } | null>(null);
  const left = overview.data?.recoveryCodesLeft;
  const total = overview.data?.recoveryCodesTotal ?? 10;

  const run = async () => {
    try {
      const res = await regenerate.mutateAsync();
      setConfirmOpen(false);
      setCodes({ items: res.recoveryCodes.map((code) => ({ code, usedAt: null })), mode: 'new' });
    } catch (err) {
      setConfirmOpen(false);
      if (!(err instanceof StepUpCancelledError)) toast.error(apiErrorMessage(err));
    }
  };

  const show = async () => {
    try {
      const res = await view.mutateAsync();
      setCodes({ items: res.codes, mode: 'view' });
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) toast.error(apiErrorMessage(err));
    }
  };

  return (
    <>
      <h3 className="mt-4 mb-0.5 text-[11px] font-semibold tracking-[0.1em] text-text-3 uppercase">
        Коды восстановления
      </h3>
      <p className="mb-1 text-[12.5px] text-text-2">
        Запасной вход, если потеряешь телефон. Каждый код одноразовый; вход по коду сбрасывает запомненные
        устройства.
      </p>
      <div>
        <SettingsRow
          label="Осталось"
          hint={typeof left === 'number' && left <= 3 ? 'Мало — лучше выпустить новые.' : undefined}
        >
          {typeof left === 'number' ? (
            <Pill tone={left <= 3 ? 'warn' : 'muted'}>
              {left} из {total}
            </Pill>
          ) : (
            <span className="text-text-3">—</span>
          )}
          <GhostButton onClick={() => void show()} disabled={view.isPending}>
            <EyeIcon aria-hidden="true" />
            Показать
          </GhostButton>
        </SettingsRow>
        <SettingsRow label="Новый набор" hint="Старые коды перестанут работать сразу.">
          <GhostButton onClick={() => setConfirmOpen(true)}>
            <KeyRoundIcon aria-hidden="true" />
            Выпустить новые
          </GhostButton>
        </SettingsRow>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        kind="warn"
        title="Выпустить новые коды?"
        description="Старые коды перестанут работать. Новые покажем один раз — сохрани их в надёжном месте."
        yesLabel="Да, выпустить"
        loading={regenerate.isPending}
        onConfirm={run}
      />
      {codes && (
        <RecoveryCodesDialog
          items={codes.items}
          mode={codes.mode}
          onClose={() => setCodes(null)}
          onRegenerate={() => {
            setCodes(null);
            setConfirmOpen(true);
          }}
        />
      )}
    </>
  );
}

interface CodeItem {
  code: string | null;
  usedAt: string | null;
}

function RecoveryCodesDialog({
  items,
  mode,
  onClose,
  onRegenerate,
}: {
  items: CodeItem[];
  mode: 'new' | 'view';
  onClose: () => void;
  onRegenerate: () => void;
}) {
  const [saved, setSaved] = useState(mode === 'view');
  const unused = items.filter((c) => c.code && !c.usedAt).map((c) => c.code as string);
  /** Коды выпущены до появления шифрованной копии — есть только хеши, показать нечего. */
  const legacy = items.length > 0 && items.every((c) => c.code === null);
  const text = unused.join('\n');
  const download = () => {
    const blob = new Blob([`NodeService — коды восстановления\n\n${text}\n`], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nodeservice-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && saved && onClose()}>
      <DialogContent
        className="sm:max-w-[470px] rounded-2xl border-border bg-surface p-6"
        showCloseButton={mode === 'view'}
      >
        <DialogHeader>
          <DialogTitle className="font-heading text-[17px]">
            {mode === 'new' ? 'Новые коды восстановления' : 'Коды восстановления'}
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-text-2">
            {mode === 'new'
              ? 'Каждый код — на один вход. Сохрани их: посмотреть снова можно здесь же, за паролем.'
              : 'Каждый код — на один вход. Использованные зачёркнуты. Просмотр записан в Журнал.'}
          </DialogDescription>
        </DialogHeader>
        {legacy ? (
          <div
            className="mt-2 rounded-[12px] border border-warn/30 bg-warn-soft px-4 py-3 text-[12.5px] text-foreground"
            data-testid="recovery-codes-legacy"
          >
            Эти коды выпущены до обновления панели — тогда хранились только хеши, и показать их нельзя.
            Выпусти новый набор: старые перестанут работать, новые можно будет смотреть здесь.
          </div>
        ) : (
          <ol
            className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-[12px] border border-border bg-surface-2 px-4 py-3 font-mono text-[13.5px] tabular-nums"
            data-testid="recovery-codes"
          >
            {items.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: порядок выпуска стабилен
              <li key={i} className={c.usedAt ? 'text-text-3' : undefined}>
                {c.code === null ? (
                  <span className="text-text-3">недоступен</span>
                ) : c.usedAt ? (
                  <s title={`Использован ${formatDate(c.usedAt)}`}>{c.code}</s>
                ) : (
                  c.code
                )}
              </li>
            ))}
          </ol>
        )}
        <div className={cn('mt-1 flex flex-wrap justify-center gap-2', legacy && 'hidden')}>
          <Button
            type="button"
            variant="outline"
            disabled={unused.length === 0}
            className="h-8 rounded-[8px] border-border bg-surface-2 px-2.5 text-[12px] text-text-2 hover:bg-surface-3 hover:text-foreground"
            onClick={() => {
              void navigator.clipboard?.writeText(text);
              toast.success('Коды скопированы.');
            }}
          >
            <CopyIcon className="size-3.5" aria-hidden="true" />
            Скопировать
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={unused.length === 0}
            className="h-8 rounded-[8px] border-border bg-surface-2 px-2.5 text-[12px] text-text-2 hover:bg-surface-3 hover:text-foreground"
            onClick={download}
          >
            <DownloadIcon className="size-3.5" aria-hidden="true" />
            Скачать .txt
          </Button>
        </div>
        {mode === 'new' && (
          <label
            htmlFor="recovery-saved"
            className="mt-2 flex cursor-pointer items-center gap-2.5 text-[12.5px]"
          >
            <Checkbox id="recovery-saved" checked={saved} onCheckedChange={(v) => setSaved(v === true)} />
            Коды сохранены в надёжном месте
          </label>
        )}
        <DialogActions>
          {legacy ? (
            <>
              <DialogSecondaryButton onClick={onClose}>Закрыть</DialogSecondaryButton>
              <DialogPrimaryButton onClick={onRegenerate}>Выпустить новые</DialogPrimaryButton>
            </>
          ) : (
            <DialogPrimaryButton disabled={!saved} onClick={onClose}>
              {mode === 'new' ? 'Готово' : 'Закрыть'}
            </DialogPrimaryButton>
          )}
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
