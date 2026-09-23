import {
  type CreateServerRequest,
  createServerRequestSchema,
  type SshAuth,
  type TestConnectionResponse,
} from '@nodeservice/shared';
import { CheckIcon, CircleAlertIcon, ClockIcon, Loader2Icon } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { DialogPrimaryButton, DialogSecondaryButton } from '@/components/dialog-actions';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Field, Fields } from '@/features/auth/components/field';
import { PasswordField } from '@/features/auth/components/password-field';
import { ProviderSelect } from '@/features/providers/provider-select';
import { apiErrorMessage, isApiError } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { useCreateServer, useTestConnection } from './servers-api';

const AUTH_TABS = [
  { key: 'password', label: 'Пароль' },
  { key: 'key', label: 'Свой ключ' },
  { key: 'panel-key', label: 'Ключ панели' },
] as const;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/* ---------- живой ход проверки ---------- */
type StepState = 'wait' | 'run' | 'ok' | 'fail';
interface Step {
  key: 'ssh' | 'hostkey' | 'facts' | 'create' | 'agent';
  label: string;
  state: StepState;
  detail?: string;
}
const INITIAL_STEPS: Step[] = [
  { key: 'ssh', label: 'Подключение по SSH', state: 'wait' },
  { key: 'hostkey', label: 'Отпечаток сервера', state: 'wait' },
  { key: 'facts', label: 'Факты о системе', state: 'wait' },
  { key: 'create', label: 'Добавление в панель', state: 'wait' },
  { key: 'agent', label: 'Агент', state: 'wait' },
];

function factsLine(t: TestConnectionResponse): string {
  return (
    [
      t.facts.hostname,
      t.facts.os,
      t.facts.osVersion,
      t.facts.arch,
      t.facts.cpuCores ? `${t.facts.cpuCores} CPU` : null,
      t.facts.memoryMb ? `${Math.round(t.facts.memoryMb / 1024)} ГБ RAM` : null,
    ]
      .filter(Boolean)
      .join(' · ') || 'сведений нет'
  );
}

const STEP_ICON: Record<StepState, typeof CheckIcon> = {
  wait: ClockIcon,
  run: Loader2Icon,
  ok: CheckIcon,
  fail: CircleAlertIcon,
};
const STEP_TONE: Record<StepState, string> = {
  wait: 'text-text-3',
  run: 'text-brand',
  ok: 'text-ok',
  fail: 'text-crit',
};

