import {
  AGENT_HEARTBEAT_SECONDS,
  AGENT_OFFLINE_MIN_SECONDS,
  AUTOCHECKS_DEFAULTS,
  type AutochecksSettings,
  autochecksSettingsSchema,
} from '@nodeservice/shared';
import { ActivityIcon, RotateCcwIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { useAutochecks, useUpdateAutochecks } from './settings-api';
import {
  BarButton,
  NumberField,
  SaveBar,
  SectionHeader,
  SettingsCard,
  SettingsRow,
  Toggle,
} from './settings-ui';

/** Черновик формы: интервалы — строками, чтобы можно было спокойно печатать. */
const toDraft = (s: AutochecksSettings) => ({
  sshEnabled: s.sshEnabled,
  sshAgentEnabled: s.sshAgentEnabled,
  agentOfflineEnabled: s.agentOfflineEnabled,
  metricsEnabled: s.metricsEnabled,
  sshIntervalMinutes: String(s.sshIntervalMinutes),
  sshAgentIntervalMinutes: String(s.sshAgentIntervalMinutes),
  agentOfflineAfterSeconds: String(s.agentOfflineAfterSeconds),
  metricsIntervalSeconds: String(s.metricsIntervalSeconds),
});
type Draft = ReturnType<typeof toDraft>;
type ToggleKey = 'sshEnabled' | 'sshAgentEnabled' | 'agentOfflineEnabled' | 'metricsEnabled';
type ValueKey =
  | 'sshIntervalMinutes'
  | 'sshAgentIntervalMinutes'
  | 'agentOfflineAfterSeconds'
  | 'metricsIntervalSeconds';

const CHECKS: ReadonlyArray<{
  id: string;
  on: ToggleKey;
  val: ValueKey;
  label: string;
  hint: string;
  unit: string;
  min: number;
  max: number;
}> = [
  {
    id: 'ac-ssh',
    on: 'sshEnabled',
    val: 'sshIntervalMinutes',
    label: 'Серверы без агента',
    hint: 'Панель проверяет их по SSH — это единственный способ узнать, что сервер жив.',
    unit: 'мин',
    min: 5,
    max: 1440,
  },
  {
    id: 'ac-ssh-agent',
    on: 'sshAgentEnabled',
    val: 'sshAgentIntervalMinutes',
    label: 'Серверы с агентом',
    hint: 'Живость видна по регулярному сигналу агента; SSH проверяется реже — как контроль доступа.',
    unit: 'мин',
    min: 15,
    max: 10_080,
  },
  {
    id: 'ac-offline',
    on: 'agentOfflineEnabled',
    val: 'agentOfflineAfterSeconds',
    label: 'Агент не в сети',
    hint: `Агент подаёт сигнал раз в ${AGENT_HEARTBEAT_SECONDS} секунд. Если сигнала нет дольше порога, сервер помечается «агент не в сети» (попадает в Журнал). Порог — не меньше ${AGENT_OFFLINE_MIN_SECONDS} секунд.`,
    unit: 'сек',
    min: AGENT_OFFLINE_MIN_SECONDS,
    max: 600,
  },
  {
    id: 'ac-metrics',
    on: 'metricsEnabled',
    val: 'metricsIntervalSeconds',
    label: 'Метрики агента',
    hint: 'Как часто агент присылает CPU, память, диск и сеть; частота уходит агенту при подключении.',
    unit: 'сек',
    min: 5,
    max: 120,
  },
];

const isDefaults = (s: AutochecksSettings) =>
  (Object.keys(AUTOCHECKS_DEFAULTS) as Array<keyof AutochecksSettings>).every(
    (k) => s[k] === AUTOCHECKS_DEFAULTS[k],
  );

/** Настройки → «Автопроверки»: каждая фоновая проверка — тумблер + интервал; «По умолчанию» возвращает раздел целиком. */
export function AutochecksPage() {
  const autochecks = useAutochecks();
  const update = useUpdateAutochecks();
  const saved = autochecks.data;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (saved) {
      setDraft(toDraft(saved));
      setErrors({});
    }
  }, [saved]);

  const dirty =
    Boolean(saved && draft) && JSON.stringify(draft) !== JSON.stringify(toDraft(saved as AutochecksSettings));

  const save = async () => {
    if (!draft) return;
    const parsed = autochecksSettingsSchema.safeParse(draft);
    if (!parsed.success) {
      const byPath: Record<string, string> = {};
      for (const issue of parsed.error.issues) byPath[String(issue.path[0])] ??= issue.message;
      setErrors(byPath);
      return;
    }
    setErrors({});
    try {
      await update.mutateAsync(parsed.data);
      toast.success('Автопроверки сохранены.');
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  const resetToDefaults = async () => {
    try {
      await update.mutateAsync(AUTOCHECKS_DEFAULTS);
      setErrors({});
      toast.success('Автопроверки возвращены к значениям по умолчанию.');
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  return (
    <div className="flex flex-col gap-3.5">
      <SectionHeader
        icon={ActivityIcon}
        title="Автопроверки"
        description="Фоновые проверки панели и агента: что проверяем и как часто. Действуют сразу после сохранения."
      />
      <SettingsCard title="Проверки" hint="Выключенная проверка не запускается совсем.">
        {autochecks.isPending && (
          <div className="flex flex-col gap-3 py-3">
            {CHECKS.map((c) => (
              <Skeleton key={c.id} className="h-[52px] rounded-[10px]" />
            ))}
          </div>
        )}
        {autochecks.isError && (
          <p className="my-3 rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px]">
            {apiErrorMessage(autochecks.error)}{' '}
            <button
              type="button"
              className="cursor-pointer underline"
              onClick={() => void autochecks.refetch()}
            >
              Повторить
            </button>
          </p>
        )}
        {draft &&
          CHECKS.map((c) => {
            const enabled = draft[c.on];
            const error = errors[c.val];
            return (
              <SettingsRow
                key={c.id}
                label={c.label}
                htmlFor={`${c.id}-interval`}
                hint={
                  error ? (
                    <span role="alert" className="text-crit">
                      {error}
                    </span>
                  ) : (
                    c.hint
                  )
                }
              >
                <NumberField
                  id={`${c.id}-interval`}
                  value={draft[c.val]}
                  unit={c.unit}
                  min={c.min}
                  max={c.max}
                  disabled={!enabled}
                  invalid={Boolean(error)}
                  onChange={(v) => {
                    setDraft({ ...draft, [c.val]: v });
                    setErrors((p) => ({ ...p, [c.val]: '' }));
                  }}
                />
                <Toggle
                  id={`${c.id}-toggle`}
                  aria-label={c.label}
                  checked={enabled}
                  onChange={(v) => setDraft({ ...draft, [c.on]: v })}
                />
              </SettingsRow>
            );
          })}
      </SettingsCard>
      <SaveBar
        dirty={dirty}
        pending={update.isPending}
        onSave={() => void save()}
        onReset={() => {
          if (saved) setDraft(toDraft(saved));
          setErrors({});
        }}
        extra={
          <BarButton
            disabled={update.isPending || !saved || isDefaults(saved)}
            onClick={() => void resetToDefaults()}
          >
            <RotateCcwIcon aria-hidden="true" />
            По умолчанию
          </BarButton>
        }
      />
    </div>
  );
}
