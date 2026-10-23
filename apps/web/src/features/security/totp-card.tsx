import { SECURITY_PROBLEM } from '@nodeservice/shared';
import { CopyIcon, RefreshCwIcon, ShieldCheckIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { OtpField } from '@/features/auth/components/otp-field';
import { Pill, RowButton, SettingsCard, SettingsRow } from '@/features/settings/settings-ui';
import { apiErrorMessage, isApiError } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { toast } from '@/lib/notify';
import { RecoveryCodesDialog } from './recovery-card';
import { useSecurityOverview, useTotpConfirm, useTotpReissue } from './security-api';
import { formatDate, plural } from './security-format';
import { StepUpCancelledError } from './step-up';

/**
 * 2FA: состояние и перевыпуск. Отключить можно только из консоли сервера (nodeservice cli disable-2fa) —
 * тогда здесь честно «Выключена» и кнопка «Включить»: тот же новый секрет и сразу новые коды восстановления.
 */
export function TotpCard() {
  const overview = useSecurityOverview();
  const [open, setOpen] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const confirmedAt = overview.data?.totpConfirmedAt;
  const off = overview.data !== undefined && !confirmedAt;
  return (
    <SettingsCard
      title="Двухфакторная защита"
      hint="Коды из приложения-аутентификатора. Отключить можно только через консольную утилиту на сервере панели."
    >
      <div>
        <SettingsRow
          label="Состояние"
          hint={
            confirmedAt
              ? `Привязана ${formatDate(confirmedAt)}`
              : off
                ? 'Отключена из консоли сервера: вход сейчас только по паролю. Включите её снова.'
                : undefined
          }
        >
          {confirmedAt ? (
            <Pill tone="ok">Включена</Pill>
          ) : off ? (
            <Pill tone="crit">Выключена</Pill>
          ) : (
            <Skeleton className="h-[22px] w-20 rounded-full" />
          )}
        </SettingsRow>
        {off ? (
          <SettingsRow
            label="Включить"
            hint="Новый секрет и QR, сразу — 10 кодов восстановления. Другие сессии будут завершены."
          >
            <RowButton onClick={() => setOpen(true)}>
              <ShieldCheckIcon aria-hidden="true" />
              Включить
            </RowButton>
          </SettingsRow>
        ) : (
          <SettingsRow
            label="Перевыпуск"
            hint="Новый секрет и QR. Старые запомненные устройства и другие сессии будут сброшены."
          >
            <RowButton onClick={() => setOpen(true)} disabled={!confirmedAt}>
              <RefreshCwIcon aria-hidden="true" />
              Перевыпустить
            </RowButton>
          </SettingsRow>
        )}
      </div>
      <TotpReissueDialog open={open} onOpenChange={setOpen} enable={off} onRecoveryCodes={setCodes} />
      {codes && (
        <RecoveryCodesDialog
          items={codes.map((code) => ({ code, usedAt: null }))}
          mode="new"
          onClose={() => setCodes(null)}
          onRegenerate={() => setCodes(null)}
        />
      )}
    </SettingsCard>
  );
}

function TotpReissueDialog({
  open,
  onOpenChange,
  enable,
  onRecoveryCodes,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** 2FA выключена — то же окно, но «Включение 2FA». */
  enable: boolean;
  onRecoveryCodes: (codes: string[]) => void;
}) {
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
      if (res.recoveryCodes?.length) onRecoveryCodes(res.recoveryCodes);
      const parts = [enable ? '2FA включена.' : '2FA перевыпущена.'];
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
        setError('Время вышло или было много неверных кодов — начните заново, QR-код будет новым.');
      } else setError(apiErrorMessage(err));
    }
  };

  const data = reissue.data;
  return (
    <Dialog open={open} onOpenChange={(o) => !confirm.isPending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-[470px] rounded-2xl border-border bg-surface p-6">
        <DialogHeader>
          <DialogTitle className="font-heading text-[17px]">
            {enable ? 'Включение 2FA' : 'Перевыпуск 2FA'}
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-text-2">
            {enable
              ? 'Отсканируйте QR в приложении-аутентификаторе и введите код. Старую запись NodeService в приложении можно удалить.'
              : 'Отсканируйте QR в приложении-аутентификаторе и введите код. Старый секрет работает, пока новый не подтверждён.'}
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
                <div className="text-[11.5px] font-medium text-text-2">Или введите ключ вручную</div>
                <code className="mt-1 block break-all font-mono text-[12.5px] leading-relaxed">
                  {data.totpSecret}
                </code>
                <RowButton
                  className="mt-2"
                  onClick={(e) => {
                    void copyText(data.totpSecret, e.currentTarget).then((ok) =>
                      ok
                        ? toast.success('Ключ скопирован.')
                        : toast.error('Не удалось скопировать. Выделите текст и скопируйте вручную.'),
                    );
                  }}
                >
                  <CopyIcon className="size-3.5" aria-hidden="true" />
                  Скопировать ключ
                </RowButton>
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
