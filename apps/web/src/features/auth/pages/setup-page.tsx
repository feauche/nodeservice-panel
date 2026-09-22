import { zodResolver } from '@hookform/resolvers/zod';
import { type SetupStartResponse, setupStartRequestSchema, totpCodeSchema } from '@nodeservice/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { apiErrorMessage, isApiError } from '@/lib/api';
import { AuthHeading, AuthShell } from '../components/auth-shell';
import { CtaButton, GhostButton } from '../components/cta-button';
import { ErrorBox } from '../components/error-box';
import { AuthInput, authCheckboxClass, Field, Fields } from '../components/field';
import { OtpField } from '../components/otp-field';
import { PasswordField } from '../components/password-field';
import { generatePassword } from '../components/password-generator';
import { PasswordMeter } from '../components/password-meter';
import { isLeakedPassword } from '../components/password-strength';
import { SetupSteps } from '../components/setup-steps';
import { authKeys, useSetupConfirm, useSetupStart } from '../queries';

/* ---------- шаг 1: учётная запись ---------- */
const step1Schema = setupStartRequestSchema.extend({ passwordConfirm: z.string() }).superRefine((v, ctx) => {
  if (isLeakedPassword(v.password)) {
    ctx.addIssue({
      code: 'custom',
      path: ['password'],
      message: 'Этот пароль есть в известных утечках. Выберите другой.',
    });
  }
  if (v.password !== v.passwordConfirm) {
    ctx.addIssue({ code: 'custom', path: ['passwordConfirm'], message: 'Пароли не совпадают.' });
  }
});
type Step1Values = z.infer<typeof step1Schema>;

interface Step1Props {
  initial: Step1Values;
  onDone: (values: Step1Values, res: SetupStartResponse) => void;
}

function Step1({ initial, onDone }: Step1Props) {
  const start = useSetupStart();
  const [serverError, setServerError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const form = useForm<Step1Values>({ resolver: zodResolver(step1Schema), defaultValues: initial });
  const { errors } = form.formState;
  const password = form.watch('password');
  // Первое поле: токен, а если он уже введён (вернулись со шага 2) — логин.
  const firstField = initial.setupToken ? 'login' : 'setupToken';

  // Генератор «печатает» пароль в оба поля и показывает его: пользователю нужно его сохранить.
  const typingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => clearInterval(typingRef.current ?? undefined), []);
  const generate = () => {
    const value = generatePassword();
    setShowPassword(true);
    form.clearErrors(['password', 'passwordConfirm']);
    const done = () => {
      form.setValue('password', value, { shouldDirty: true, shouldValidate: true });
      form.setValue('passwordConfirm', value, { shouldDirty: true, shouldValidate: true });
      toast.info('Пароль подставлен в оба поля и показан.', {
        description: 'Сохраните его в менеджере паролей.',
      });
    };
    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      done();
      return;
    }
    if (typingRef.current) clearInterval(typingRef.current);
    let i = 0;
    typingRef.current = setInterval(() => {
      i += 1;
      const part = value.slice(0, i);
      form.setValue('password', part, { shouldDirty: true });
      form.setValue('passwordConfirm', part, { shouldDirty: true });
      if (i >= value.length) {
        clearInterval(typingRef.current ?? undefined);
        typingRef.current = null;
        done();
      }
    }, 14);
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      const res = await start.mutateAsync({
        setupToken: values.setupToken,
        login: values.login,
        password: values.password,
      });
      onDone(values, res);
    } catch (e) {
      if (isApiError(e) && e.status === 422 && e.errors.length > 0) {
        for (const err of e.errors) {
          if (err.path === 'setupToken' || err.path === 'login' || err.path === 'password') {
            form.setError(err.path, { message: err.message });
          }
        }
        return;
      }
      setServerError(apiErrorMessage(e));
    }
  });

  return (
    <>
      <AuthHeading title="Учётная запись администратора">
        В панели один администратор. Пароля по умолчанию нет: создайте его сейчас.
      </AuthHeading>
      <Fields onSubmit={onSubmit}>
        <Field
          id="s-token"
          label="Токен первого запуска"
          error={errors.setupToken?.message}
          hint={
            <>
              Потеряли токен: выполните на сервере{' '}
              <code className="rounded-[5px] bg-surface-3 px-1.5 py-px font-mono text-[11.5px] whitespace-nowrap text-text-2">
                nodeservice cli setup-token
              </code>
              .
            </>
          }
        >
          <AuthInput
            id="s-token"
            autoFocus={firstField === 'setupToken'}
            autoComplete="off"
            spellCheck={false}
            placeholder="Напечатан установщиком в конце установки"
            className="font-mono placeholder:font-sans"
            aria-invalid={errors.setupToken ? true : undefined}
            aria-describedby={errors.setupToken ? 's-token-error' : 's-token-hint'}
            {...form.register('setupToken')}
          />
        </Field>
        <Field id="s-user" label="Логин" error={errors.login?.message}>
          <AuthInput
            id="s-user"
            autoFocus={firstField === 'login'}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="admin"
            aria-invalid={errors.login ? true : undefined}
            aria-describedby={errors.login ? 's-user-error' : undefined}
            {...form.register('login')}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3.5 max-[560px]:grid-cols-1">
          <Field id="s-pass" label="Пароль" error={errors.password?.message}>
            <PasswordField
              id="s-pass"
              placeholder="От 12 символов"
              autoComplete="new-password"
              show={showPassword}
              onShowChange={setShowPassword}
              onGenerate={generate}
              aria-invalid={errors.password ? true : undefined}
              aria-describedby={errors.password ? 's-pass-error' : 's-meter'}
              {...form.register('password')}
            />
          </Field>
          <Field id="s-pass2" label="Повторите пароль" error={errors.passwordConfirm?.message}>
            <PasswordField
              id="s-pass2"
              placeholder="Ещё раз"
              autoComplete="new-password"
              show={showPassword}
              onShowChange={setShowPassword}
              aria-invalid={errors.passwordConfirm ? true : undefined}
              aria-describedby={errors.passwordConfirm ? 's-pass2-error' : undefined}
              {...form.register('passwordConfirm')}
            />
          </Field>
        </div>
        <PasswordMeter
          id="s-meter"
          value={password}
          className="-mt-1.5"
          emptyHint="Введите пароль или нажмите на звёзды: панель подберёт надёжный."
        />
        {serverError && <ErrorBox>{serverError}</ErrorBox>}
        <CtaButton className="mt-1" loading={start.isPending} loadingText="Создание…">
          Создать учётную запись
        </CtaButton>
      </Fields>
    </>
  );
}

