import { AUTH_PROBLEM, totpCodeSchema } from '@nodeservice/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { useId, useRef, useState } from 'react';

import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { apiErrorMessage, isApiError } from '@/lib/api';
import { AuthHeading, AuthLinks, AuthShell, linkClass } from '../components/auth-shell';
import { CtaButton } from '../components/cta-button';
import { ErrorBox, ThrottleBox } from '../components/error-box';
import { authCheckboxClass, Fields } from '../components/field';
import { OtpField } from '../components/otp-field';
import { useLoginTotp } from '../queries';
import { useAuthStore } from '../store';
import { useThrottle } from '../use-countdown';

export function TotpPage() {
  const navigate = useNavigate();
  const totp = useLoginTotp();
  const setPendingTotp = useAuthStore((s) => s.setPendingTotp);
  const recoveryLeft = useAuthStore((s) => s.recoveryCodesLeft);
  const [code, setCode] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const otpRef = useRef<HTMLInputElement>(null);
  const chkId = useId();
  const errId = useId();
  const wait = useThrottle(() => otpRef.current?.focus());

  const submit = async (value: string) => {
    if (totp.isPending || wait.active) return;
    const parsed = totpCodeSchema.safeParse(value);
    if (!parsed.success) {
      setError('Введи все 6 цифр кода.');
      return;
    }
    setError(null);
    setInvalid(false);
    try {
      await totp.mutateAsync({ code: parsed.data, rememberDevice: remember });
      await navigate({ to: '/' });
    } catch (e) {
      if (isApiError(e) && e.is(AUTH_PROBLEM.throttled)) {
        setCode('');
        wait.start(e.retryAfterSeconds);
        return;
      }
      setError(apiErrorMessage(e));
      setInvalid(true);
      setTimeout(() => {
        setCode('');
        setInvalid(false);
      }, 380);
    }
  };

  return (
    <AuthShell foot={<span>код меняется каждые 30 секунд</span>}>
      <AuthHeading title="Подтверждение входа">
        Введи 6-значный код из приложения-аутентификатора. Код меняется каждые 30 секунд.
      </AuthHeading>

      <Fields
        onSubmit={(e) => {
          e.preventDefault();
          void submit(code);
        }}
      >
        <OtpField
          ref={otpRef}
          value={code}
          onChange={setCode}
          onComplete={(c) => void submit(c)}
          disabled={totp.isPending || wait.active}
          invalid={invalid}
          autoFocus
          aria-describedby={error ? errId : undefined}
        />
        {wait.active ? (
          <ThrottleBox left={wait.left} />
        ) : error ? (
          <div id={errId}>
            <ErrorBox>{error}</ErrorBox>
          </div>
        ) : null}
        <div className="flex items-center gap-2.5">
          <Checkbox
            id={chkId}
            checked={remember}
            onCheckedChange={(v) => setRemember(v === true)}
            className={authCheckboxClass}
          />
          <Label htmlFor={chkId} className="cursor-pointer text-[13px] font-normal text-text-2">
            Не спрашивать код на этом устройстве 30 дней
          </Label>
        </div>
        <CtaButton className="mt-1.5" loading={totp.isPending} disabled={wait.active}>
          Подтвердить
        </CtaButton>
      </Fields>

      <AuthLinks>
        <Link to="/login" className={linkClass} onClick={() => setPendingTotp(false)}>
          ← Назад
        </Link>
        {recoveryLeft === null || recoveryLeft > 0 ? (
          <Link to="/login/recovery" className={linkClass}>
            Нет доступа к приложению — код восстановления
          </Link>
        ) : (
          <span className="text-text-3">Кодов восстановления не осталось — сброс через Rescue CLI</span>
        )}
      </AuthLinks>
    </AuthShell>
  );
}
