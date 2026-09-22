import {
  ASSISTANT_LEVEL_HINTS,
  ASSISTANT_LEVEL_LABELS,
  ASSISTANT_LEVELS,
  ASSISTANT_PERMISSION_HINTS,
  ASSISTANT_PERMISSION_KEYS,
  ASSISTANT_PERMISSION_LABELS,
  ASSISTANT_PROVIDER_LABELS,
  ASSISTANT_PROVIDERS,
  type AssistantLevel,
  type AssistantPermissions,
  type AssistantProvider,
} from '@nodeservice/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { PasswordField } from '@/features/auth/components/password-field';
import { Pill, SettingsCard, SettingsRow, Toggle } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { useAssistantSettings, useUpdateAssistantSettings } from './assistant-settings-api';

const PERMS_DEFAULT: AssistantPermissions = { kbWrite: true, glossary: true, kbReview: true };

/** Настройки → «Ассистент»: ключ модели (шифруется) и выбор модели. */
export function AssistantSettingsPage() {
  const settings = useAssistantSettings();
  const update = useUpdateAssistantSettings();
  const [apiKey, setApiKey] = useState('');
  const [provider, setProvider] = useState<AssistantProvider>('zveno');
  const [model, setModel] = useState('');
  const [level, setLevel] = useState<AssistantLevel>('intermediate');
  const [permissions, setPermissions] = useState<AssistantPermissions>(PERMS_DEFAULT);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (settings.data) {
      setProvider(settings.data.provider);
      setModel(settings.data.model);
      setLevel(settings.data.level);
      setPermissions(settings.data.permissions);
    }
  }, [settings.data]);

  const enabled = settings.data?.enabled ?? false;
  const data = settings.data;
  const dirty =
    Boolean(apiKey.trim()) ||
    model !== (data?.model ?? '') ||
    provider !== (data?.provider ?? 'zveno') ||
    level !== (data?.level ?? 'intermediate') ||
    (data ? ASSISTANT_PERMISSION_KEYS.some((k) => permissions[k] !== data.permissions[k]) : false);

  const save = async () => {
    try {
      await update.mutateAsync({
        provider,
        model: model.trim(),
        level,
        permissions,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setApiKey('');
      toast.success('Настройки ассистента сохранены.');
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  const clearKey = async () => {
    try {
      await update.mutateAsync({ clearKey: true });
      setConfirmClear(false);
      toast.success('Ключ удалён — ассистент выключен.');
    } catch (err) {
      setConfirmClear(false);
      toast.error(apiErrorMessage(err));
    }
  };

  return (
    <div>
      {settings.isPending && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-[320px] rounded-2xl" />
          <Skeleton className="h-[320px] rounded-2xl" />
        </div>
      )}
      {settings.data && (
        <>
          <div className="grid items-start gap-4 lg:grid-cols-2">
            {/* Слева — подключение к провайдеру */}
            <SettingsCard
              title="Подключение"
              hint="Ключ модели хранится в панели зашифрованным. Ассистент видит метрики, Журнал и базу знаний, но действия только предлагает — запускаешь ты."
            >
              <div className="mt-1 flex flex-col gap-4">
                <div className="flex items-center justify-between gap-3 border-t border-border py-3.5 first:border-t-0">
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-medium">Состояние</div>
                    <div className="mt-0.5 text-[12px] text-text-3">
                      {enabled
                        ? 'Ключ задан — ассистент отвечает на вопросы.'
                        : 'Ключ не задан — ассистент выключен.'}
                    </div>
                  </div>
                  <Pill tone={enabled ? 'ok' : 'muted'}>{enabled ? 'включён' : 'выключен'}</Pill>
                </div>

                <div className="flex flex-col gap-1.5 border-t border-border pt-3.5">
                  <label htmlFor="as-provider" className="text-[13.5px] font-medium">
                    Провайдер
                  </label>
                  <span className="text-[12px] text-text-3">Шлюз к моделям. Позже добавим другие.</span>
                  <Select value={provider} onValueChange={(v) => setProvider(v as AssistantProvider)}>
                    <SelectTrigger id="as-provider" aria-label="Провайдер" className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ASSISTANT_PROVIDERS.map((p) => (
                        <SelectItem key={p} value={p}>
                          {ASSISTANT_PROVIDER_LABELS[p]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5 border-t border-border pt-3.5">
                  <label htmlFor="as-model" className="text-[13.5px] font-medium">
                    Модель
                  </label>
                  <span className="text-[12px] text-text-3">
                    Впиши название модели у провайдера, например{' '}
                    <code className="rounded bg-surface-2 px-1 font-mono text-[11.5px]">
                      anthropic/claude-sonnet-4-5
                    </code>{' '}
                    или{' '}
                    <code className="rounded bg-surface-2 px-1 font-mono text-[11.5px]">openai/gpt-4o</code>.
                  </span>
                  <Input
                    id="as-model"
                    aria-label="Модель"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="anthropic/claude-sonnet-4-5"
                    className="mt-1 h-10 rounded-[10px] bg-surface-2 font-mono text-[13px]"
                  />
                </div>

                <div className="flex flex-col gap-1.5 border-t border-border pt-3.5">
                  <label htmlFor="as-key" className="text-[13.5px] font-medium">
                    Ключ (API key провайдера)
                  </label>
                  <span className="text-[12px] text-text-3">
                    {enabled
                      ? 'Ключ уже сохранён. Введи новый, чтобы заменить.'
                      : 'Ключ из личного кабинета zveno.ai.'}
                  </span>
                  <PasswordField
                    id="as-key"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={enabled ? '•••••••• (сохранён)' : 'sk-…'}
                    className="mt-1"
                  />
                </div>
              </div>
            </SettingsCard>

            {/* Справа — поведение самого агента */}
            <SettingsCard
              title="Поведение и разрешения"
              hint="Насколько подробно отвечает агент и что ему позволено делать. Настройки он только читает — менять их не может."
            >
              <div className="mt-1 flex flex-col gap-4">
                <div className="flex flex-col gap-1.5 border-t border-border pt-3.5 first:border-t-0 first:pt-0">
                  <label htmlFor="as-level" className="text-[13.5px] font-medium">
                    Уровень пользователя
                  </label>
                  <span className="text-[12px] text-text-3">{ASSISTANT_LEVEL_HINTS[level]}</span>
                  <Select value={level} onValueChange={(v) => setLevel(v as AssistantLevel)}>
                    <SelectTrigger id="as-level" aria-label="Уровень" className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ASSISTANT_LEVELS.map((l) => (
                        <SelectItem key={l} value={l}>
                          {ASSISTANT_LEVEL_LABELS[l]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col border-t border-border pt-3.5">
                  <div className="text-[13.5px] font-medium">Разрешения</div>
                  <span className="mt-0.5 text-[12px] text-text-3">
                    Что агенту позволено делать в системе.
                  </span>
                  <div className="mt-1">
                    {ASSISTANT_PERMISSION_KEYS.map((k) => (
                      <SettingsRow
                        key={k}
                        label={ASSISTANT_PERMISSION_LABELS[k]}
                        hint={ASSISTANT_PERMISSION_HINTS[k]}
                      >
                        <Toggle
                          id={`as-perm-${k}`}
                          checked={permissions[k]}
                          onChange={(v) => setPermissions((prev) => ({ ...prev, [k]: v }))}
                          aria-label={ASSISTANT_PERMISSION_LABELS[k]}
                        />
                      </SettingsRow>
                    ))}
                  </div>
                </div>
              </div>
            </SettingsCard>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              type="button"
              disabled={update.isPending || !dirty}
              onClick={() => void save()}
              className="rounded-[10px] bg-cta px-4 text-cta-foreground hover:bg-(--ns-cta-hover) disabled:opacity-50"
            >
              {update.isPending ? 'Сохраняю…' : 'Сохранить'}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={update.isPending || !enabled}
              onClick={() => setConfirmClear(true)}
              className="rounded-[10px] border-crit/35 bg-crit-soft px-4 text-crit hover:brightness-110 disabled:opacity-50"
            >
              Убрать ключ
            </Button>
            <span className="text-[11.5px] text-text-3">Изменение попадает в Журнал.</span>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        kind="crit"
        title="Убрать ключ модели?"
        description="Ассистент выключится, пока не добавишь ключ снова."
        yesLabel="Да, убрать"
        loading={update.isPending}
        onConfirm={clearKey}
      />
    </div>
  );
}
