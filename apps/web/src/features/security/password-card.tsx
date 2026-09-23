import { changePasswordRequestSchema } from '@nodeservice/shared';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/features/auth/components/field';
import { PasswordField } from '@/features/auth/components/password-field';
import { PasswordMeter } from '@/features/auth/components/password-meter';
import { SettingsCard } from '@/features/settings/settings-ui';
import { apiErrorMessage, isApiError } from '@/lib/api';
import { toast } from '@/lib/notify';
import { useChangePassword, useSecurityOverview } from './security-api';
import { formatDate, plural } from './security-format';

/** Смена пароля: текущий пароль и есть подтверждение (step-up), остальные сессии завершаются. */
export function PasswordCard() {
  const overview = useSecurityOverview();
  const change = useChangePassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [errors, setErrors] = useState<{ current?: string; next?: string; form?: string }>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = changePasswordRequestSchema.safeParse({ currentPassword: current, newPassword: next });
    if (!parsed.success) {
      const byPath: Record<string, string> = {};
      for (const issue of parsed.error.issues) byPath[String(issue.path[0])] ??= issue.message;
      setErrors({ current: byPath.currentPassword, next: byPath.newPassword });
      return;
    }
    setErrors({});
    try {
      const res = await change.mutateAsync(parsed.data);
      setCurrent('');
      setNext('');
      toast.success(
        res.sessionsRevoked > 0
          ? `Пароль изменён. ${plural(res.sessionsRevoked, ['Завершена', 'Завершены', 'Завершено'])} ${res.sessionsRevoked} ${plural(res.sessionsRevoked, ['другая сессия', 'другие сессии', 'других сессий'])}.`
          : 'Пароль изменён.',
      );
    } catch (err) {
      if (isApiError(err) && err.status === 401) setErrors({ current: 'Неверный текущий пароль' });
      else if (isApiError(err) && err.fieldMessage('newPassword'))
        setErrors({ next: err.fieldMessage('newPassword') });
      else setErrors({ form: apiErrorMessage(err) });
    }
  };

  return (
    <SettingsCard
      title="Пароль"
      hint={overview.data ? `Последняя смена — ${formatDate(overview.data.passwordChangedAt)}` : 'Загружаю…'}
    >
      <form onSubmit={submit} className="mt-3 flex flex-col gap-3.5" noValidate>
        <Field id="pw-current" label="Текущий пароль" error={errors.current}>
          <PasswordField
            id="pw-current"
            autoComplete="current-password"
            value={current}
            onChange={(e) => {
              setCurrent(e.target.value);
              setErrors((p) => ({ ...p, current: undefined, form: undefined }));
            }}
            aria-invalid={errors.current ? true : undefined}
          />
        </Field>
        <Field
          id="pw-next"
          label="Новый пароль"
          hint="Не короче 12 символов. Проверяется по базе утечек: наружу уходят только 5 символов хеша."
          error={errors.next}
        >
          <PasswordField
            id="pw-next"
            autoComplete="new-password"
            value={next}
            onChange={(e) => {
              setNext(e.target.value);
              setErrors((p) => ({ ...p, next: undefined, form: undefined }));
            }}
            aria-invalid={errors.next ? true : undefined}
          />
          <PasswordMeter value={next} id="pw-next-meter" />
        </Field>
        {errors.form && (
          <p role="alert" className="text-[12px] text-crit">
            {errors.form}
          </p>
        )}
        <div className="flex items-center gap-3">
          <Button
            type="submit"
            disabled={!current || !next || change.isPending}
            className="rounded-[10px] bg-cta px-4 text-cta-foreground hover:bg-(--ns-cta-hover) disabled:opacity-50"
          >
            {change.isPending ? 'Меняю…' : 'Сменить пароль'}
          </Button>
          <span className="text-[11.5px] text-text-3">Другие сессии будут завершены.</span>
        </div>
      </form>
    </SettingsCard>
  );
}
