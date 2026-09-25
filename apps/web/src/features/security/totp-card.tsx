import { SECURITY_PROBLEM } from '@nodeservice/shared';
import { CopyIcon, RefreshCwIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { GhostButton } from '@/features/auth/components/cta-button';
import { OtpField } from '@/features/auth/components/otp-field';
import { Pill, SettingsCard, SettingsRow } from '@/features/settings/settings-ui';
import { apiErrorMessage, isApiError } from '@/lib/api';
import { toast } from '@/lib/notify';
import { RecoveryRows } from './recovery-card';
import { useSecurityOverview, useTotpConfirm, useTotpReissue } from './security-api';
import { formatDate, plural } from './security-format';
import { StepUpCancelledError } from './step-up';

/** 2FA: статус и перевыпуск. Отключить нельзя — только через Rescue CLI на сервере. */
export function TotpCard() {
  const overview = useSecurityOverview();
  const [open, setOpen] = useState(false);
  return (
    <SettingsCard
      title="Двухфакторная защита"
      hint="Коды из приложения-аутентификатора. Отключить можно только через Rescue CLI на сервере."
    >
      <div className="mt-1">
        <SettingsRow
          label="Состояние"
          hint={
            overview.data?.totpConfirmedAt
              ? `Привязана ${formatDate(overview.data.totpConfirmedAt)}`
              : undefined
          }
        >
          <Pill tone="ok">Включена</Pill>
        </SettingsRow>
        <SettingsRow
          label="Перевыпуск"
          hint="Новый секрет и QR. Старые запомненные устройства и другие сессии будут сброшены."
        >
          <GhostButton onClick={() => setOpen(true)}>
            <RefreshCwIcon aria-hidden="true" />
            Перевыпустить
          </GhostButton>
        </SettingsRow>
        <RecoveryRows />
      </div>
      <TotpReissueDialog open={open} onOpenChange={setOpen} />
    </SettingsCard>
  );
}

function TotpReissueDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const reissue = useTotpReissue();
  const confirm = useTotpConfirm();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  const start = async () => {
    setError(null);
    setExpired(false);
    setCode('');
    try {
      await reissue.mutateAsync();
    } catch (err) {
      if (err instanceof StepUpCancelledError) {
        onOpenChange(false);
        return;
      }
      setError(apiErrorMessage(err));
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: старт только при открытии
  useEffect(() => {
    if (open) void start();
    else reissue.reset();
  }, [open]);

  const submit = async (value: string) => {
    setError(null);
    try {
      const res = await confirm.mutateAsync(value);
      onOpenChange(false);
      const parts = ['2FA перевыпущена.'];
      if (res.trustedDevicesRemoved > 0) parts.push(`Забыто устройств: ${res.trustedDevicesRemoved}.`);
      if (res.sessionsRevoked > 0)
        parts.push(
          `${plural(res.sessionsRevoked, ['Завершена', 'Завершены', 'Завершено'])} ${res.sessionsRevoked} ${plural(res.sessionsRevoked, ['другая сессия', 'другие сессии', 'других сессий'])}.`,
        );
      toast.success(parts.join(' '));
    } catch (err) {
      setCode('');
      if (isApiError(err) && err.type === SECURITY_PROBLEM.totpReissueExpired) {
        setExpired(true);
        setError('Время вышло — начни перевыпуск заново.');
      } else setError(apiErrorMessage(err));
    }
  };

  const data = reissue.data;
  return (
    <Dialog open={open} onOpenChange={(o) => !confirm.isPending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-[470px] rounded-2xl border-border bg-surface p-6">
        <DialogHeader>
          <DialogTitle className="font-heading text-[17px]">Перевыпуск 2FA</DialogTitle>
          <DialogDescription className="text-[12.5px] text-text-2">
            Отсканируй QR в приложении-аутентификаторе и введи код. Старый секрет работает, пока новый не
            подтверждён.
          </DialogDescription>
        </DialogHeader>
        {reissue.isPending && (
          <p className="py-6 text-center text-[13px] text-text-3">Готовлю новый секрет…</p>
        )}
        {data && (
          <div className="mt-2 flex flex-col gap-4">
            <div className="flex items-start gap-4">
              <img
                src={data.qrDataUrl}
                alt="QR-код для приложения-аутентификатора"
                className="size-[148px] flex-none rounded-[12px] bg-white p-2"
              />
              <div className="min-w-0 flex-1">
                <div className="text-[11.5px] font-medium text-text-2">Или введи ключ вручную</div>
                <code className="mt-1 block break-all font-mono text-[12.5px] leading-relaxed">
                  {data.totpSecret}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-2 h-8 rounded-[8px] border-border bg-surface-2 px-2.5 text-[12px] text-text-2 hover:bg-surface-3 hover:text-foreground"
                  onClick={() => {
                    void navigator.clipboard?.writeText(data.totpSecret);
                    toast.success('Ключ скопирован.');
                  }}
                >
                  <CopyIcon className="size-3.5" aria-hidden="true" />
                  Скопировать ключ
                </Button>
              </div>
            </div>
            <div>
              <div className="mb-2 text-[11.5px] font-medium text-text-2">Код из приложения</div>
              <OtpField
                value={code}
                onChange={setCode}
                onComplete={(v) => void submit(v)}
                disabled={confirm.isPending || expired}
                invalid={Boolean(error)}
                autoFocus
              />
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-2 text-[12px] text-crit">
            {error}{' '}
            {expired && (
              <button type="button" className="cursor-pointer underline" onClick={() => void start()}>
                Начать заново
              </button>
            )}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
