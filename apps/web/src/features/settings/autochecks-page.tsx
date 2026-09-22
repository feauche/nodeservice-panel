import { AUTOCHECKS_DEFAULTS, type AutochecksSettings, autochecksSettingsSchema } from '@nodeservice/shared';
import { RotateCcwIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAutochecks, useUpdateAutochecks } from './settings-api';
import { SettingsCard, Toggle } from './settings-ui';

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
    hint: 'Живость видна по heartbeat агента; SSH проверяется реже — как контроль доступа.',
    unit: 'мин',
    min: 15,
    max: 10_080,
  },
  {
    id: 'ac-offline',
    on: 'agentOfflineEnabled',
    val: 'agentOfflineAfterSeconds',
    label: 'Агент не в сети',
    hint: 'Если heartbeat молчит дольше порога, сервер помечается «агент не в сети» (попадает в Журнал).',
    unit: 'сек',
    min: 10,
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
    <div className="max-w-[760px]">
      <SettingsCard
        title="Автопроверки"
        hint="Фоновые проверки панели и агента: что проверяем и как часто. Изменения действуют сразу после сохранения."
      >
        {autochecks.isPending && (
          <div className="mt-2 flex flex-col gap-3">
            {CHECKS.map((c) => (
              <Skeleton key={c.id} className="h-[52px] rounded-[10px]" />
            ))}
          </div>
        )}
        {autochecks.isError && (
          <p className="mt-2 rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px]">
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
        {draft && (
          <div className="mt-1">
            {CHECKS.map((c) => {
              const enabled = draft[c.on];
              const error = errors[c.val];
              return (
                <div
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-border py-3.5 first:border-t-0"
                >
                  <div className="flex min-w-0 flex-1 basis-[300px] items-start gap-3">
                    <div className="pt-0.5">
                      <Toggle
                        id={`${c.id}-toggle`}
                        aria-label={c.label}
                        checked={enabled}
                        onChange={(v) => setDraft({ ...draft, [c.on]: v })}
                      />
                    </div>
                    <div className="min-w-0">
                      <label htmlFor={`${c.id}-interval`} className="block text-[13.5px] font-medium">
                        {c.label}
                      </label>
                      <div className="mt-0.5 text-[12px] leading-normal text-text-3">{c.hint}</div>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <div className={cn('flex items-center gap-2', !enabled && 'opacity-50')}>
                      <Input
                        id={`${c.id}-interval`}
                        inputMode="numeric"
                        disabled={!enabled}
                        value={draft[c.val]}
                        aria-invalid={error ? true : undefined}
                        onChange={(e) => {
                          setDraft({ ...draft, [c.val]: e.target.value });
                          setErrors((p) => ({ ...p, [c.val]: '' }));
                        }}
                        className="h-9 w-[88px] rounded-[10px] bg-surface-2 text-right font-mono text-[13px] tabular-nums"
                      />
                      <span className="w-8 text-[12px] text-text-3">{c.unit}</span>
                    </div>
                    {error ? (
                      <p role="alert" className="text-[11.5px] text-crit">
                        {error}
                      </p>
                    ) : (
                      <p className="text-[11.5px] text-text-3">
                        {c.min}–{c.max}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <Button
            type="button"
            disabled={!dirty || update.isPending}
            onClick={() => void save()}
            className="rounded-[10px] bg-cta px-4 text-cta-foreground hover:bg-(--ns-cta-hover) disabled:opacity-50"
          >
            {update.isPending ? 'Сохраняю…' : 'Сохранить'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={update.isPending || !saved || isDefaults(saved)}
            onClick={() => void resetToDefaults()}
            className="rounded-[10px] border-border bg-surface-2 px-4 text-text-2 hover:bg-surface-3 hover:text-foreground"
          >
            <RotateCcwIcon className="size-4" aria-hidden="true" />
            По умолчанию
          </Button>
          <span className="text-[11.5px] text-text-3">Изменение попадает в Журнал.</span>
        </div>
      </SettingsCard>
    </div>
  );
}
