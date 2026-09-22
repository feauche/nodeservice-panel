import {
  INCIDENTS_SETTINGS_DEFAULTS,
  type IncidentsSettings,
  incidentsSettingsSchema,
} from '@nodeservice/shared';
import { RotateCcwIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { SettingsCard, Toggle } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useIncidentsSettings, useUpdateIncidentsSettings } from './incidents-settings-api';

type NumKey = 'forDurationMinutes' | 'cpuPct' | 'memPct' | 'diskPct' | 'autofixCooldownMinutes';

const toDraft = (s: IncidentsSettings) => ({
  forDurationMinutes: String(s.forDurationMinutes),
  cpuPct: String(s.cpuPct),
  memPct: String(s.memPct),
  diskPct: String(s.diskPct),
  autofixCooldownMinutes: String(s.autofixCooldownMinutes),
  autofixEnabled: s.autofixEnabled,
});
type Draft = ReturnType<typeof toDraft>;

const FIELDS: ReadonlyArray<{
  key: NumKey;
  label: string;
  hint: string;
  unit: string;
  min: number;
  max: number;
}> = [
  {
    key: 'forDurationMinutes',
    label: 'Время реакции',
    hint: 'Проблема должна держаться дольше этого времени, чтобы стать инцидентом — мгновенные скачки не считаются.',
    unit: 'мин',
    min: 1,
    max: 60,
  },
  {
    key: 'cpuPct',
    label: 'Порог CPU',
    hint: 'Инцидент, если загрузка процессора держится выше.',
    unit: '%',
    min: 50,
    max: 100,
  },
  {
    key: 'memPct',
    label: 'Порог памяти',
    hint: 'Инцидент, если занятость памяти держится выше.',
    unit: '%',
    min: 50,
    max: 100,
  },
  {
    key: 'diskPct',
    label: 'Порог диска',
    hint: 'Инцидент, если заполнение диска держится выше.',
    unit: '%',
    min: 50,
    max: 100,
  },
  {
    key: 'autofixCooldownMinutes',
    label: 'Кулдаун автопочинки',
    hint: 'Один инцидент не чинится автоматически чаще, чем раз в это время.',
    unit: 'мин',
    min: 1,
    max: 240,
  },
];

const isDefaults = (s: IncidentsSettings) =>
  (Object.keys(INCIDENTS_SETTINGS_DEFAULTS) as Array<keyof IncidentsSettings>).every(
    (k) => s[k] === INCIDENTS_SETTINGS_DEFAULTS[k],
  );

/** Настройки → «Инциденты»: пороги, время реакции, автопочинка. */
export function IncidentsSettingsPage() {
  const settings = useIncidentsSettings();
  const update = useUpdateIncidentsSettings();
  const saved = settings.data;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (saved) {
      setDraft(toDraft(saved));
      setErrors({});
    }
  }, [saved]);

  const dirty =
    Boolean(saved && draft) && JSON.stringify(draft) !== JSON.stringify(toDraft(saved as IncidentsSettings));

  const save = async () => {
    if (!draft) return;
    const parsed = incidentsSettingsSchema.safeParse(draft);
    if (!parsed.success) {
      const byPath: Record<string, string> = {};
      for (const issue of parsed.error.issues) byPath[String(issue.path[0])] ??= issue.message;
      setErrors(byPath);
      return;
    }
    setErrors({});
    try {
      await update.mutateAsync(parsed.data);
      toast.success('Настройки инцидентов сохранены.');
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  const resetToDefaults = async () => {
    try {
      await update.mutateAsync(INCIDENTS_SETTINGS_DEFAULTS);
      setErrors({});
      toast.success('Инциденты возвращены к значениям по умолчанию.');
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  return (
    <div className="max-w-[760px]">
      <SettingsCard
        title="Инциденты"
        hint="Когда панель заводит инцидент и как его чинить. Изменения действуют сразу после сохранения."
      >
        {settings.isPending && (
          <div className="mt-2 flex flex-col gap-3">
            {FIELDS.map((f) => (
              <Skeleton key={f.key} className="h-[52px] rounded-[10px]" />
            ))}
          </div>
        )}
        {settings.isError && (
          <p className="mt-2 rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px]">
            {apiErrorMessage(settings.error)}{' '}
            <button
              type="button"
              className="cursor-pointer underline"
              onClick={() => void settings.refetch()}
            >
              Повторить
            </button>
          </p>
        )}
        {draft && (
          <div className="mt-1">
            {FIELDS.map((f) => {
              const error = errors[f.key];
              return (
                <div
                  key={f.key}
                  className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-border py-3.5 first:border-t-0"
                >
                  <div className="min-w-0 flex-1 basis-[300px]">
                    <label htmlFor={`inc-${f.key}`} className="block text-[13.5px] font-medium">
                      {f.label}
                    </label>
                    <div className="mt-0.5 text-[12px] leading-normal text-text-3">{f.hint}</div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <div className="flex items-center gap-2">
                      <Input
                        id={`inc-${f.key}`}
                        inputMode="numeric"
                        value={draft[f.key]}
                        aria-invalid={error ? true : undefined}
                        onChange={(e) => {
                          setDraft({ ...draft, [f.key]: e.target.value });
                          setErrors((p) => ({ ...p, [f.key]: '' }));
                        }}
                        className="h-9 w-[88px] rounded-[10px] bg-surface-2 text-right font-mono text-[13px] tabular-nums"
                      />
                      <span className="w-8 text-[12px] text-text-3">{f.unit}</span>
                    </div>
                    {error ? (
                      <p role="alert" className="text-[11.5px] text-crit">
                        {error}
                      </p>
                    ) : (
                      <p className="text-[11.5px] text-text-3">
                        {f.min}–{f.max}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-border py-3.5">
              <div className="min-w-0 flex-1 basis-[300px]">
                <div className="text-[13.5px] font-medium">Автопочинка</div>
                <div className="mt-0.5 text-[12px] leading-normal text-text-3">
                  Панель сама применяет безопасный пресет (перезапуск Xray, очистка диска). По умолчанию
                  выключено — сначала только заводит инцидент.
                </div>
              </div>
              <Toggle
                id="inc-autofix"
                aria-label="Автопочинка"
                checked={draft.autofixEnabled}
                onChange={(v) => setDraft({ ...draft, autofixEnabled: v })}
              />
            </div>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <Button
            type="button"
            disabled={!dirty || update.isPending}
            onClick={() => void save()}
            className={cn(
              'rounded-[10px] bg-cta px-4 text-cta-foreground hover:bg-(--ns-cta-hover) disabled:opacity-50',
            )}
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
