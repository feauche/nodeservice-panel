import {
  MONITORING_DEFAULTS,
  type MonitoringSettings,
  monitoringSettingsUpdateSchema,
} from '@nodeservice/shared';
import { useCallback, useEffect, useState } from 'react';
import { UnsavedChangesGuard } from '@/components/unsaved-changes-guard';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { IncidentTelegramCard, useIncidentTelegramDraft } from './monitoring-telegram-card';
import { useMonitoring, useUpdateMonitoring } from './settings-api';
import {
  BarButton,
  NumberField,
  RowButton,
  SaveBar,
  SectionHeader,
  SettingsCard,
  SettingsRow,
  SettingsSkeleton,
  Toggle,
} from './settings-ui';

type Key = keyof MonitoringSettings;
type Field = {
  key: Key;
  label: string;
  hint: string;
  unit?: string;
  min?: number;
  max?: number;
  /** Дробное число (нагрузка на ядро): в поле с запятой, на сервер — числом. */
  decimal?: boolean;
};
const sections: Record<'checks' | 'incidents', { title: string; hint?: string; fields: Field[] }[]> = {
  checks: [
    {
      title: 'Данные Remnawave',
      hint: 'Опрос API панели и метрики всех подключённых нод.',
      fields: [
        {
          key: 'enabled',
          label: 'Мониторинг нод',
          hint: 'Получать свежие данные и создавать события по выбранным условиям.',
        },
        {
          key: 'pollSeconds',
          label: 'Частота опроса',
          hint: 'Remnawave сама обновляет ноды раз в 10 секунд, чаще опрашивать незачем. Каждый новый опрос — одно подтверждение проблемы.',
          unit: 'сек',
          min: 10,
          max: 900,
        },
        {
          key: 'apiTimeoutSeconds',
          label: 'Ожидание ответа API',
          hint: 'Ошибка API не означает, что все ноды недоступны.',
          unit: 'сек',
          min: 5,
          max: 60,
        },
        {
          key: 'staleAfterMinutes',
          label: 'Срок актуальности данных',
          hint: 'По устаревшим данным новые события не создаются.',
          unit: 'мин',
          min: 2,
          max: 60,
        },
      ],
    },
    {
      title: 'Доступность из РФ · Check-Host',
      hint: 'TCP-проверка из нескольких точек в РФ и других странах.',
      fields: [
        {
          key: 'checkHostEnabled',
          label: 'Проверять все IP по расписанию',
          hint: 'Отключённые ноды пропускаются. Результат без достаточных ответов считается неизвестным.',
        },
        {
          key: 'checkHostHours',
          label: 'Период проверки каждого IP',
          hint: 'Проверки распределяются по очереди, чтобы не запускать весь парк одновременно.',
          unit: 'ч',
          min: 1,
          max: 168,
        },
        {
          key: 'checkHostPort',
          label: 'TCP-порт',
          hint: 'По умолчанию 5492; если недоступен — проверяем 22. Также проверяем порт ноды из Remnawave. Ответ TCP не гарантирует работу VPN.',
          unit: 'порт',
          min: 1,
          max: 65535,
        },
        {
          key: 'checkHostOnDrop',
          label: 'Проверять при падении онлайна',
          hint: 'Если порт не отвечает только из РФ, отмечаем вероятное ограничение из РФ. Если нигде — недоступность порта.',
        },
        {
          key: 'checkHostCooldownMinutes',
          label: 'Повторная проверка при падении',
          hint: 'В течение этого времени используется недавний результат для того же IP и порта.',
          unit: 'мин',
          min: 5,
          max: 1440,
        },
      ],
    },
  ],
  incidents: [
    {
      title: 'Падение онлайна и потеря связи',
      hint: 'Несколько последовательных опросов отсекают краткие скачки. Панель сообщает о проблеме и ничего не чинит сама.',
      fields: [
        {
          key: 'dropPercent',
          label: 'Падение онлайна',
          hint: 'Снижение относительно устойчивого уровня за выбранное окно.',
          unit: '%',
          min: 30,
          max: 100,
        },
        {
          key: 'minOnline',
          label: 'Минимальный исходный онлайн',
          hint: 'При меньшем исходном уровне сигнал падения не создаётся.',
          unit: 'чел',
          min: 5,
          max: 10000,
        },
        {
          key: 'dropWindowMinutes',
          label: 'Окно сравнения',
          hint: 'Исходный уровень строится по нескольким предыдущим замерам.',
          unit: 'мин',
          min: 5,
          max: 240,
        },
        {
          key: 'confirmSamples',
          label: 'Подтверждений проблемы',
          hint: 'Для падения онлайна и потери связи с нодой. При опросе раз в 15 секунд: 4 подтверждения — около минуты.',
          unit: 'опроса',
          min: 2,
          max: 10,
        },
        {
          key: 'recoverySamples',
          label: 'Подтверждений восстановления',
          hint: 'Несколько свежих замеров связи или онлайна подряд.',
          unit: 'опроса',
          min: 2,
          max: 10,
        },
        {
          key: 'recoveryPercent',
          label: 'Восстановление онлайна',
          hint: 'Доля исходного уровня. Для TCP-события также нужен положительный результат проверки.',
          unit: '%',
          min: 30,
          max: 100,
        },
      ],
    },
    {
      title: 'Ресурсы нод',
      hint: 'Нагрузка процессора и память из Remnawave. Отсутствующая метрика не считается нулём или перегрузкой.',
      fields: [
        {
          key: 'cpuEnabled',
          label: 'Следить за нагрузкой процессора',
          hint: 'Процента процессора Remnawave не отдаёт — смотрим нагрузку на ядро, как в строке ноды: среднюю за минуту, делённую на число ядер.',
        },
        {
          key: 'loadPerCore',
          label: 'Порог нагрузки на ядро',
          hint: '1,0 — ядро занято полностью. По умолчанию 1,5: задач в полтора раза больше, чем ядра успевают.',
          unit: 'на ядро',
          min: 0.5,
          max: 10,
          decimal: true,
        },
        {
          key: 'memoryEnabled',
          label: 'Следить за памятью',
          hint: 'Занятость рассчитывается из использованной и общей памяти.',
        },
        {
          key: 'memoryPercent',
          label: 'Порог памяти',
          hint: 'При восстановлении используется запас 5% от порога.',
          unit: '%',
          min: 50,
          max: 100,
        },
        {
          key: 'resourceDurationMinutes',
          label: 'Длительность превышения',
          hint: 'Событие — только если перегрузка держится столько минут подряд; закрывается, когда столько же держится ниже порога с запасом. По умолчанию 2.',
          unit: 'мин',
          min: 1,
          max: 60,
        },
      ],
    },
  ],
};
export function MonitoringPage({ section }: { section: 'checks' | 'incidents' }) {
  const query = useMonitoring(),
    update = useUpdateMonitoring();
  const fields = sections[section].flatMap((s) => s.fields);
  const pick = useCallback(
    (s: MonitoringSettings): Record<string, string | boolean> =>
      Object.fromEntries(
        sections[section]
          .flatMap((group) => group.fields)
          .map((f) => [
            f.key,
            typeof s[f.key] === 'boolean'
              ? Boolean(s[f.key])
              : f.decimal
                ? String(s[f.key]).replace('.', ',')
                : String(s[f.key]),
          ]),
      ),
    [section],
  );
  const [draft, setDraft] = useState<Record<string, string | boolean> | null>(null),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (query.data) setDraft(pick(query.data));
  }, [query.data, pick]);
  const dirty = !!draft && !!query.data && JSON.stringify(draft) !== JSON.stringify(pick(query.data));
  // «События»: какие события уходят в Telegram — в той же полосе «Сохранить», своей кнопки у карточки нет.
  const telegram = useIncidentTelegramDraft();
  const telegramDirty = section === 'incidents' && telegram.dirty;
  const anyDirty = dirty || telegramDirty;
  async function save() {
    if (!draft) return;
    if (!dirty) {
      try {
        await telegram.save();
        setError(null);
        toast.success('Настройки сохранены.');
      } catch (e) {
        setError(apiErrorMessage(e));
      }
      return;
    }
    const body = Object.fromEntries(
      fields.map((f) => [
        f.key,
        typeof draft[f.key] === 'boolean' ? draft[f.key] : Number(String(draft[f.key]).replace(',', '.')),
      ]),
    );
    const parsed = monitoringSettingsUpdateSchema.safeParse(body);
    if (!parsed.success) {
      setError(
        parsed.error.issues
          .map((i) => `${fields.find((f) => f.key === i.path[0])?.label}: ${i.message}`)
          .join('; '),
      );
      return;
    }
    try {
      await update.mutateAsync(parsed.data);
      if (telegramDirty) await telegram.save();
      setError(null);
      toast.success('Настройки сохранены.');
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }
  return (
    <div className="flex flex-col gap-3.5">
      <UnsavedChangesGuard dirty={anyDirty} />
      <SectionHeader
        title={section === 'checks' ? 'Мониторинг нод' : 'События'}
        description={
          section === 'checks'
            ? 'Как часто панель опрашивает Remnawave и когда проверяет порты нод.'
            : 'Когда панель заводит событие и когда считает, что проблема ушла.'
        }
        aside={
          draft && (
            <RowButton
              disabled={
                update.isPending || JSON.stringify(draft) === JSON.stringify(pick(MONITORING_DEFAULTS))
              }
              onClick={() => {
                setDraft(pick(MONITORING_DEFAULTS));
                setError(null);
              }}
            >
              По умолчанию
            </RowButton>
          )
        }
      />
      {query.isPending && <SettingsSkeleton cards={sections[section].map((group) => group.fields.length)} />}
      {query.isError && (
        <SettingsCard title="Не удалось загрузить настройки">
          <p role="alert" className="py-3 text-crit">
            {apiErrorMessage(query.error)}
          </p>
          <BarButton onClick={() => void query.refetch()}>Повторить</BarButton>
        </SettingsCard>
      )}
      {draft &&
        sections[section].map((s) => (
          <SettingsCard key={s.title} title={s.title} hint={s.hint}>
            {s.fields.map((f) => (
              <SettingsRow key={f.key} label={f.label} hint={f.hint} htmlFor={`monitor-${f.key}`}>
                {typeof draft[f.key] === 'boolean' ? (
                  <Toggle
                    id={`monitor-${f.key}`}
                    aria-label={f.label}
                    checked={draft[f.key] as boolean}
                    onChange={(v) => setDraft({ ...draft, [f.key]: v })}
                  />
                ) : (
                  <NumberField
                    id={`monitor-${f.key}`}
                    decimal={f.decimal}
                    value={String(draft[f.key])}
                    unit={f.unit ?? ''}
                    min={f.min ?? 0}
                    max={f.max ?? 100}
                    onChange={(v) => setDraft({ ...draft, [f.key]: v })}
                  />
                )}
              </SettingsRow>
            ))}
          </SettingsCard>
        ))}
      {section === 'incidents' && <IncidentTelegramCard state={telegram} />}
      {error && (
        <p role="alert" className="text-[13px] text-crit">
          {error}
        </p>
      )}
      <SaveBar
        dirty={anyDirty}
        pending={update.isPending || telegram.pending}
        onSave={() => void save()}
        onReset={() => {
          if (query.data) setDraft(pick(query.data));
          telegram.reset();
          setError(null);
        }}
      />
    </div>
  );
}
