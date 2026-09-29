import {
  BACKUP_EXTRA_PATHS_MAX,
  BACKUP_KEEP_MAX,
  BACKUP_KEEP_MIN,
  type BackupPathCheck,
  type BackupSettings,
  type BackupSettingsUpdate,
} from '@nodeservice/shared';
import { useMutation } from '@tanstack/react-query';
import { PlusIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import {
  NumberField,
  Pill,
  RowButton,
  SaveBar,
  Segmented,
  SettingsCard,
  SettingsRow,
  Toggle,
} from '@/features/settings/settings-ui';
import { useTelegramSettings } from '@/features/settings/telegram-api';
import { timeZoneLabel } from '@/features/settings/time-zones';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { backupsApi, useUpdateBackupSettings } from './backups-api';
import { formatSize } from './backups-format';

const WEEKDAYS = [
  { key: '1', label: 'пн' },
  { key: '2', label: 'вт' },
  { key: '3', label: 'ср' },
  { key: '4', label: 'чт' },
  { key: '5', label: 'пт' },
  { key: '6', label: 'сб' },
  { key: '7', label: 'вс' },
] as const;

interface Draft {
  s: BackupSettings;
  keep: string;
  /** Пароль: включён ли, меняем ли, новые значения. */
  pwOn: boolean;
  pwChange: boolean;
  pw: string;
  pw2: string;
  ownUrl: string;
  paths: string[];
}

const fromSaved = (s: BackupSettings): Draft => ({
  s,
  keep: String(s.keep),
  pwOn: s.passwordSet,
  pwChange: false,
  pw: '',
  pw2: '',
  ownUrl: s.telegram.ownUrl ?? '',
  paths: s.extra.paths.length ? s.extra.paths : [],
});

function pathCheckPill(c: BackupPathCheck['items'][number] | undefined): ReactNode {
  if (!c) return null;
  if (c.state === 'missing') return <Pill tone="warn">нет такого пути</Pill>;
  if (c.state === 'denied') return <Pill tone="crit">нет доступа</Pill>;
  return (
    <Pill tone="ok">
      {c.state === 'dir' ? 'папка' : 'файл'}
      {c.size != null ? ` · ${formatSize(c.size)}` : ''}
    </Pill>
  );
}

export function BackupSettingsForm({
  saved,
  timeZone,
  totalSize,
  count,
}: {
  saved: BackupSettings;
  timeZone: string;
  totalSize: number;
  count: number;
}) {
  const update = useUpdateBackupSettings();
  const telegram = useTelegramSettings();
  const [d, setD] = useState<Draft>(() => fromSaved(saved));
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, BackupPathCheck['items'][number]>>({});
  useEffect(() => setD(fromSaved(saved)), [saved]);

  const check = useMutation({
    mutationFn: (paths: string[]) => backupsApi.checkPaths(paths),
    onSuccess: (r) =>
      setChecks((prev) => ({ ...prev, ...Object.fromEntries(r.items.map((i) => [i.path, i])) })),
    onError: (e) => toast.error(`Пути не проверились: ${apiErrorMessage(e)}`),
  });
  const testChat = useMutation({ mutationFn: (url: string | null) => backupsApi.testChat(url) });
  // Пути уже сохранены — сразу показываем, есть ли они и сколько весят.
  const savedPaths = saved.extra.paths.join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: проверяем при смене сохранённого списка
  useEffect(() => {
    if (saved.extra.enabled && saved.extra.paths.length) check.mutate(saved.extra.paths);
  }, [savedPaths, saved.extra.enabled]);

  const set = (patch: Partial<BackupSettings>) => setD((p) => ({ ...p, s: { ...p.s, ...patch } }));
  const setTg = (patch: Partial<BackupSettings['telegram']>) =>
    setD((p) => ({ ...p, s: { ...p.s, telegram: { ...p.s.telegram, ...patch } } }));

  const destinations = telegram.data?.destinations ?? [];
  const destOptions = destinations.map((x) => ({
    value: x.id,
    label: [x.chatTitle ?? x.chatId, x.botName ? `бот @${x.botName}` : null].filter(Boolean).join(' · '),
  }));

  const cleanPaths = d.paths.map((p) => p.trim()).filter(Boolean);
  const keepNum = Number(d.keep);
  const keepBad = !Number.isInteger(keepNum) || keepNum < BACKUP_KEEP_MIN || keepNum > BACKUP_KEEP_MAX;
  const needNewPw = d.pwOn && (!saved.passwordSet || d.pwChange);
  const pwProblem = needNewPw
    ? d.pw.length < 8
      ? 'Пароль — не короче 8 знаков.'
      : d.pw !== d.pw2
        ? 'Пароли не совпадают.'
        : null
    : null;
  const ownChanged = d.ownUrl.trim() !== (saved.telegram.ownUrl ?? '');
  const tgProblem =
    d.s.telegram.enabled && d.s.telegram.target === 'notifications' && !d.s.telegram.destinationId
      ? 'Выберите чат для копий.'
      : d.s.telegram.enabled && d.s.telegram.target === 'own' && !d.ownUrl.trim()
        ? 'Укажите свой чат строкой tgram://…'
        : null;
  const pathProblem =
    d.s.extra.enabled && cleanPaths.some((p) => !p.startsWith('/'))
      ? 'Пути — полные, от корня: /etc/nginx.'
      : null;

  const draftComparable = useMemo(
    () =>
      JSON.stringify({
        ...d.s,
        keep: keepNum,
        extra: { enabled: d.s.extra.enabled, paths: cleanPaths },
        passwordSet: d.pwOn,
        telegram: { ...d.s.telegram, ownUrl: d.ownUrl.trim() || null },
      }),
    [d, keepNum, cleanPaths],
  );
  const dirty =
    draftComparable !== JSON.stringify(saved) || (needNewPw && (d.pw !== '' || d.pw2 !== '')) || d.pwChange;
  const problem =
    (keepBad ? `Хранить — от ${BACKUP_KEEP_MIN} до ${BACKUP_KEEP_MAX}.` : null) ??
    pwProblem ??
    tgProblem ??
    pathProblem;

  const save = async () => {
    setError(null);
    const body: BackupSettingsUpdate = {
      auto: d.s.auto,
      frequency: d.s.frequency,
      weekday: d.s.weekday,
      time: d.s.time,
      keep: keepNum,
      beforeUpdate: d.s.beforeUpdate,
      includeMetrics: d.s.includeMetrics,
      telegram: {
        ...d.s.telegram,
        // Маска — «не менять»; новая строка — заменить; пусто — убрать.
        ownUrl: ownChanged ? d.ownUrl.trim() || null : (saved.telegram.ownUrl ?? null),
      },
      extra: { enabled: d.s.extra.enabled, paths: cleanPaths },
      ...(needNewPw ? { password: d.pw } : !d.pwOn && saved.passwordSet ? { password: null } : {}),
    };
    try {
      await update.mutateAsync(body);
      toast.success('Настройки копий сохранены.');
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const zone = timeZoneLabel(timeZone);
  const off = !d.s.auto;

  return (
    <>
      <SettingsCard title="Расписание" hint="Когда панель делает копию сама.">
        <SettingsRow
          label="Делать копии автоматически"
          htmlFor="bk-auto"
          hint="Выключено — только кнопкой «Сделать копию сейчас»."
        >
          <Toggle id="bk-auto" checked={d.s.auto} onChange={(v) => set({ auto: v })} />
        </SettingsRow>
        <div className={cn(off && 'opacity-50')}>
          <SettingsRow
            label="Как часто"
            hint={d.s.frequency === 'day' ? 'Каждый день в указанное время.' : 'Раз в неделю: выберите день.'}
          >
            <Segmented
              label="Как часто"
              items={[
                { key: 'day', label: 'Каждый день' },
                { key: 'week', label: 'Раз в неделю' },
              ]}
              value={d.s.frequency}
              onChange={(v) => set({ frequency: v })}
            />
          </SettingsRow>
          {d.s.frequency === 'week' && (
            <SettingsRow label="День недели">
              <Segmented
                label="День недели"
                items={WEEKDAYS}
                value={String(d.s.weekday) as (typeof WEEKDAYS)[number]['key']}
                onChange={(v) => set({ weekday: Number(v) })}
              />
            </SettingsRow>
          )}
          <SettingsRow
            label="Время"
            htmlFor="bk-time"
            hint={`По часовому поясу панели (${zone}; меняется в «Внешнем виде»). Лучше ночью — меньше пользователей.`}
          >
            <Input
              id="bk-time"
              type="time"
              value={d.s.time}
              onChange={(e) => e.target.value && set({ time: e.target.value })}
              className="h-[34px] w-[110px] rounded-[9px] bg-surface-2 text-center font-mono text-[13px]"
            />
          </SettingsRow>
        </div>
      </SettingsCard>

      <SettingsCard title="Хранение" hint="Сколько копий держать на сервере панели.">
        <SettingsRow
          label="Хранить последних"
          htmlFor="bk-keep"
          hint={`Старше — удаляются после каждой новой копии; копии «перед восстановлением» и загруженные с компьютера не в счёт. Сейчас ${count} ≈ ${formatSize(totalSize)}.`}
        >
          <NumberField
            id="bk-keep"
            value={d.keep}
            onChange={(v) => setD((p) => ({ ...p, keep: v }))}
            unit="шт."
            min={BACKUP_KEEP_MIN}
            max={BACKUP_KEEP_MAX}
            invalid={keepBad}
          />
        </SettingsRow>
        <SettingsRow
          label="Копия перед обновлением панели"
          htmlFor="bk-before-update"
          hint="Команда обновления на сервере сначала делает копию — если обновление пойдёт не так, будет куда вернуться."
        >
          <Toggle
            id="bk-before-update"
            checked={d.s.beforeUpdate}
            onChange={(v) => set({ beforeUpdate: v })}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title="Отправка в Telegram" hint="Архив приходит файлом сразу после копии.">
        <SettingsRow
          label="Присылать копию в Telegram"
          htmlFor="bk-tg"
          hint="Бот может прислать файл до 50 МБ. Больше — придёт сообщение «копия готова, скачайте в панели»."
        >
          <Toggle id="bk-tg" checked={d.s.telegram.enabled} onChange={(v) => setTg({ enabled: v })} />
        </SettingsRow>
        {d.s.telegram.enabled && (
          <>
            <SettingsRow stack>
              <div className="flex flex-col gap-2" role="radiogroup" aria-label="Куда присылать копии">
                <Choice
                  on={d.s.telegram.target === 'notifications'}
                  onSelect={() => setTg({ target: 'notifications' })}
                  title="Чат из «Уведомлений»"
                  hint={
                    destinations.length
                      ? 'Один из уже добавленных чатов.'
                      : 'Чатов пока нет — добавьте в «Настройки → Уведомления».'
                  }
                >
                  <Combobox
                    ariaLabel="Чат для копий"
                    value={d.s.telegram.destinationId}
                    onChange={(v) => setTg({ destinationId: v })}
                    options={destOptions}
                    placeholder="Выберите чат"
                    disabled={destinations.length === 0}
                    className="w-full max-w-[380px]"
                  />
                </Choice>
                <Choice
                  on={d.s.telegram.target === 'own'}
                  onSelect={() => setTg({ target: 'own' })}
                  title="Отдельный чат для копий"
                  hint={
                    <>
                      Своей строкой, как в «Уведомлениях»:{' '}
                      <span className="font-mono">tgram://токен/чат[:тема]</span>. Удобно держать копии
                      отдельно от тревог.
                    </>
                  }
                >
                  <div className="flex flex-wrap gap-2">
                    <Input
                      aria-label="Свой чат для копий"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="tgram://123456:ABC…/-1001234567890"
                      value={d.ownUrl}
                      onChange={(e) => setD((p) => ({ ...p, ownUrl: e.target.value }))}
                      className="h-[34px] min-w-0 flex-1 rounded-[9px] bg-surface-2 font-mono text-[12.5px]"
                    />
                    <RowButton
                      className="h-[34px]"
                      disabled={!d.ownUrl.trim() || testChat.isPending}
                      onClick={() =>
                        testChat.mutate(ownChanged ? d.ownUrl.trim() : null, {
                          onSuccess: (r) => (r.ok ? toast.success(r.detail) : toast.error(r.detail)),
                          onError: (e) => toast.error(apiErrorMessage(e)),
                        })
                      }
                    >
                      {testChat.isPending ? 'Отправляю…' : 'Отправить тест'}
                    </RowButton>
                  </div>
                </Choice>
              </div>
            </SettingsRow>
            <SettingsRow
              label="Сообщать, если копия не получилась"
              htmlFor="bk-tg-fail"
              hint="Со звуком, в тот же чат: что сломалось и что делать. В колокольчике панели — всегда."
            >
              <Toggle
                id="bk-tg-fail"
                checked={d.s.telegram.notifyFailure}
                onChange={(v) => setTg({ notifyFailure: v })}
              />
            </SettingsRow>
          </>
        )}
      </SettingsCard>

      <SettingsCard
        title="Пароль на архив"
        hint="Архив содержит ключи шифрования панели: с ними можно расшифровать доступы к серверам."
      >
        <SettingsRow
          label="Защищать паролем"
          htmlFor="bk-pw"
          hint="Архив шифруется (AES-256). Без пароля его не открыть — ни вам, ни тому, кто получит файл."
        >
          <Toggle
            id="bk-pw"
            checked={d.pwOn}
            onChange={(v) => setD((p) => ({ ...p, pwOn: v, pwChange: false }))}
          />
        </SettingsRow>
        {d.pwOn && saved.passwordSet && !d.pwChange ? (
          <SettingsRow
            label="Пароль задан"
            hint="Новые копии шифруются им. Старые открываются тем паролем, что был при их создании."
          >
            <RowButton onClick={() => setD((p) => ({ ...p, pwChange: true }))}>Сменить пароль</RowButton>
          </SettingsRow>
        ) : null}
        {needNewPw && (
          <SettingsRow stack>
            <div className="grid gap-3 sm:grid-cols-2">
              <PwField
                id="bk-pw1"
                label="Пароль"
                value={d.pw}
                onChange={(v) => setD((p) => ({ ...p, pw: v }))}
              />
              <PwField
                id="bk-pw2"
                label="Ещё раз"
                value={d.pw2}
                onChange={(v) => setD((p) => ({ ...p, pw2: v }))}
                hint={d.pw2 ? (d.pw === d.pw2 ? 'Совпадает ✓' : 'Не совпадает') : undefined}
              />
            </div>
          </SettingsRow>
        )}
        <SettingsRow stack>
          {d.pwOn ? (
            <Warn>
              <b>Запишите пароль вне панели.</b> Если сервер панели умрёт, восстановить копию без пароля будет
              нельзя — панель не хранит его в открытом виде и не пришлёт.
            </Warn>
          ) : (
            <Warn crit>
              <b>Без пароля не советую отправлять копии в Telegram:</b> кто получит файл, получит ключи от
              панели.
            </Warn>
          )}
        </SettingsRow>
      </SettingsCard>

      <SettingsCard
        title="Что входит в копию"
        hint="Отмеченное попадает в каждый архив — и по расписанию, и вручную."
      >
        <SettingsRow stack>
          <div className="flex flex-col">
            <Include
              locked
              title="База данных"
              hint="Серверы, инциденты, оплаты, Журнал, Джарвис, база знаний, настройки. Всегда."
            />
            <Include
              locked
              title="Ключи и настройки установки"
              hint="Ключи шифрования, домен панели. Без них не расшифровать доступы к серверам. Всегда."
            />
            <Include
              id="bk-metrics"
              checked={d.s.includeMetrics}
              onChange={(v) => set({ includeMetrics: v })}
              title="Метрики за 90 дней"
              hint="Графики и статистика парка. Без них после восстановления графики начнутся заново. Архив станет заметно больше — в Telegram может не влезть."
            />
            <Include
              id="bk-extra"
              checked={d.s.extra.enabled}
              onChange={(v) => set({ extra: { ...d.s.extra, enabled: v } })}
              title="Дополнительные файлы и папки"
              hint="Пути на сервере панели (не на нодах) — кладутся в архив целиком. При восстановлении не раскладываются обратно: достаёте из архива сами."
            />
          </div>
        </SettingsRow>
        {d.s.extra.enabled && (
          <SettingsRow stack>
            <div className="flex flex-col gap-2">
              {d.paths.map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: строки ввода без своего id, порядок стабилен
                <div key={i} className="flex items-center gap-2">
                  <Input
                    aria-label={`Путь ${i + 1}`}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="/etc/nginx/sites-enabled"
                    value={p}
                    onChange={(e) =>
                      setD((x) => ({ ...x, paths: x.paths.map((y, j) => (j === i ? e.target.value : y)) }))
                    }
                    className="h-[34px] min-w-0 flex-1 rounded-[9px] bg-surface-2 font-mono text-[12.5px]"
                  />
                  <span className="flex-none">{pathCheckPill(checks[p.trim()])}</span>
                  <button
                    type="button"
                    aria-label={`Убрать путь ${p || i + 1}`}
                    onClick={() => setD((x) => ({ ...x, paths: x.paths.filter((_, j) => j !== i) }))}
                    className="grid size-[30px] flex-none cursor-pointer place-items-center rounded-[8px] text-text-3 hover:bg-surface-2 hover:text-crit"
                  >
                    <XIcon className="size-4" aria-hidden="true" />
                  </button>
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-2.5">
                <RowButton
                  disabled={d.paths.length >= BACKUP_EXTRA_PATHS_MAX}
                  onClick={() => setD((x) => ({ ...x, paths: [...x.paths, ''] }))}
                >
                  <PlusIcon aria-hidden="true" />
                  Добавить путь
                </RowButton>
                <RowButton
                  disabled={cleanPaths.length === 0 || check.isPending || Boolean(pathProblem)}
                  onClick={() => check.mutate(cleanPaths)}
                >
                  {check.isPending ? 'Проверяю…' : 'Проверить пути'}
                </RowButton>
                <span className="text-[11.5px] text-text-3">
                  Панель покажет, есть ли путь и сколько весит. До {BACKUP_EXTRA_PATHS_MAX} путей.
                </span>
              </div>
            </div>
          </SettingsRow>
        )}
      </SettingsCard>

      <SaveBar
        dirty={dirty}
        pending={update.isPending}
        error={dirty ? (error ?? problem) : error}
        onSave={() => void save()}
        onReset={() => {
          setD(fromSaved(saved));
          setError(null);
        }}
        note="Настройки копий попадают в Журнал; пароль — нет."
      />
    </>
  );
}

function Choice({
  on,
  onSelect,
  title,
  hint,
  children,
}: {
  on: boolean;
  onSelect: () => void;
  title: string;
  hint: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex gap-3 rounded-[11px] border px-3.5 py-3 transition-colors',
        on ? 'border-brand bg-brand-soft/40' : 'border-border bg-surface-2/50',
      )}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: круглая кнопка-переключатель в своей раскладке */}
      <button
        type="button"
        role="radio"
        aria-checked={on}
        aria-label={title}
        onClick={onSelect}
        className={cn(
          'mt-0.5 grid size-[18px] flex-none cursor-pointer place-items-center rounded-full border-2 transition-colors',
          on ? 'border-brand' : 'border-border-2',
        )}
      >
        {on && <span className="size-2 rounded-full bg-brand" />}
      </button>
      <div className="min-w-0 flex-1">
        <button type="button" onClick={onSelect} className="cursor-pointer text-left">
          <b className="block text-[13px]">{title}</b>
          <span className="block text-[12px] text-text-3">{hint}</span>
        </button>
        {on && <div className="mt-2.5">{children}</div>}
      </div>
    </div>
  );
}

function Include({
  id,
  title,
  hint,
  checked = true,
  onChange,
  locked,
}: {
  id?: string;
  title: string;
  hint: string;
  checked?: boolean;
  onChange?: (v: boolean) => void;
  locked?: boolean;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex items-start gap-3 border-b border-border py-2.5 last:border-b-0',
        !locked && 'cursor-pointer',
      )}
    >
      <Checkbox
        id={id}
        checked={checked}
        disabled={locked}
        onCheckedChange={(v) => onChange?.(v === true)}
        className="mt-0.5"
        aria-label={title}
      />
      <span className="min-w-0">
        <b className="block text-[13px]">{title}</b>
        <span className="block text-[12px] text-text-3">{hint}</span>
      </span>
    </label>
  );
}

function PwField({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[12.5px] font-semibold">
        {label}
      </label>
      <Input
        id={id}
        type="password"
        autoComplete="new-password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-[34px] rounded-[9px] bg-surface-2 text-[13px]"
      />
      {hint && <span className="text-[11.5px] text-text-3">{hint}</span>}
    </div>
  );
}

function Warn({ crit, children }: { crit?: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        'flex gap-2.5 rounded-[11px] border px-3.5 py-3 text-[12.5px] leading-relaxed',
        crit ? 'border-crit/30 bg-crit-soft' : 'border-warn/30 bg-warn-soft',
      )}
    >
      <TriangleAlertIcon
        className={cn('mt-0.5 size-4 flex-none', crit ? 'text-crit' : 'text-warn')}
        aria-hidden="true"
      />
      <div>{children}</div>
    </div>
  );
}
