import { zodResolver } from '@hookform/resolvers/zod';
import { AUTH_PROBLEM, type RecoveryLoginRequest, recoveryLoginRequestSchema } from '@nodeservice/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { apiErrorMessage, isApiError } from '@/lib/api';
import { plural } from '@/lib/plural';
import { AuthHeading, AuthLinks, AuthShell, linkClass } from '../components/auth-shell';
import { CtaButton } from '../components/cta-button';
import { ErrorBox, ThrottleBox } from '../components/error-box';
import { AuthInput, Field, Fields } from '../components/field';
import { InfoBox } from '../components/info-box';
import { useLoginRecovery } from '../queries';
import { useAuthStore } from '../store';
import { useThrottle } from '../use-countdown';

export function RecoveryPage() {
  const navigate = useNavigate();
  const recovery = useLoginRecovery();
  const recoveryLeft = useAuthStore((s) => s.recoveryCodesLeft);
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<RecoveryLoginRequest>({
    resolver: zodResolver(recoveryLoginRequestSchema),
    defaultValues: { code: '' },
  });
  const { errors } = form.formState;
  const wait = useThrottle(() => form.setFocus('code'));
  const locked = wait.active;
  const none = recoveryLeft !== null && recoveryLeft <= 0;

  const onSubmit = form.handleSubmit(async (values) => {
    if (locked) return;
    setServerError(null);
    try {
      const res = await recovery.mutateAsync({ code: values.code.toUpperCase().replace(/\s+/g, '') });
      if (typeof res.recoveryCodesLeft === 'number') {
        const n = res.recoveryCodesLeft;
        toast.warning(`Осталось ${n} ${plural(n, 'код', 'кода', 'кодов')} восстановления.`, {
          description: 'Если приложение потеряно, перевыпустите 2FA в настройках безопасности.',
        });
      }
      await navigate({ to: '/' });
    } catch (e) {
      if (isApiError(e) && e.is(AUTH_PROBLEM.throttled)) {
        wait.start(e.retryAfterSeconds);
        return;
      }
      setServerError(apiErrorMessage(e));
      form.setFocus('code');
    }
  });

  return (
    <AuthShell foot={<span>Каждый код работает один раз</span>}>
      <AuthHeading title="Код восстановления">
        Один из 10 кодов, выданных при настройке 2FA. Каждый работает один раз. Запомненные устройства после
        входа сбрасываются.
        {recoveryLeft !== null && (
          <>
            {' '}
            Осталось: <b>{recoveryLeft}</b>.
          </>
        )}
      </AuthHeading>

      {none ? (
        <InfoBox>
          Кодов не осталось. Отключите 2FA из консоли сервера панели и настройте заново:
          <br />
          <code>nodeservice cli disable-2fa</code>
        </InfoBox>
      ) : (
        <Fields onSubmit={onSubmit}>
          <Field id="r-code" label="Код" error={errors.code?.message}>
            <AuthInput
              id="r-code"
              autoFocus
              placeholder="XXXXX-XXXXX"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              disabled={locked}
              className="font-mono tracking-[0.08em] uppercase"
              aria-invalid={errors.code ? true : undefined}
              aria-describedby={errors.code ? 'r-code-error' : undefined}
              {...form.register('code')}
            />
          </Field>
          {locked ? (
            <ThrottleBox left={wait.left} />
          ) : serverError ? (
            <ErrorBox>{serverError}</ErrorBox>
          ) : null}
          <CtaButton className="mt-1.5" loading={recovery.isPending} disabled={locked}>
            Войти
          </CtaButton>
        </Fields>
      )}

      <AuthLinks>
        <Link to="/login/2fa" className={linkClass}>
          ← К коду из приложения
        </Link>
      </AuthLinks>
    </AuthShell>
  );
}
