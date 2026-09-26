import {
  ASSISTANT_LEVEL_HINTS,
  ASSISTANT_LEVEL_LABELS,
  ASSISTANT_LEVEL_TOKENS,
  ASSISTANT_PERMISSION_GROUPS,
  ASSISTANT_PERMISSION_HINTS,
  ASSISTANT_PERMISSION_KEYS,
  ASSISTANT_PERMISSION_LABELS,
  ASSISTANT_PERMISSION_RISKS,
  ASSISTANT_PERMISSIONS_DEFAULT,
  ASSISTANT_PRESET_KEYS,
  ASSISTANT_PRESETS,
  ASSISTANT_PROVIDER_LABELS,
  ASSISTANT_PROVIDERS,
  ASSISTANT_RISK_LABELS,
  type AssistantLevel,
  type AssistantPermission,
  type AssistantPermissions,
  type AssistantProvider,
  type AssistantRisk,
  matchAssistantPreset,
} from '@nodeservice/shared';
import { LockIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { JarvisIcon } from '@/components/jarvis-icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { PasswordField } from '@/features/auth/components/password-field';
import { Pill, Segmented, SettingsCard, SettingsRail, Toggle } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { useAssistantSettings, useUpdateAssistantSettings } from './assistant-settings-api';

type SectionKey = 'connection' | 'behavior' | 'permissions' | 'privacy';

/** От короткого к подробному: так проще понять, что «токенов больше» справа. */
const LEVEL_ORDER: readonly AssistantLevel[] = ['pro', 'intermediate', 'novice'];

/** Один и тот же вопрос в трёх подробностях: пользователь видит, что именно меняется. */
const LEVEL_EXAMPLES: Record<AssistantLevel, string> = {
  pro: 'Таблица соединений в ядре Linux. Если она переполнена, новые соединения отбрасываются.',
  intermediate:
    'Conntrack — таблица соединений в ядре. Когда она заполняется, сервер перестаёт принимать новые подключения. Смотрите число записей и предел.',
  novice:
    'Conntrack запоминает каждое соединение, чтобы работали NAT и файрвол. Предел задаёт nf_conntrack_max. При переполнении в журнале ядра будет «table full». Как проверить и поднять предел: команды ниже.',
};

const RISK_TONE: Record<AssistantRisk, string> = {
  reads: 'bg-ok-soft text-ok',
  writes: 'bg-brand-soft text-brand',
  servers: 'bg-warn-soft text-warn',
  provider: 'bg-ai-soft text-ai',
  confirm: 'bg-surface-3 text-text-2',
};

function RiskBadge({ risk }: { risk: AssistantRisk }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-md px-2 text-[11px] font-semibold whitespace-nowrap',
        RISK_TONE[risk],
      )}
    >
      {ASSISTANT_RISK_LABELS[risk]}
    </span>
  );
}

/** Строка разрешения: название, метки риска, пояснение и переключатель. */
function PermissionRow({
  perm,
  checked,
  disabled,
  note,
  onChange,
}: {
  perm: AssistantPermission;
  checked: boolean;
  disabled?: boolean;
  note?: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3.5 border-t border-border px-4 py-3 first:border-t-0 max-sm:items-start">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] font-semibold">
          {ASSISTANT_PERMISSION_LABELS[perm]}
          {ASSISTANT_PERMISSION_RISKS[perm].map((r) => (
            <RiskBadge key={r} risk={r} />
          ))}
        </div>
        <div className="mt-0.5 text-[12.5px] text-text-3">{ASSISTANT_PERMISSION_HINTS[perm]}</div>
        {note && <div className="mt-0.5 text-[12px] text-warn">{note}</div>}
      </div>
      <Toggle
        id={`as-perm-${perm}`}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        aria-label={ASSISTANT_PERMISSION_LABELS[perm]}
      />
    </div>
  );
}

/** То, что включено всегда и без переключателя: показываем, чтобы не гадать, что ещё видит Джарвис. */
function AlwaysRow({ title, hint, risks }: { title: string; hint: string; risks: AssistantRisk[] }) {
  return (
    <div className="flex items-center gap-3.5 border-t border-border px-4 py-3 first:border-t-0 max-sm:items-start">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] font-semibold">
          {title}
          {risks.map((r) => (
            <RiskBadge key={r} risk={r} />
          ))}
        </div>
        <div className="mt-0.5 text-[12.5px] text-text-3">{hint}</div>
      </div>
      <span className="flex flex-none items-center gap-1.5 text-[12px] text-text-3">
        <LockIcon className="size-3.5" aria-hidden="true" />
        Всегда
      </span>
    </div>
  );
}

