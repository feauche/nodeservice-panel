import {
  INCIDENTS_SETTINGS_DEFAULTS,
  type IncidentsSettings,
  incidentsSettingsUpdateSchema,
} from '@nodeservice/shared';
import { RotateCcwIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import {
  BarButton,
  NumberField,
  SaveBar,
  SectionHeader,
  SettingsCard,
  SettingsRow,
  Toggle,
} from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
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
    label: 'Порог процессора',
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
    label: 'Пауза между автопочинками',
    hint: 'Если панель уже чинила этот сигнал на сервере, новое дело того же вида она сама чинить не станет, пока не пройдёт это время: шаг ждёт вашего подтверждения, а после паузы запускается сам. Шаги одной цепочки идут подряд.',
    unit: 'мин',
    min: 1,
    max: 240,
  },
];

/** Политика по сигналам и пауза живут на странице «Автопочинка» — здесь их не сравниваем и не сбрасываем. */
const SCALAR_DEFAULTS = (({ policy: _p, pausedUntil: _u, ...rest }) => rest)(INCIDENTS_SETTINGS_DEFAULTS);
/**
 * Форма проверяется и отправляется только своими полями. Полная схема настроек подставила бы в запрос
 * пустые режимы по сигналам и «паузы нет» — и сохранение раздела стёрло бы выбранное на «Автопочинке».
 */
const FORM_SCHEMA = incidentsSettingsUpdateSchema.required();
const isDefaults = (s: IncidentsSettings) =>
  (Object.keys(SCALAR_DEFAULTS) as Array<keyof typeof SCALAR_DEFAULTS>).every(
    (k) => s[k] === SCALAR_DEFAULTS[k],
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
    const parsed = FORM_SCHEMA.safeParse(draft);
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
      await update.mutateAsync(SCALAR_DEFAULTS);
      setErrors({});
      toast.success('Инциденты возвращены к значениям по умолчанию.');
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  const row = (f: (typeof FIELDS)[number]) => {
    if (!draft) return null;
    const error = errors[f.key];
    return (
      <SettingsRow
        key={f.key}
        label={f.label}
        htmlFor={`inc-${f.key}`}
        hint={
          error ? (
            <span role="alert" className="text-crit">
              {error}
            </span>
          ) : (
            f.hint
          )
        }
      >
        <NumberField
          id={`inc-${f.key}`}
          value={draft[f.key]}
          unit={f.unit}
          min={f.min}
          max={f.max}
          invalid={Boolean(error)}
          onChange={(v) => {
            setDraft({ ...draft, [f.key]: v });
            setErrors((p) => ({ ...p, [f.key]: '' }));
          }}
        />
      </SettingsRow>
    );
  };

  return (
    <div className="flex flex-col gap-3.5">
      <SectionHeader
        icon={TriangleAlertIcon}
        title="Инциденты"
        description="Когда панель заводит инцидент и как его чинит. Действуют сразу после сохранения."
      />
      {settings.isPending && <Skeleton className="h-[320px] rounded-[14px]" />}
      {settings.isError && (
        <p className="rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px]">
          {apiErrorMessage(settings.error)}{' '}
          <button type="button" className="cursor-pointer underline" onClick={() => void settings.refetch()}>
            Повторить
          </button>
        </p>
      )}
      {draft && (
        <>
          <SettingsCard title="Пороги" hint="Когда проблема на сервере становится инцидентом.">
            {FIELDS.filter((f) => f.key !== 'autofixCooldownMinutes').map(row)}
          </SettingsCard>
          <SettingsCard
            title="Автопочинка"
            hint="Безопасные шаги для сигналов с режимом «Само». Подробно — «Инциденты → Автопочинка»."
          >
            <SettingsRow
              label="Автопочинка"
              htmlFor="inc-autofix"
              hint="По умолчанию выключена — сначала панель только заводит инцидент."
            >
              <Toggle
                id="inc-autofix"
                aria-label="Автопочинка"
                checked={draft.autofixEnabled}
                onChange={(v) => setDraft({ ...draft, autofixEnabled: v })}
              />
            </SettingsRow>
            {FIELDS.filter((f) => f.key === 'autofixCooldownMinutes').map(row)}
          </SettingsCard>
        </>
      )}
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
