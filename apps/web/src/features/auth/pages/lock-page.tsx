import { zodResolver } from '@hookform/resolvers/zod';
import { type UnlockRequest, unlockRequestSchema } from '@nodeservice/shared';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { apiErrorMessage } from '@/lib/api';
import { AuthLinks, AuthShell, linkClass } from '../components/auth-shell';
import { CtaButton } from '../components/cta-button';
import { ErrorBox } from '../components/error-box';
import { Field, Fields } from '../components/field';
import { LogoutDialog } from '../components/logout-dialog';
import { PasswordField } from '../components/password-field';
import { useUnlock } from '../queries';
import { initialsOf, useAuthStore } from '../store';

export function LockPage() {
  const navigate = useNavigate();
  const me = useAuthStore((s) => s.me);
  const unlock = useUnlock();
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<UnlockRequest>({
    resolver: zodResolver(unlockRequestSchema),
    defaultValues: { password: '' },
  });
  const { errors } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      await unlock.mutateAsync(values);
      await navigate({ to: '/' });
    } catch (e) {
      setServerError(apiErrorMessage(e));
      form.resetField('password');
      form.setFocus('password');
    }
  });

  return (
    <AuthShell hideLogo foot={<span>NodeService. Панель управления серверами</span>}>
      <div className="mb-5 flex min-w-0 items-center gap-3.5">
        <div
          aria-hidden="true"
          className="grid size-[46px] flex-none place-items-center rounded-xl bg-[linear-gradient(150deg,var(--ns-accent),var(--ns-teal))] font-heading text-base font-bold text-(--ns-on-accent)"
        >
          {initialsOf(me?.login)}
        </div>
        <div className="min-w-0">
          <h2 className="mb-[5px] text-xl">Экран заблокирован</h2>
          <div className="truncate text-[13px] text-text-2">
            {me?.login ?? 'Администратор'} · Сессия сохранена
          </div>
        </div>
      </div>

      <Fields onSubmit={onSubmit}>
        <Field id="k-pass" label="Пароль" error={errors.password?.message}>
          <PasswordField
            id="k-pass"
            autoFocus
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? 'k-pass-error' : undefined}
            {...form.register('password')}
          />
        </Field>
        {serverError && <ErrorBox>{serverError}</ErrorBox>}
        <CtaButton className="mt-1.5" loading={unlock.isPending}>
          Разблокировать
        </CtaButton>
      </Fields>

      <AuthLinks>
        <button type="button" className={linkClass} onClick={() => setLogoutOpen(true)}>
          Выйти из учётной записи
        </button>
        <span className="text-text-3">Заблокировано вручную</span>
      </AuthLinks>
      <LogoutDialog open={logoutOpen} onOpenChange={setLogoutOpen} />
    </AuthShell>
  );
}
