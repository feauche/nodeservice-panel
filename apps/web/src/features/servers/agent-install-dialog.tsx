import type { Server } from '@nodeservice/shared';
import { CopyIcon, Loader2Icon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DialogActions, DialogPrimaryButton, DialogSecondaryButton } from '@/components/dialog-actions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { StepUpCancelledError } from '@/features/security/step-up';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { useStartMaintenance } from './maintenance-api';
import { useEnrollmentToken, useInstallAgent, useUninstallAgent, useUnlinkAgent } from './servers-api';

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
  const maintenance = useStartMaintenance(server.id);
  const uninstall = useUninstallAgent();
  const unlink = useUnlinkAgent();
  const [command, setCommand] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installMode, setInstallMode] = useState(server.agentStatus === 'not_installed');
  const [removeOpen, setRemoveOpen] = useState(false);
  const [unlinkOpen, setUnlinkOpen] = useState(false);

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

  // Команда нужна только при установке или переустановке: просмотр состояния не отзывает действующий токен.
  useEffect(() => {
    if (open) setInstallMode(server.agentStatus === 'not_installed');
    else {
      setCommand(null);
      setError(null);
    }
  }, [open, server.agentStatus]);

  const doInstall = async () => {
    try {
      await install.mutateAsync(server.id);
      onOpenChange(false);
      toast.success(`Агент установлен на «${server.name}» — ждём подключения.`);
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) toast.error(apiErrorMessage(err));
    }
  };

  const doUpdate = async () => {
    try {
      await maintenance.mutateAsync('agent_update');
      onOpenChange(false);
      toast.success(`Обновление агента на «${server.name}» запущено.`);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  const doUninstall = async () => {
    try {
      await uninstall.mutateAsync(server.id);
      setRemoveOpen(false);
      onOpenChange(false);
      toast.success(`Агент удалён с «${server.name}» и отвязан.`);
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      setRemoveOpen(false);
      setError(`Удалить агент по SSH не удалось: ${apiErrorMessage(err)}`);
      setUnlinkOpen(true);
    }
  };

  const doUnlink = async () => {
    try {
      await unlink.mutateAsync(server.id);
      setUnlinkOpen(false);
      onOpenChange(false);
      toast.success(`Агент отвязан от «${server.name}».`);
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) toast.error(apiErrorMessage(err));
    }
  };

  const installed = server.agentStatus !== 'not_installed';
  const installing = server.agentStatus === 'installing';
  const pending = install.isPending || maintenance.isPending || uninstall.isPending || unlink.isPending;
  const closeLocked = uninstall.isPending || unlink.isPending;

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !closeLocked && onOpenChange(o)}>
        <DialogContent className="sm:max-w-[600px] rounded-2xl border-border bg-surface p-6">
          <DialogHeader>
            <DialogTitle className="font-heading text-[17px]">
              {installed && !installMode
                ? 'Управление агентом'
                : installed
                  ? 'Переустановка агента'
                  : 'Установка агента'}
            </DialogTitle>
            <DialogDescription className="text-[12.5px] text-text-2">
              {installed && !installMode
                ? `Агент ${server.agentVersion ? `v${server.agentVersion}` : 'установлен'} · ${server.agentStatus === 'online' ? 'сейчас на связи' : 'сейчас не отвечает'}.`
                : 'Панель может установить агент по SSH. Ручная команда остаётся запасным путём; её токен одноразовый и живёт 24 часа.'}
            </DialogDescription>
          </DialogHeader>
          {installing ? (
            <div className="mt-1 flex items-start gap-3 rounded-[11px] border border-brand/30 bg-brand-soft px-4 py-3">
              <Loader2Icon className="mt-0.5 size-4 flex-none animate-spin text-brand" aria-hidden="true" />
              <div>
                <b className="block text-[13px]">Установка уже выполняется</b>
                <span className="mt-0.5 block text-[12px] leading-relaxed text-text-2">
                  Окно можно закрыть. Состояние сохранено на сервере и обновится в карточке после завершения.
                </span>
              </div>
            </div>
          ) : installed && !installMode ? (
            <div className="mt-1 grid gap-2 sm:grid-cols-2">
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                className="h-auto justify-start rounded-[11px] border-border bg-surface-2 px-3.5 py-3 text-left"
                onClick={() => void doUpdate()}
              >
                <RefreshCwIcon className="size-4" aria-hidden="true" />
                <span>
                  <b className="block text-[13px]">Обновить агент</b>
                  <span className="block text-[11.5px] font-normal text-text-3">
                    Последний релиз, настройки и ключ сохранятся
                  </span>
                </span>
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                className="h-auto justify-start rounded-[11px] border-border bg-surface-2 px-3.5 py-3 text-left"
                onClick={() => {
                  setCommand(null);
                  setError(null);
                  setInstallMode(true);
                }}
              >
                <CopyIcon className="size-4" aria-hidden="true" />
                <span>
                  <b className="block text-[13px]">Переустановить</b>
                  <span className="block text-[11.5px] font-normal text-text-3">
                    Полная установка поверх текущей
                  </span>
                </span>
              </Button>
            </div>
          ) : (
            <>
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
                command && (
                  <code className="mt-1 block min-h-[52px] break-all rounded-[10px] border border-border bg-surface-2 px-3 py-2 font-mono text-[12px]">
                    {command}
                  </code>
                )
              )}
              <div className="mt-2 flex justify-center">
                <Button
                  type="button"
                  variant="outline"
                  disabled={enrollment.isPending}
                  className="h-8 rounded-[8px] border-border bg-surface-2 px-2.5 text-[12px] text-text-2 hover:bg-surface-3 hover:text-foreground"
                  onClick={() => {
                    if (!command) {
                      void issue();
                      return;
                    }
                    void navigator.clipboard?.writeText(command);
                    toast.success('Команда скопирована.');
                  }}
                >
                  {enrollment.isPending ? (
                    <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <CopyIcon className="size-3.5" aria-hidden="true" />
                  )}
                  {command ? 'Скопировать команду' : 'Показать ручную команду'}
                </Button>
              </div>
            </>
          )}
          <DialogActions>
            {installing ? (
              <DialogSecondaryButton onClick={() => onOpenChange(false)}>Закрыть</DialogSecondaryButton>
            ) : installed && !installMode ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending}
                  className="mr-auto text-crit hover:bg-crit-soft hover:text-crit"
                  onClick={() => setRemoveOpen(true)}
                >
                  <Trash2Icon className="size-4" aria-hidden="true" /> Удалить агент
                </Button>
                <DialogSecondaryButton disabled={pending} onClick={() => onOpenChange(false)}>
                  Закрыть
                </DialogSecondaryButton>
              </>
            ) : (
              <>
                <DialogSecondaryButton
                  onClick={() => (installed ? setInstallMode(false) : onOpenChange(false))}
                >
                  {installed ? 'Назад' : 'Закрыть'}
                </DialogSecondaryButton>
                <DialogPrimaryButton disabled={install.isPending} onClick={() => void doInstall()}>
                  {install.isPending && <Loader2Icon className="animate-spin" aria-hidden="true" />}
                  {installed ? 'Переустановить по SSH' : 'Установить по SSH'}
                </DialogPrimaryButton>
              </>
            )}
          </DialogActions>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        kind="crit"
        title={`Удалить агент с «${server.name}»?`}
        description="Панель подключится по SSH, остановит и удалит службу агента, его настройки и ключ, затем отвяжет сервер. Остальные программы на сервере не затрагиваются."
        yesLabel="Удалить агент"
        loading={uninstall.isPending}
        onConfirm={() => void doUninstall()}
      />
      <ConfirmDialog
        open={unlinkOpen}
        onOpenChange={setUnlinkOpen}
        kind="warn"
        title="Отвязать агент только в панели?"
        description="SSH недоступен, поэтому служба может остаться на сервере. Её ключ будет отозван: подключиться к панели она больше не сможет. Когда SSH появится, удалите службу вручную или переустановите агент."
        yesLabel="Только отвязать"
        loading={unlink.isPending}
        onConfirm={() => void doUnlink()}
      />
    </>
  );
}
