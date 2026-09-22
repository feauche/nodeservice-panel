import {
  type CreateServerRequest,
  createServerRequestSchema,
  type SshAuth,
  type TestConnectionResponse,
} from '@nodeservice/shared';
import { CheckIcon, Loader2Icon } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { DialogActions, DialogPrimaryButton, DialogSecondaryButton } from '@/components/dialog-actions';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Field, Fields } from '@/features/auth/components/field';
import { PasswordField } from '@/features/auth/components/password-field';
import { apiErrorMessage, isApiError } from '@/lib/api';
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

/**
 * Добавление сервера (требование 3.7): доступы SSH → проверка подключения (факты + отпечаток) →
 * создание. Пароль используется один раз для установки ключа панели и не сохраняется.
 */
export function AddServerDialog({ open, onOpenChange }: Props) {
  const test = useTestConnection();
  const create = useCreateServer();
  const [form, setForm] = useState({ name: '', host: '', port: '22', sshUser: 'root', tags: '', notes: '' });
  const [authTab, setAuthTab] = useState<(typeof AUTH_TABS)[number]['key']>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [checked, setChecked] = useState<TestConnectionResponse | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // biome-ignore lint/correctness/useExhaustiveDependencies: сброс формы только при закрытии
  useEffect(() => {
    if (!open) {
      setForm({ name: '', host: '', port: '22', sshUser: 'root', tags: '', notes: '' });
      setAuthTab('password');
      setPassword('');
      setPrivateKey('');
      setPassphrase('');
      setChecked(null);
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

  const doTest = async () => {
    const req = buildRequest();
    if (!req) return;
    setChecked(null);
    try {
      setChecked(await test.mutateAsync(req));
    } catch (err) {
      applyApiError(err);
    }
  };

  const doCreate = async (e: FormEvent) => {
    e.preventDefault();
    const req = buildRequest();
    if (!req) return;
    // Без предварительной проверки и не по паролю — добавляем сразу, SSH проверится позже.
    const instant = !checked && req.auth.method !== 'password';
    try {
      const server = await create.mutateAsync({ ...req, verify: !instant });
      onOpenChange(false);
      toast.success(
        instant
          ? `«${server.name}» добавлен без проверки — SSH проверится по расписанию или вручную.`
          : req.auth.method === 'password'
            ? `«${server.name}» добавлен. Ключ панели установлен, пароль не сохранён.`
            : `«${server.name}» добавлен.`,
      );
    } catch (err) {
      applyApiError(err);
    }
  };

  const busy = test.isPending || create.isPending;
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    setChecked(null);
    setErrors((p) => ({ ...p, [key]: '', form: '' }));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[calc(100vh-64px)] sm:max-w-[680px] overflow-y-auto rounded-2xl border-border bg-surface p-6 sm:p-7">
        <DialogHeader>
          <DialogTitle className="font-heading text-[17px]">Добавить сервер</DialogTitle>
          <DialogDescription className="text-[12.5px] text-text-2">
            {authTab === 'password'
              ? 'Панель подключится по SSH, поставит свой ключ и зафиксирует отпечаток сервера. Пароль используется один раз — для установки ключа — и не сохраняется.'
              : 'Можно проверить подключение сразу — или просто добавить: тогда статус будет «SSH не проверен», и проверка пройдёт автоматически по расписанию или вручную.'}
          </DialogDescription>
        </DialogHeader>

        <Fields className="mt-3 gap-4" onSubmit={doCreate}>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <Field id="srv-name" label="Название" error={errors.name || undefined}>
              <Input
                id="srv-name"
                placeholder="de-fra-01"
                value={form.name}
                onChange={set('name')}
                className="h-10 rounded-[10px] bg-surface-2"
              />
            </Field>
            <Field id="srv-tags" label="Теги (через запятую)" error={errors.tags || undefined}>
              <Input
                id="srv-tags"
                placeholder="prod, de"
                value={form.tags}
                onChange={set('tags')}
                className="h-10 rounded-[10px] bg-surface-2"
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_110px_200px]">
            <Field id="srv-host" label="IP или домен" error={errors.host || undefined}>
              <Input
                id="srv-host"
                placeholder="203.0.113.7"
                value={form.host}
                onChange={set('host')}
                className="h-10 rounded-[10px] bg-surface-2 font-mono text-[13px]"
              />
            </Field>
            <Field id="srv-port" label="Порт" error={errors.port || undefined}>
              <Input
                id="srv-port"
                inputMode="numeric"
                value={form.port}
                onChange={set('port')}
                className="h-10 rounded-[10px] bg-surface-2 font-mono text-[13px]"
              />
            </Field>
            <Field id="srv-user" label="Пользователь SSH" error={errors.sshUser || undefined}>
              <Input
                id="srv-user"
                value={form.sshUser}
                onChange={set('sshUser')}
                className="h-10 rounded-[10px] bg-surface-2 font-mono text-[13px]"
              />
            </Field>
          </div>
          <div>
            <fieldset className="m-0 flex h-9 w-fit items-center rounded-[10px] border border-border bg-surface-2 p-[3px]">
              <legend className="sr-only">Способ входа</legend>
              {AUTH_TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  aria-pressed={authTab === t.key}
                  className={cn(
                    'h-full cursor-pointer rounded-[7px] px-3 text-[12px] font-medium text-text-3 transition-colors hover:text-foreground',
                    authTab === t.key && 'bg-surface text-foreground shadow-[0_1px_0_var(--ns-hairline)]',
                  )}
                  onClick={() => {
                    setAuthTab(t.key);
                    setChecked(null);
                    setErrors({});
                  }}
                >
                  {t.label}
                </button>
              ))}
            </fieldset>
            <div className="mt-3 flex flex-col gap-3.5">
              {authTab === 'password' && (
                <Field
                  id="srv-password"
                  label="Пароль"
                  hint="Нужен один раз: панель поставит свой ключ и дальше будет ходить только по нему."
                  error={errors.password || undefined}
                >
                  <PasswordField
                    id="srv-password"
                    autoComplete="off"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      setChecked(null);
                    }}
                  />
                </Field>
              )}
              {authTab === 'key' && (
                <>
                  <Field
                    id="srv-key"
                    label="Приватный ключ (OpenSSH/PEM)"
                    error={errors.privateKey || undefined}
                  >
                    <textarea
                      id="srv-key"
                      rows={4}
                      value={privateKey}
                      onChange={(e) => {
                        setPrivateKey(e.target.value);
                        setChecked(null);
                      }}
                      className="w-full resize-y rounded-[10px] border border-border bg-surface-2 px-3 py-2 font-mono text-[12px] outline-none focus-visible:border-brand/50"
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    />
                  </Field>
                  <Field id="srv-pass" label="Пароль от ключа (если есть)">
                    <PasswordField
                      id="srv-pass"
                      autoComplete="off"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                    />
                  </Field>
                </>
              )}
              {authTab === 'panel-key' && (
                <p className="text-[12.5px] text-text-2">
                  Ключ панели уже установлен на сервере (например, добавлен вручную из «публичный ключ
                  панели»).
                </p>
              )}
            </div>
          </div>

          <Field id="srv-notes" label="Заметка (необязательно)" error={errors.notes || undefined}>
            <Input
              id="srv-notes"
              value={form.notes}
              onChange={set('notes')}
              className="h-10 rounded-[10px] bg-surface-2"
            />
          </Field>

          {checked && (
            <div
              className="rounded-[12px] border border-ok/30 bg-ok-soft/60 px-4 py-3 text-[12.5px]"
              data-testid="test-result"
            >
              <div className="flex items-center gap-2 font-semibold text-ok">
                <CheckIcon className="size-4" aria-hidden="true" />
                Подключение работает
              </div>
              <dl className="mt-1.5 grid gap-x-6 gap-y-0.5 text-foreground sm:grid-cols-2">
                <div>
                  {[checked.facts.hostname, checked.facts.os, checked.facts.osVersion]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </div>
                <div>
                  {[
                    checked.facts.arch,
                    checked.facts.cpuCores ? `${checked.facts.cpuCores} CPU` : null,
                    checked.facts.memoryMb ? `${Math.round(checked.facts.memoryMb / 1024)} ГБ RAM` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </dl>
              <p className="mt-1 break-all font-mono text-[11px] text-text-3">{checked.hostKeyFingerprint}</p>
            </div>
          )}
          {errors.form && (
            <p role="alert" className="text-[12px] text-crit">
              {errors.form}
            </p>
          )}

          <DialogActions>
            <DialogSecondaryButton disabled={busy} onClick={() => void doTest()}>
              {test.isPending && <Loader2Icon className="animate-spin" aria-hidden="true" />}
              Проверить подключение
            </DialogSecondaryButton>
            <DialogPrimaryButton type="submit" disabled={busy}>
              {create.isPending && <Loader2Icon className="animate-spin" aria-hidden="true" />}
              Добавить сервер
            </DialogPrimaryButton>
          </DialogActions>
        </Fields>
      </DialogContent>
    </Dialog>
  );
}