/** Ход проверки прямо в диалоге: каждый шаг со своим состоянием и подробностью. */
function StepLog({ steps }: { steps: Step[] }) {
  return (
    <ol
      data-testid="test-result"
      aria-live="polite"
      className="flex flex-col gap-2 rounded-[10px] border border-border bg-bg-2 px-3.5 py-3"
    >
      {steps.map((st) => {
        const Icon = STEP_ICON[st.state];
        return (
          <li key={st.key} className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-2.5 text-[12.5px]">
            <Icon
              className={cn('mt-[3px] size-4', STEP_TONE[st.state], st.state === 'run' && 'animate-spin')}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <div className={cn('font-medium', st.state === 'wait' ? 'text-text-3' : 'text-foreground')}>
                {st.label}
                <span className="sr-only">
                  {st.state === 'ok'
                    ? ': готово'
                    : st.state === 'fail'
                      ? ': ошибка'
                      : st.state === 'run'
                        ? ': идёт'
                        : ''}
                </span>
              </div>
              {st.detail && (
                <div
                  className={cn(
                    'mt-0.5 break-all',
                    st.key === 'hostkey' && 'font-mono text-[11.5px]',
                    st.state === 'fail' ? 'text-crit' : 'text-text-2',
                  )}
                >
                  {st.detail}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Добавление сервера: адрес и доступ по SSH → «Проверить и добавить» — проверка идёт прямо в
 * диалоге по шагам (подключение, отпечаток, факты, добавление). Пароль используется один раз для
 * установки ключа панели и не сохраняется. Для ключей можно добавить и без проверки.
 */
/** Подпись обязательного поля: красная звёздочка через CSS, чтобы имя поля для читалок и тестов не менялось. */
function Req({ children }: { children: string }) {
  return (
    <>
      {children}
      <span className="ml-0.5 text-crit after:content-['*']" aria-hidden="true" />
    </>
  );
}

export function AddServerDialog({ open, onOpenChange }: Props) {
  const test = useTestConnection();
  const create = useCreateServer();
  const [form, setForm] = useState({ name: '', host: '', port: '22', sshUser: 'root', tags: '', notes: '' });
  const [providerId, setProviderId] = useState<string | null>(null);
  const [authTab, setAuthTab] = useState<(typeof AUTH_TABS)[number]['key']>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [steps, setSteps] = useState<Step[] | null>(null);
  /** Сервер уже создан, диалог вот-вот закроется: форма заморожена, чтобы не начать второй ввод в том же окне. */
  const [finishing, setFinishing] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // biome-ignore lint/correctness/useExhaustiveDependencies: сброс формы только при закрытии
  useEffect(() => {
    if (!open) {
      setForm({ name: '', host: '', port: '22', sshUser: 'root', tags: '', notes: '' });
      setProviderId(null);
      setAuthTab('password');
      setPassword('');
      setPrivateKey('');
      setPassphrase('');
      setSteps(null);
      setFinishing(false);
      setErrors({});
      test.reset();
      create.reset();
    }
  }, [open]);

  const auth = useMemo<SshAuth>(() => {
    if (authTab === 'password') return { method: 'password', password };
    if (authTab === 'key') return { method: 'key', privateKey, ...(passphrase ? { passphrase } : {}) };
    return { method: 'panel-key' };
  }, [authTab, password, privateKey, passphrase]);

  const buildRequest = (): CreateServerRequest | null => {
    const tags = form.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const parsed = createServerRequestSchema.safeParse({
      name: form.name,
      host: form.host,
      port: form.port,
      sshUser: form.sshUser,
      auth,
      tags,
      providerId,
      ...(form.notes.trim() ? { notes: form.notes } : {}),
    });
    if (!parsed.success) {
      const byPath: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] === 'auth' ? (issue.path[1] ?? 'auth') : issue.path[0]);
        byPath[key] ??= issue.message;
      }
      setErrors(byPath);
      return null;
    }
    setErrors({});
    return parsed.data;
  };

  const applyApiError = (err: unknown) => {
    if (isApiError(err) && err.errors.length > 0) {
      const byPath: Record<string, string> = {};
      for (const e of err.errors) byPath[e.path] ??= e.message;
      setErrors(byPath);
      return;
    }
    setErrors({ form: apiErrorMessage(err) });
  };

  const patchStep = (key: Step['key'], patch: Partial<Step>) =>
    setSteps((prev) => (prev ?? INITIAL_STEPS).map((st) => (st.key === key ? { ...st, ...patch } : st)));

  /** Проверить и добавить: шаги идут по мере ответа API, форма остаётся на месте при ошибке. */
  const doVerifyAndCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const req = buildRequest();
    if (!req) return;
    setSteps(INITIAL_STEPS.map((st) => ({ ...st })));
    patchStep('ssh', { state: 'run', detail: `${req.sshUser}@${req.host}:${req.port}` });
    const t0 = performance.now();
    let checked: TestConnectionResponse;
    try {
      checked = await test.mutateAsync(req);
    } catch (err) {
      patchStep('ssh', { state: 'fail', detail: apiErrorMessage(err) });
      applyApiError(err);
      return;
    }
    patchStep('ssh', { state: 'ok', detail: `${Math.max(1, Math.round(performance.now() - t0))} мс` });
    patchStep('hostkey', { state: 'ok', detail: checked.hostKeyFingerprint });
    patchStep('facts', { state: 'ok', detail: factsLine(checked) });
    patchStep('create', { state: 'run' });
    try {
      const server = await create.mutateAsync({ ...req, verify: true });
      patchStep('create', { state: 'ok', detail: `«${server.name}» в списке серверов` });
      patchStep('agent', {
        state: 'ok',
        detail: 'Устанавливается в фоне по SSH; статус «Агент в сети» появится на карточке через минуту',
      });
      // Даём увидеть завершённый ход проверки, потом закрываем; форма на это время заморожена.
      setFinishing(true);
      await new Promise((r) => setTimeout(r, 700));
      onOpenChange(false);
      toast.success(
        req.auth.method === 'password'
          ? `«${server.name}» добавлен. Ключ панели установлен, пароль не сохранён.`
          : `«${server.name}» добавлен.`,
      );
    } catch (err) {
      // Ошибки полей подсвечиваются у самих полей — в шаге только короткая отсылка, без дублирования текста.
      const fieldErrors = isApiError(err) && err.errors.length > 0;
      patchStep('create', {
        state: 'fail',
        detail: fieldErrors ? 'Исправьте отмеченные поля' : apiErrorMessage(err),
      });
      applyApiError(err);
    }
  };

  /** Ключи можно добавить сразу: SSH проверится по расписанию или вручную с карточки. */
  const doCreateUnverified = async () => {
    if (busy) return;
    const req = buildRequest();
    if (!req) return;
    try {
      const server = await create.mutateAsync({ ...req, verify: false });
      onOpenChange(false);
      toast.success(`«${server.name}» добавлен без проверки. SSH проверится по расписанию или вручную.`);
    } catch (err) {
      applyApiError(err);
    }
  };

  const busy = test.isPending || create.isPending || finishing;
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    setErrors((p) => ({ ...p, [key]: '', form: '' }));
  };
  const inputClass = 'h-10 rounded-[10px] bg-surface-2';
  const monoClass = `${inputClass} font-mono text-[13px]`;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100vh-48px)] flex-col gap-0 overflow-hidden rounded-2xl border-border bg-surface p-0 sm:max-w-[640px]"
      >
        <DialogHeader className="flex-none gap-1 px-6 pt-5 pb-1 sm:px-7">
          <DialogTitle className="font-heading text-[18px]">Добавить сервер</DialogTitle>
          <DialogDescription className="text-[13px] text-text-2">
            Понадобятся адрес и доступ по SSH. Панель проверит связь, запомнит отпечаток сервера и сразу
            поставит на него агента: это systemd-служба без входящих портов, она сама подключается к панели.
            Без агента метрик не будет.
          </DialogDescription>
        </DialogHeader>

        <Fields
          id="add-server-form"
          className="min-h-0 flex-1 gap-4 overflow-y-auto px-6 pt-4 pb-5 sm:px-7"
          onSubmit={doVerifyAndCreate}
        >
          <div className="grid gap-3.5 sm:grid-cols-2">
            <Field id="srv-name" label={<Req>Название</Req>} error={errors.name || undefined}>
              <Input
                id="srv-name"
                disabled={busy}
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={errors.name ? 'srv-name-error' : undefined}
                placeholder="de-fra-01"
                value={form.name}
                onChange={set('name')}
                className={inputClass}
              />
            </Field>
            <Field id="srv-tags" label="Теги" error={errors.tags || undefined}>
              <Input
                id="srv-tags"
                disabled={busy}
                aria-invalid={errors.tags ? true : undefined}
                aria-describedby={errors.tags ? 'srv-tags-error' : undefined}
                placeholder="prod, de"
                value={form.tags}
                onChange={set('tags')}
                className={inputClass}
              />
            </Field>
          </div>
          <Field id="srv-provider" label="Провайдер" error={errors.providerId || undefined}>
            <ProviderSelect
              id="srv-provider"
              value={providerId}
              disabled={busy}
              onChange={(id) => {
                setProviderId(id);
                setErrors((p) => ({ ...p, providerId: '', form: '' }));
              }}
              className="bg-surface-2"
            />
          </Field>
          <div className="grid gap-3.5 sm:grid-cols-[minmax(0,1fr)_100px_150px]">
            <Field id="srv-host" label={<Req>IP или домен</Req>} error={errors.host || undefined}>
              <Input
                id="srv-host"
                disabled={busy}
                aria-invalid={errors.host ? true : undefined}
                aria-describedby={errors.host ? 'srv-host-error' : undefined}
                placeholder="203.0.113.7"
                value={form.host}
                onChange={set('host')}
                className={monoClass}
              />
            </Field>
            <Field id="srv-port" label="Порт" error={errors.port || undefined}>
              <Input
                id="srv-port"
                disabled={busy}
                aria-invalid={errors.port ? true : undefined}
                aria-describedby={errors.port ? 'srv-port-error' : undefined}
                inputMode="numeric"
                value={form.port}
                onChange={set('port')}
                className={monoClass}
              />
            </Field>
            <Field id="srv-user" label={<Req>Пользователь</Req>} error={errors.sshUser || undefined}>
              <Input
                id="srv-user"
                disabled={busy}
                aria-invalid={errors.sshUser ? true : undefined}
                aria-describedby={errors.sshUser ? 'srv-user-error' : undefined}
                value={form.sshUser}
                onChange={set('sshUser')}
                className={monoClass}
              />
            </Field>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium text-text-2">Доступ</span>
              <fieldset className="m-0 flex h-10 items-center rounded-[10px] border border-border bg-surface-2 p-[3px]">
                <legend className="sr-only">Способ входа</legend>
                {AUTH_TABS.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    aria-pressed={authTab === t.key}
                    className={cn(
                      'h-full flex-1 cursor-pointer rounded-[7px] px-3 text-[12.5px] font-medium text-text-3 transition-colors hover:text-foreground',
                      authTab === t.key && 'bg-surface text-foreground shadow-[0_0_0_1px_var(--ns-border-2)]',
                    )}
                    disabled={busy}
                    onClick={() => {
                      setAuthTab(t.key);
                      setSteps(null);
                      setErrors({});
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </fieldset>
            </div>
            {authTab === 'password' && (
              <Field
                id="srv-password"
                label={<Req>Пароль</Req>}
                hint="Нужен один раз: панель поставит свой ключ и дальше будет ходить только по нему."
                error={errors.password || undefined}
              >
                <PasswordField
                  id="srv-password"
                  disabled={busy}
                  aria-invalid={errors.password ? true : undefined}
                  aria-describedby={errors.password ? 'srv-password-error' : undefined}
                  autoComplete="off"
                  placeholder="Пароль пользователя SSH"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setErrors((p) => ({ ...p, password: '', form: '' }));
                  }}
                />
              </Field>
            )}
            {authTab === 'key' && (
              <>
                <Field
                  id="srv-key"
                  label={<Req>Приватный ключ (OpenSSH/PEM)</Req>}
                  error={errors.privateKey || undefined}
                >
                  <textarea
                    id="srv-key"
                    disabled={busy}
                    aria-invalid={errors.privateKey ? true : undefined}
                    aria-describedby={errors.privateKey ? 'srv-key-error' : undefined}
                    rows={4}
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                    className="w-full resize-y rounded-[10px] border border-border bg-surface-2 px-3 py-2 font-mono text-[12px] outline-none focus-visible:border-brand/50"
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  />
                </Field>
                <Field id="srv-pass" label="Пароль от ключа (если есть)">
                  <PasswordField
                    id="srv-pass"
                    disabled={busy}
                    autoComplete="off"
                    placeholder="Оставьте пустым, если ключ без пароля"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                  />
                </Field>
              </>
            )}
            {authTab === 'panel-key' && (
              <p className="text-[12.5px] leading-normal text-text-2">
                Публичный ключ панели уже должен быть в authorized_keys на сервере. Взять его можно в окне
                любого сервера на вкладке «Подключение».
              </p>
            )}
          </div>

          <Field id="srv-notes" label="Заметка" error={errors.notes || undefined}>
            <Input
              id="srv-notes"
              disabled={busy}
              aria-invalid={errors.notes ? true : undefined}
              aria-describedby={errors.notes ? 'srv-notes-error' : undefined}
              placeholder="Необязательно: срок оплаты, тариф, для чего сервер"
              value={form.notes}
              onChange={set('notes')}
              className={inputClass}
            />
          </Field>

          {steps && <StepLog steps={steps} />}
          {errors.form && !steps && (
            <p role="alert" className="text-[12px] text-crit">
              {errors.form}
            </p>
          )}
        </Fields>

        {/* Футер: слева подсказка или запасной путь, справа действия одной высоты */}
        <div className="flex flex-none items-center gap-3 border-t border-border bg-bg-2 px-6 py-3.5 max-sm:flex-col max-sm:items-stretch sm:px-7">
          <div className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
            {authTab === 'password' ? (
              'Пароль используется один раз и не сохраняется.'
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => void doCreateUnverified()}
                className="cursor-pointer text-brand underline-offset-2 hover:underline disabled:opacity-50"
              >
                Добавить без проверки
              </button>
            )}
          </div>
          <div className="flex gap-2 max-sm:flex-col">
            <DialogSecondaryButton
              disabled={busy}
              onClick={() => onOpenChange(false)}
              className="h-10 flex-none rounded-[10px] px-4 sm:max-w-none"
            >
              Отмена
            </DialogSecondaryButton>
            <DialogPrimaryButton
              type="submit"
              form="add-server-form"
              disabled={busy}
              className="h-10 flex-none rounded-[10px] px-4 sm:max-w-none"
            >
              {busy && <Loader2Icon className="animate-spin" aria-hidden="true" />}
              Проверить и добавить
            </DialogPrimaryButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
