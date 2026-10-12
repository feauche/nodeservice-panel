import {
  MONITORING_DEFAULTS,
  type MonitoringSettings,
  monitoringSettingsUpdateSchema,
} from '@nodeservice/shared';
import { ActivityIcon, TriangleAlertIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { UnsavedChangesGuard } from '@/components/unsaved-changes-guard';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { IncidentTelegramCard } from './monitoring-telegram-card';
import { useMonitoring, useUpdateMonitoring } from './settings-api';
import {
  BarButton,
  NumberField,
  SaveBar,
  SectionHeader,
  SettingsCard,
  SettingsRow,
  Toggle,
} from './settings-ui';

type Key = keyof MonitoringSettings;
type Field = { key: Key; label: string; hint: string; unit?: string; min?: number; max?: number };
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
          hint: 'Каждый новый опрос считается одним подтверждением проблемы.',
          unit: 'сек',
          min: 30,
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
          hint: 'Для падения онлайна и потери связи с нодой. При опросе раз в минуту: 3 подтверждения — около 3 минут.',
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
      hint: 'Только CPU и память из Remnawave. Отсутствующая метрика не считается нулём или перегрузкой.',
      fields: [
        {
          key: 'cpuEnabled',
          label: 'Следить за процессором',
          hint: 'Проверять процент загрузки CPU, если он доступен в API.',
        },
        {
          key: 'cpuPercent',
          label: 'Порог CPU',
          hint: 'Средняя нагрузка load average не заменяет процент CPU.',
          unit: '%',
          min: 50,
          max: 100,
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
          hint: 'Создавать событие только при устойчивой перегрузке.',
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
          .map((f) => [f.key, typeof s[f.key] === 'boolean' ? Boolean(s[f.key]) : String(s[f.key])]),
      ),
    [section],
  );
  const [draft, setDraft] = useState<Record<string, string | boolean> | null>(null),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (query.data) setDraft(pick(query.data));
  }, [query.data, pick]);
  const dirty = !!draft && !!query.data && JSON.stringify(draft) !== JSON.stringify(pick(query.data));
  async function save() {
    if (!draft) return;
    const body = Object.fromEntries(
      fields.map((f) => [f.key, typeof draft[f.key] === 'boolean' ? draft[f.key] : Number(draft[f.key])]),
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
      setError(null);
      toast.success('Настройки сохранены.');
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }
  return (
    <div className="flex flex-col gap-3.5">
      <UnsavedChangesGuard dirty={dirty} />
      <SectionHeader
        icon={section === 'checks' ? ActivityIcon : TriangleAlertIcon}
        title={section === 'checks' ? 'Автопроверки нод' : 'События'}
        description={
          section === 'checks'
            ? 'Частота обновления данных и проверки доступности IP.'
            : 'Условия создания и восстановления событий по данным Remnawave.'
        }
      />
      {query.isPending && <Skeleton className="h-[320px] rounded-[14px]" />}
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
      {error && (
        <p role="alert" className="text-[13px] text-crit">
          {error}
        </p>
      )}
      <SaveBar
        dirty={dirty}
        pending={update.isPending}
        error={undefined}
        onSave={() => void save()}
        onReset={() => {
          if (query.data) setDraft(pick(query.data));
          setError(null);
        }}
        extra={
          <BarButton
            disabled={!draft || update.isPending}
            onClick={() => {
              setDraft(pick(MONITORING_DEFAULTS));
              setError(null);
            }}
          >
            По умолчанию
          </BarButton>
        }
      />
      {section === 'incidents' && <IncidentTelegramCard />}
    </div>
  );
}