/* ---------- шаг 2: 2FA ---------- */
function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      toast.error('Не удалось скопировать. Выделите текст и скопируйте вручную.');
    }
  };
  return { copied, copy };
}

interface Step2Props {
  enroll: SetupStartResponse;
  onBack: () => void;
  onDone: (codes: string[]) => void;
}

function Step2({ enroll, onBack, onDone }: Step2Props) {
  const confirm = useSetupConfirm();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const { copied, copy } = useCopy();
  const errId = useId();
  const secretPretty = enroll.totpSecret.replace(/(.{4})/g, '$1 ').trim();

  const submit = async (value: string) => {
    if (confirm.isPending) return;
    const parsed = totpCodeSchema.safeParse(value);
    if (!parsed.success) {
      setError('Введите 6 цифр из приложения.');
      return;
    }
    setError(null);
    setInvalid(false);
    try {
      const res = await confirm.mutateAsync({ code: parsed.data });
      onDone(res.recoveryCodes);
    } catch (e) {
      setError(
        isApiError(e) && e.status === 400 && !e.detail
          ? 'Код не подошёл. Проверьте, что время на телефоне точное.'
          : apiErrorMessage(e),
      );
      setInvalid(true);
      setTimeout(() => {
        setCode('');
        setInvalid(false);
      }, 380);
    }
  };

  return (
    <>
      <AuthHeading title="Двухфакторная защита">
        Отсканируйте QR-код в приложении-аутентификаторе и введите код из него.
      </AuthHeading>
      <Fields
        onSubmit={(e) => {
          e.preventDefault();
          void submit(code);
        }}
      >
        <div className="grid grid-cols-[116px_minmax(0,1fr)] items-center gap-4 max-[520px]:grid-cols-1 max-[520px]:justify-items-center">
          <div className="size-[116px] flex-none rounded-xl border border-border bg-white p-1.5">
            <img
              src={enroll.qrDataUrl}
              alt="QR-код для приложения-аутентификатора"
              width={104}
              height={104}
              className="block size-full"
            />
          </div>
          <p className="text-[12.5px] leading-normal text-text-2 max-[520px]:text-center">
            Подойдёт Google Authenticator, Aegis, 1Password, Яндекс Ключ или любое другое приложение с TOTP.
            Если камеры нет, введите ключ вручную.
          </p>
        </div>
        <div className="flex min-w-0 items-center gap-2 rounded-[10px] border border-border bg-surface-2 py-1.5 pr-1.5 pl-3">
          <span className="flex-none text-[12px] text-text-3 max-[520px]:hidden">Ключ</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] tracking-[0.04em] select-all max-[520px]:overflow-visible max-[520px]:leading-normal max-[520px]:break-all max-[520px]:whitespace-normal">
            {secretPretty}
          </span>
          <button
            type="button"
            onClick={() => void copy(enroll.totpSecret)}
            aria-label={copied ? 'Ключ скопирован' : 'Скопировать ключ'}
            title={copied ? 'Скопировано' : 'Скопировать ключ'}
            className="grid size-[30px] flex-none cursor-pointer place-items-center rounded-[8px] text-text-3 transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand focus-visible:-outline-offset-2 [&_svg]:size-4"
          >
            {copied ? <CheckIcon className="text-ok" aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          </button>
        </div>

        <Field id="s2-otp" label="Код из приложения">
          <OtpField
            id="s2-otp"
            value={code}
            onChange={setCode}
            onComplete={(c) => void submit(c)}
            disabled={confirm.isPending}
            invalid={invalid}
            autoFocus
            aria-describedby={error ? errId : undefined}
          />
        </Field>
        {error && (
          <div id={errId}>
            <ErrorBox>{error}</ErrorBox>
          </div>
        )}
        <div className="mt-1 flex items-stretch gap-2.5">
          <GhostButton className="py-[11px] text-[13.5px]" onClick={onBack}>
            Назад
          </GhostButton>
          <CtaButton className="w-auto flex-1" loading={confirm.isPending}>
            Подтвердить и продолжить
          </CtaButton>
        </div>
      </Fields>
    </>
  );
}