function PermissionGroup({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-surface">
      <h3 className="flex items-baseline gap-2 border-b border-border bg-surface-2 px-4 py-2.5 text-[13px] font-semibold">
        {title}
        {note && <span className="text-[12px] font-normal text-text-3">{note}</span>}
      </h3>
      {children}
    </section>
  );
}

/** Настройки → «Джарвис»: подключение, подробность ответов, разрешения и то, что уходит провайдеру. */
export function AssistantSettingsPage() {
  const settings = useAssistantSettings();
  const update = useUpdateAssistantSettings();
  const [section, setSection] = useState<SectionKey>('connection');
  const [apiKey, setApiKey] = useState('');
  const [provider, setProvider] = useState<AssistantProvider>('zveno');
  const [model, setModel] = useState('');
  const [level, setLevel] = useState<AssistantLevel>('intermediate');
  const [permissions, setPermissions] = useState<AssistantPermissions>({ ...ASSISTANT_PERMISSIONS_DEFAULT });
  const [confirmClear, setConfirmClear] = useState(false);

  const data = settings.data;
  useEffect(() => {
    if (data) {
      setProvider(data.provider);
      setModel(data.model);
      setLevel(data.level);
      setPermissions(data.permissions);
    }
  }, [data]);

  const enabled = data?.enabled ?? false;
  const dirtyConnection =
    Boolean(apiKey.trim()) || model !== (data?.model ?? '') || provider !== (data?.provider ?? 'zveno');
  const dirtyBehavior = level !== (data?.level ?? 'intermediate');
  const dirtyPermissions = data
    ? ASSISTANT_PERMISSION_KEYS.some((k) => permissions[k] !== data.permissions[k])
    : false;
  const dirty = dirtyConnection || dirtyBehavior || dirtyPermissions;

  const setPerm = (perm: AssistantPermission, value: boolean) =>
    setPermissions((prev) => {
      const next = { ...prev, [perm]: value };
      // Автоматический разбор без разбора вообще не работает: выключаем вместе.
      if (perm === 'analysis' && !value) next.autoAnalysis = false;
      return next;
    });

  const reset = () => {
    if (!data) return;
    setApiKey('');
    setProvider(data.provider);
    setModel(data.model);
    setLevel(data.level);
    setPermissions(data.permissions);
  };

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
      toast.success('Настройки Джарвиса сохранены.');
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  const clearKey = async () => {
    try {
      await update.mutateAsync({ clearKey: true });
      setConfirmClear(false);
      toast.success('Ключ удалён: Джарвис выключен.');
    } catch (err) {
      setConfirmClear(false);
      toast.error(apiErrorMessage(err));
    }
  };

  const preset = matchAssistantPreset(permissions);
  const providerName = ASSISTANT_PROVIDER_LABELS[provider];

  if (settings.isPending)
    return (
      <div className="flex gap-6 max-lg:flex-col">
        <Skeleton className="h-[200px] w-[210px] rounded-2xl max-lg:h-10 max-lg:w-full" />
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <Skeleton className="h-[76px] rounded-2xl" />
          <Skeleton className="h-[340px] rounded-2xl" />
        </div>
      </div>
    );

  return (
    <div className="flex gap-6 max-lg:flex-col">
      <SettingsRail
        label="Разделы настроек Джарвиса"
        value={section}
        onChange={setSection}
        items={[
          { key: 'connection', label: 'Подключение', dirty: dirtyConnection },
          { key: 'behavior', label: 'Поведение', dirty: dirtyBehavior },
          { key: 'permissions', label: 'Разрешения', dirty: dirtyPermissions },
          { key: 'privacy', label: 'Данные для провайдера' },
        ]}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="flex items-center gap-3.5 rounded-2xl border border-border bg-[linear-gradient(90deg,var(--color-ai-soft),transparent_70%)] bg-surface px-4 py-3.5">
          <span className="grid size-11 flex-none place-items-center rounded-full border-2 border-ai text-ai shadow-[0_0_0_4px_var(--color-ai-soft)]">
            <JarvisIcon className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-heading text-[16px] font-bold">Джарвис</div>
            <div className="text-[12.5px] text-text-3">
              {enabled
                ? 'Ключ задан: Джарвис отвечает в чате, разбирает инциденты и подсказывает в терминале.'
                : 'Ключ не задан: чат, разбор инцидентов и подсказки не работают.'}
            </div>
          </div>
          <Pill tone={enabled ? 'ok' : 'muted'}>{enabled ? 'Включён' : 'Выключен'}</Pill>
        </div>

        <div
          key={section}
          className="flex flex-col gap-4 animate-in fade-in-0 slide-in-from-bottom-1 duration-200"
        >
          {section === 'connection' && (
            <SettingsCard
              title="Подключение"
              hint="Куда обращается Джарвис за ответами. Ключ хранится в панели зашифрованным."
            >
              <div className="mt-2 flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="as-provider" className="text-[13.5px] font-medium">
                    Провайдер
                  </label>
                  <span className="text-[12px] text-text-3">Шлюз к моделям. Другие добавим позже.</span>
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

                <div className="flex flex-col gap-1.5 border-t border-border pt-4">
                  <label htmlFor="as-model" className="text-[13.5px] font-medium">
                    Модель
                  </label>
                  <span className="text-[12px] text-text-3">
                    Название модели у провайдера, например{' '}
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

                <div className="flex flex-col gap-1.5 border-t border-border pt-4">
                  <div className="flex items-center justify-between gap-3">
                    <label htmlFor="as-key" className="text-[13.5px] font-medium">
                      Ключ (API key провайдера)
                    </label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={update.isPending || !enabled}
                      onClick={() => setConfirmClear(true)}
                      className="h-7 rounded-[8px] border-crit/35 bg-crit-soft px-2.5 text-[12px] text-crit hover:brightness-110 disabled:opacity-50"
                    >
                      Убрать ключ
                    </Button>
                  </div>
                  <span className="text-[12px] text-text-3">
                    {enabled
                      ? 'Ключ уже сохранён. Введите новый, чтобы заменить.'
                      : `Ключ из личного кабинета ${providerName}.`}
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
          )}

          {section === 'behavior' && (
            <SettingsCard
              title="Подробность ответов"
              hint="Как подробно Джарвис объясняет. Влияет на длину ответов и на расход токенов у провайдера."
            >
              <div className="mt-3 flex flex-col gap-4">
                <Segmented
                  label="Подробность ответов"
                  value={level}
                  onChange={setLevel}
                  items={LEVEL_ORDER.map((l) => ({ key: l, label: ASSISTANT_LEVEL_LABELS[l] }))}
                />
                <p className="text-[12.5px] text-text-2">{ASSISTANT_LEVEL_HINTS[level]}</p>
                <div className="flex flex-wrap gap-2">
                  {LEVEL_ORDER.map((l) => (
                    <span
                      key={l}
                      className={cn(
                        'inline-flex h-[22px] items-center rounded-full px-2.5 text-[11.5px] font-semibold transition-colors',
                        l === level ? 'bg-brand-soft text-brand' : 'bg-surface-3 text-text-3',
                      )}
                    >
                      {ASSISTANT_LEVEL_TOKENS[l]}
                    </span>
                  ))}
                </div>
                <div>
                  <div className="mb-2 text-[12.5px] font-semibold">
                    Пример: вопрос «Что такое conntrack?»
                  </div>
                  <div className="grid gap-3 lg:grid-cols-3">
                    {LEVEL_ORDER.map((l) => (
                      <div
                        key={l}
                        className={cn(
                          'rounded-[11px] border bg-surface-2 px-3 py-2.5 text-[12.5px] leading-[1.5] text-text-2 transition-colors',
                          l === level ? 'border-brand/60' : 'border-border opacity-70',
                        )}
                      >
                        <b className="text-foreground">{ASSISTANT_LEVEL_LABELS[l]}.</b> {LEVEL_EXAMPLES[l]}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </SettingsCard>
          )}

          {section === 'permissions' && (
            <>
              <div className="rounded-2xl border border-border bg-surface px-4 py-3.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <h2 className="text-[14.5px] font-semibold">Готовые наборы</h2>
                  <span className="text-[12.5px] text-text-3">
                    {preset ? 'Одним нажатием, дальше можно поправить.' : 'Сейчас настроено вручную.'}
                  </span>
                </div>
                <div
                  role="radiogroup"
                  aria-label="Готовые наборы разрешений"
                  className="mt-3 grid gap-2.5 md:grid-cols-3"
                >
                  {ASSISTANT_PRESET_KEYS.map((k) => (
                    // biome-ignore lint/a11y/useSemanticElements: карточка-переключатель со своей раскладкой
                    <button
                      key={k}
                      type="button"
                      role="radio"
                      aria-checked={preset === k}
                      onClick={() => setPermissions({ ...ASSISTANT_PRESETS[k].permissions })}
                      className={cn(
                        'cursor-pointer rounded-xl border px-3.5 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-brand',
                        preset === k
                          ? 'border-brand bg-brand-soft'
                          : 'border-border bg-surface hover:bg-surface-2',
                      )}
                    >
                      <div className="font-heading text-[14px] font-bold">{ASSISTANT_PRESETS[k].label}</div>
                      <div className="mt-0.5 text-[12px] text-text-3">{ASSISTANT_PRESETS[k].description}</div>
                    </button>
                  ))}
                </div>
              </div>

              <PermissionGroup title="Всегда включено" note="без переключателей">
                <AlwaysRow
                  title="Метрики, инциденты, Журнал, база знаний"
                  hint="Видит состояние парка и историю событий."
                  risks={['reads', 'provider']}
                />
                <AlwaysRow
                  title="Автоглоссарий «Пояснения»"
                  hint="Термины и аббревиатуры пополняют закреплённую статью в базе знаний."
                  risks={['writes']}
                />
              </PermissionGroup>

              {ASSISTANT_PERMISSION_GROUPS.map((g) => (
                <PermissionGroup key={g.key} title={g.title} note={g.note}>
                  {g.keys.map((k) => (
                    <PermissionRow
                      key={k}
                      perm={k}
                      checked={permissions[k]}
                      disabled={k === 'autoAnalysis' && !permissions.analysis}
                      note={
                        k === 'autoAnalysis' && !permissions.analysis
                          ? 'Сначала включите «Разбор по кнопке».'
                          : undefined
                      }
                      onChange={(v) => setPerm(k, v)}
                    />
                  ))}
                </PermissionGroup>
              ))}
              <p className="px-1 text-[12px] text-text-3">
                Джарвис сам ничего не меняет: изменения серверов, инцидентов и автопочинки он лишь предлагает
                карточкой, а применяете их вы.
              </p>
            </>
          )}

          {section === 'privacy' && (
            <SettingsCard
              title="Данные для провайдера"
              hint={`Что уходит провайдеру нейросети (${providerName}), когда Джарвис отвечает. Зависит от разрешений.`}
            >
              <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-[13px] text-text-2">
                <li>Метрики, состояние серверов и их названия.</li>
                <li>Инциденты, их хронология и попытки починки.</li>
                <li>Журнал событий и статьи базы знаний, которые нужны для ответа.</li>
                {permissions.reach && (
                  <li>Итог проверки доступности: какие порты открыты с других серверов парка.</li>
                )}
                {permissions.processes && (
                  <li>Имена самых тяжёлых процессов и проценты CPU и памяти, без командных строк.</li>
                )}
                {permissions.nodeLogs && (
                  <li>Последние строки журнала ноды. Секреты, uuid, адреса и почта в них скрываются.</li>
                )}
                {permissions.terminalHints && (
                  <li>
                    Только по вашей кнопке: последние строки терминала. Секреты, uuid, адреса и почта в них
                    скрываются.
                  </li>
                )}
              </ul>
              <p className="mt-3 text-[12.5px] text-text-3">
                Ключ хранится в панели зашифрованным и используется только для запросов к провайдеру.
              </p>
            </SettingsCard>
          )}
        </div>

        <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface/95 px-4 py-2.5 shadow-pop backdrop-blur">
          <span className="text-[12.5px] text-text-3" aria-live="polite">
            {dirty ? (
              <>
                <span className="mr-1.5 inline-block size-1.5 rounded-full bg-warn align-middle" />
                <span className="max-sm:hidden">Есть несохранённые изменения</span>
                <span className="sm:hidden">Не сохранено</span>
              </>
            ) : (
              'Изменения попадают в Журнал.'
            )}
          </span>
          <span className="flex-1" />
          {dirty && (
            <Button
              type="button"
              variant="outline"
              disabled={update.isPending}
              onClick={reset}
              className="rounded-[10px] px-4"
            >
              Отменить
            </Button>
          )}
          <Button
            type="button"
            disabled={update.isPending || !dirty}
            onClick={() => void save()}
            className="rounded-[10px] bg-cta px-4 text-cta-foreground hover:bg-(--ns-cta-hover) disabled:opacity-50"
          >
            {update.isPending ? 'Сохраняю…' : 'Сохранить'}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        kind="crit"
        title="Убрать ключ модели?"
        description="Джарвис выключится, пока вы не добавите ключ снова."
        yesLabel="Да, убрать"
        loading={update.isPending}
        onConfirm={clearKey}
      />
    </div>
  );
}
