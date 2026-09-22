import { STEP_UP_MINUTES } from '@nodeservice/shared';
import { Loader2Icon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';

import { DialogActions, DialogPrimaryButton, DialogSecondaryButton } from '@/components/dialog-actions';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/features/auth/components/field';
import { PasswordField } from '@/features/auth/components/password-field';
import { useUnlock } from '@/features/auth/queries';
import { apiErrorMessage } from '@/lib/api';
import { useStepUpStore } from './step-up';

/**
 * Диалог step-up: один на приложение, открывается из withStepUp(). Пароль → POST /auth/unlock,
 * после чего исходный запрос повторяется. Закрыть = отменить действие.
 */
export function StepUpHost() {
  const open = useStepUpStore((s) => s.open);
  const finish = useStepUpStore((s) => s.finish);
  const unlock = useUnlock();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setPassword('');
      setError(null);
    }
  }, [open]);

  // Ушли со страницы (диалог открыт или запрос ещё ждёт пароль) — отменяем, иначе диалог всплывёт при следующем заходе.
  useEffect(() => () => useStepUpStore.getState().finish(false), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) {
      setError('Введи пароль');
      return;
    }
    try {
      await unlock.mutateAsync({ password });
      finish(true);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !unlock.isPending && finish(false)}>
      {/* Слой выше любых окон: запрос пароля может всплыть поверх подтверждения (z-90). */}
      <DialogContent
        overlayClassName="z-100"
        className="z-100 sm:max-w-[420px] rounded-2xl border-border bg-surface p-6"
      >
        <DialogHeader>
          <DialogTitle className="font-heading text-[17px]">Подтверди пароль</DialogTitle>
          <DialogDescription className="text-[12.5px] text-text-2">
            Действие чувствительное — на всякий случай спросим пароль ещё раз. Подтверждение действует{' '}
            {STEP_UP_MINUTES} минут.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="mt-2 flex flex-col gap-3" noValidate>
          <Field id="stepup-password" label="Пароль" error={error ?? undefined}>
            <PasswordField
              id="stepup-password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              aria-invalid={error ? true : undefined}
            />
          </Field>
          <DialogActions>
            <DialogSecondaryButton disabled={unlock.isPending} onClick={() => finish(false)}>
              Отмена
            </DialogSecondaryButton>
            <DialogPrimaryButton type="submit" disabled={unlock.isPending}>
              {unlock.isPending && <Loader2Icon className="animate-spin" aria-hidden="true" />}
              Подтвердить
            </DialogPrimaryButton>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}
