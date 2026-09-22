import { zodResolver } from '@hookform/resolvers/zod';
import { AUTH_PROBLEM, type LoginRequest, loginRequestSchema } from '@nodeservice/shared';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { apiErrorMessage, isApiError } from '@/lib/api';
import { AuthHeading, AuthLinks, AuthShell, linkClass } from '../components/auth-shell';
import { CtaButton } from '../components/cta-button';
import { ErrorBox, ThrottleBox } from '../components/error-box';
import { AuthInput, Field, Fields } from '../components/field';
import { InfoBox } from '../components/info-box';
import { PasswordField } from '../components/password-field';
import { useLogin } from '../queries';
import { useThrottle } from '../use-countdown';

export function LoginPage() {
  const navigate = useNavigate();
  const login = useLogin();
  const [forgot, setForgot] = useState(false);
  const form = useForm<LoginRequest>({
    resolver: zodResolver(loginRequestSchema),
    defaultValues: { login: '', password: '' },
  });
  const { errors } = form.formState;
  const [serverError, setServerError] = useState<string | null>(null);
  const wait = useThrottle(() => form.setFocus('password'));
  const locked = wait.active;

  const onSubmit = form.handleSubmit(async (values) => {
    if (locked) return;
    setServerError(null);
    try {
      const res = await login.mutateAsync(values);
      if (res.next === 'totp') await navigate({ to: '/login/2fa' });
      else await navigate({ to: '/' });
    } catch (e) {
      if (isApiError(e) && e.is(AUTH_PROBLEM.throttled)) {
        wait.start(e.retryAfterSeconds);
        setServerError(null);
        return;
      }
      setServerError(apiErrorMessage(e));
      form.resetField('password');
      form.setFocus('password');
    }
  });

  return (
    <AuthShell foot={<span>NodeService · панель управления серверами</span>}>
      <AuthHeading title="Вход в панель">Управление парком серверов · только для администратора</AuthHeading>

      <Fields onSubmit={onSubmit}>
        <Field id="l-user" label="Логин" error={errors.login?.message}>
          <AuthInput
            id="l-user"
            autoFocus
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="admin"
            disabled={locked}
            aria-invalid={errors.login ? true : undefined}
            aria-describedby={errors.login ? 'l-user-error' : undefined}
            {...form.register('login')}
          />
        </Field>
        <Field id="l-pass" label="Пароль" error={errors.password?.message}>
          <PasswordField
            id="l-pass"
            disabled={locked}
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? 'l-pass-error' : undefined}
            {...form.register('password')}
          />
        </Field>

        {locked ? <ThrottleBox left={wait.left} /> : serverError ? <ErrorBox>{serverError}</ErrorBox> : null}

        <CtaButton className="mt-1.5" loading={login.isPending} disabled={locked}>
          Войти
        </CtaButton>
      </Fields>

      <AuthLinks>
        <button
          type="button"
          className={linkClass}
          onClick={() => setForgot((v) => !v)}
          aria-expanded={forgot}
        >
          Забыл пароль?
        </button>
        <span className="text-text-3">пароль + код 2FA</span>
      </AuthLinks>
      {forgot && (
        <InfoBox className="mt-3">
          Почты для сброса нет — панель твоя. Восстановление — через Rescue CLI на сервере панели:
          <br />
          <code>docker exec -it nodeservice cli</code>
          <br />
          Там: сбросить пароль · отключить 2FA · очистить список IP · завершить все сессии. Работает только из
          консоли сервера.
        </InfoBox>
      )}
    </AuthShell>
  );
}