/* ---------- шаг 3: коды восстановления ---------- */
function downloadText(name: string, text: string) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Step3({ codes, login, onDone }: { codes: string[]; login: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const { copied, copy } = useCopy();
  const chkId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const text = codes.join('\n');
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const download = () => {
    const head = [
      'NodeService — коды восстановления 2FA',
      `Администратор: ${login}`,
      `Выданы: ${new Date().toLocaleString('ru-RU')}`,
      'Каждый код работает один раз. Храните их в менеджере паролей.',
      '',
    ].join('\n');
    downloadText('nodeservice-recovery-codes.txt', `${head}${text}\n`);
    toast.success('Файл nodeservice-recovery-codes.txt сохранён.');
  };

  return (
    <>
      <AuthHeading ref={headingRef} tabIndex={-1} title="Коды восстановления">
        Если телефон с приложением будет недоступен, войти можно одним из этих кодов. Каждый работает один
        раз. Сохраните их в менеджере паролей: больше они не покажутся.
      </AuthHeading>
      <div className="mt-1 mb-3.5 grid grid-cols-2 gap-2">
        {codes.map((c) => (
          <span
            key={c}
            className="rounded-[8px] border border-border bg-surface-2 px-2.5 py-2 text-center font-mono text-[13px] tracking-[0.06em] select-all"
          >
            {c}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <GhostButton size="sm" className="px-[11px] py-1.5 text-xs" onClick={() => void copy(text)}>
          {copied ? 'Скопировано' : 'Скопировать все'}
        </GhostButton>
        <GhostButton size="sm" className="px-[11px] py-1.5 text-xs" onClick={download}>
          Скачать .txt
        </GhostButton>
      </div>
      <div className="mt-4 flex items-center gap-2.5">
        <Checkbox
          id={chkId}
          checked={saved}
          onCheckedChange={(v) => setSaved(v === true)}
          className={authCheckboxClass}
        />
        <Label htmlFor={chkId} className="cursor-pointer text-[13px] font-normal text-text-2">
          Коды сохранены в надёжном месте
        </Label>
      </div>
      <CtaButton type="button" className="mt-3.5" disabled={!saved} onClick={onDone}>
        Завершить и войти
      </CtaButton>
    </>
  );
}

/* ---------- мастер ---------- */
type Step = 1 | 2 | 3;

export function SetupPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>(1);
  const [values, setValues] = useState<Step1Values>({
    setupToken: '',
    login: '',
    password: '',
    passwordConfirm: '',
  });
  const [enroll, setEnroll] = useState<SetupStartResponse | null>(null);
  const [codes, setCodes] = useState<string[]>([]);

  const finish = async () => {
    // Сессия выдана на setup/confirm — сбрасываем кэш статуса, guard корня перечитает его и пустит в панель.
    qc.removeQueries({ queryKey: authKeys.all });
    await navigate({ to: '/' });
  };

  return (
    <AuthShell side={<SetupSteps current={step} />} animKey={`step-${step}`}>
      {step === 1 && (
        <Step1
          initial={values}
          onDone={(v, res) => {
            setValues(v);
            setEnroll(res);
            setStep(2);
          }}
        />
      )}
      {step === 2 && enroll && (
        <Step2
          enroll={enroll}
          onBack={() => setStep(1)}
          onDone={(c) => {
            setCodes(c);
            setStep(3);
          }}
        />
      )}
      {step === 3 && <Step3 codes={codes} login={values.login} onDone={() => void finish()} />}
    </AuthShell>
  );
}
