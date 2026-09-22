import type { Server } from '@nodeservice/shared';
import { CopyIcon, Loader2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { DialogActions, DialogPrimaryButton, DialogSecondaryButton } from '@/components/dialog-actions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { StepUpCancelledError } from '@/features/security/step-up';
import { apiErrorMessage } from '@/lib/api';
import { useEnrollmentToken, useInstallAgent } from './servers-api';

interface Props {
  server: Server;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Установка агента: «Установить по SSH» (панель делает всё сама) или ручная команда
 * с одноразовым токеном — запасной путь, когда SSH недоступен. Токен выпускается при открытии.
 */
export function AgentInstallDialog({ server, open, onOpenChange }: Props) {
  const enrollment = useEnrollmentToken();
  const install = useInstallAgent();
  const [command, setCommand] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const issue = async () => {
    setError(null);
    try {
      const res = await enrollment.mutateAsync(server.id);
      setCommand(res.installCommand);
    } catch (err) {
      if (err instanceof StepUpCancelledError) {
        onOpenChange(false);
        return;
      }
      setError(apiErrorMessage(err));
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: токен выпускается один раз на открытие
  useEffect(() => {
    if (open) void issue();
    else {
      setCommand(null);
      setError(null);
    }
  }, [open]);

  const doInstall = async () => {
    try {
      await install.mutateAsync(server.id);
      onOpenChange(false);
      toast.success(`Агент установлен на «${server.name}» — ждём подключения.`);
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) toast.error(apiErrorMessage(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !install.isPending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-[560px] rounded-2xl border-border bg-surface p-6">
        <DialogHeader>
          <DialogTitle className="font-heading text-[17px]">Установка агента</DialogTitle>
          <DialogDescription className="text-[12.5px] text-text-2">
            Проще всего — «Установить по SSH»: панель сама зайдёт на сервер и выполнит установку из релизов
            GitHub. Или выполни команду ниже вручную от root. Токен одноразовый, живёт 24 часа; новый отзывает
            старый.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <div className="mt-1 flex items-center justify-between gap-3 rounded-[10px] border border-crit/30 bg-crit-soft px-3 py-2 text-[12.5px]">
            <span role="alert">{error}</span>
            <Button
              type="button"
              variant="outline"
              className="h-7 flex-none rounded-[8px] border-border bg-surface-2 px-2.5 text-[12px]"
              onClick={() => void issue()}
            >
              Повторить
            </Button>
          </div>
        ) : (
          <code className="mt-1 block min-h-[52px] break-all rounded-[10px] border border-border bg-surface-2 px-3 py-2 font-mono text-[12px]">
            {command ?? 'Готовлю команду…'}
          </code>
        )}
        <div className="mt-2 flex justify-center">
          <Button
            type="button"
            variant="outline"
            disabled={!command}
            className="h-8 rounded-[8px] border-border bg-surface-2 px-2.5 text-[12px] text-text-2 hover:bg-surface-3 hover:text-foreground"
            onClick={() => {
              void navigator.clipboard?.writeText(command ?? '');
              toast.success('Команда скопирована.');
            }}
          >
            <CopyIcon className="size-3.5" aria-hidden="true" />
            Скопировать команду
          </Button>
        </div>
        <DialogActions>
          <DialogSecondaryButton disabled={install.isPending} onClick={() => onOpenChange(false)}>
            Закрыть
          </DialogSecondaryButton>
          <DialogPrimaryButton disabled={install.isPending || !command} onClick={() => void doInstall()}>
            {install.isPending && <Loader2Icon className="animate-spin" aria-hidden="true" />}
            Установить по SSH
          </DialogPrimaryButton>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
