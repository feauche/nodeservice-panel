import {
  compareVersions,
  MAINTENANCE_KIND_LABELS,
  MAINTENANCE_TIERS,
  type MaintenanceCheck,
  type MaintenanceKind,
  type MaintenanceRun,
  type MaintenanceStep,
  type MaintenanceTier,
  type Server,
} from '@nodeservice/shared';
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleIcon,
  HardDriveIcon,
  Loader2Icon,
  MinusIcon,
  PackageIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatWhen } from '@/features/audit/audit-format';
import { formatAgo, formatIn } from '@/features/security/security-format';
import { apiErrorMessage } from '@/lib/api';
import { plural } from '@/lib/plural';
import { cn } from '@/lib/utils';
import { useMaintenance, useStartMaintenance } from '../maintenance-api';

type Tone = 'ok' | 'warn' | 'crit' | 'muted';

const TONE_TILE: Record<Tone, string> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  crit: 'bg-crit-soft text-crit',
  muted: 'bg-surface-3 text-text-3',
};
const TONE_ICON: Record<Tone, typeof CheckIcon> = {
  ok: CheckIcon,
  warn: TriangleAlertIcon,
  crit: XIcon,
  muted: MinusIcon,
};
const TIER_CHIP: Record<MaintenanceTier, string> = {
  T0: 'border-border-2 text-text-3',
  T1: 'border-ok/40 text-ok',
  T2: 'border-warn/50 text-warn',
  T3: 'border-crit/40 text-crit',
};

const ACTION_ICON: Record<Exclude<MaintenanceKind, 'check'>, typeof PackageIcon> = {
  apt_upgrade: PackageIcon,
  agent_update: BotIcon,
  cleanup: HardDriveIcon,
  unattended_enable: ShieldCheckIcon,
};

const ACTION_BUTTON: Record<Exclude<MaintenanceKind, 'check'>, string> = {
  apt_upgrade: 'Обновить',
  agent_update: 'Обновить',
  cleanup: 'Очистить',
  unattended_enable: 'Включить',
};

/** Подтверждения для T2: что именно сделаем и чего не тронем. */
const CONFIRM: Record<
  Exclude<MaintenanceKind, 'check' | 'agent_update'>,
  { title: (name: string) => string; description: (c: MaintenanceCheck | null) => string; yes: string }
> = {
  apt_upgrade: {
    title: (name) => `Обновить систему на «${name}»?`,
    description: (c) =>
      `apt-get upgrade без вопросов${c?.updates ? `: ${c.updates.total} ${plural(c.updates.total, 'пакет', 'пакета', 'пакетов')}` : ''}. Конфиги не трогаем, ничего не удаляем, сервисы ноды продолжают работать. Если обновится ядро, панель попросит перезагрузить вручную.`,
    yes: 'Да, обновить',
  },
  cleanup: {
    title: (name) => `Очистить диск на «${name}»?`,
    description: () =>
      'Удалим ненужные пакеты и старые ядра, кеш apt и сожмём системный журнал до 200 МБ. Данные и настройки не трогаем.',
    yes: 'Да, очистить',
  },
  unattended_enable: {
    title: () => 'Включить автообновления безопасности?',
    description: () =>
      'Поставим unattended-upgrades: ночью система сама ставит только обновления безопасности, без перезагрузки. Остальные пакеты — по-прежнему через панель.',
    yes: 'Да, включить',
  },
};

function TierChip({ tier }: { tier: MaintenanceTier }) {
  return (
    <span
      title={`Уровень ${tier}`}
      className={cn(
        'inline-flex h-5 items-center rounded-[5px] border px-1.5 text-[10px] font-bold tracking-[0.06em]',
        TIER_CHIP[tier],
      )}
    >
      {tier}
    </span>
  );
}

interface Row {
  key: string;
  tone: Tone;
  title: string;
  subtitle: string;
  /** Правая часть: действие с уровнем, либо подпись («в норме», «только вручную»). */
  action?: { kind: Exclude<MaintenanceKind, 'check'>; label?: string };
  note?: string;
  tier?: MaintenanceTier;
}

function fmtGb(mb: number): string {
  return mb >= 10_240 ? `${Math.round(mb / 1024)} ГБ` : `${(mb / 1024).toFixed(1)} ГБ`;
}

/** Чек-лист из результата проверки: строка на каждую тему, кнопка — только там, где есть что сделать. */
function buildRows(c: MaintenanceCheck, server: Server): Row[] {
  const rows: Row[] = [];
  // 1. Обновления
  if (!c.supported) {
    rows.push({
      key: 'updates',
      tone: 'muted',
      title: 'Обновления через apt недоступны',
      subtitle: 'Система не Debian/Ubuntu: обновляйте её вручную в терминале.',
      note: '—',
    });
  } else if (!c.updates) {
    rows.push({
      key: 'updates',
      tone: 'muted',
      title: 'Не удалось посчитать обновления',
      subtitle: c.warnings[0] ?? 'Повторите проверку.',
      note: '—',
    });
  } else if (c.updates.total === 0) {
    rows.push({
      key: 'updates',
      tone: 'ok',
      title: 'Обновлений нет',
      subtitle: 'Все пакеты последних версий.',
      note: 'в норме',
    });
  } else {
    const t = c.updates.total;
    rows.push({
      key: 'updates',
      tone: 'warn',
      title: `${t} ${plural(t, 'обновление', 'обновления', 'обновлений')}${c.updates.security > 0 ? `, из них ${c.updates.security} безопасности` : ''}`,
      subtitle: 'apt-get upgrade без удаления пакетов и без вопросов; конфиги не трогаем.',
      action: { kind: 'apt_upgrade' },
      tier: MAINTENANCE_TIERS.apt_upgrade,
    });
  }
  // 2. Перезагрузка
  if (c.rebootRequired === null) {
    rows.push({
      key: 'reboot',
      tone: 'muted',
      title: 'Не удалось узнать, нужна ли перезагрузка',
      subtitle: '—',
      note: '—',
    });
  } else if (c.rebootRequired) {
    rows.push({
      key: 'reboot',
      tone: 'warn',
      title: 'Требуется перезагрузка',
      subtitle:
        c.kernel.installed && c.kernel.installed !== c.kernel.running
          ? `Установлено ядро ${c.kernel.installed}, работает ${c.kernel.running ?? '?'}.`
          : 'Обновились компоненты, которые применяются только после перезагрузки.',
      note: 'только вручную: reboot в терминале',
      tier: 'T3',
    });
  } else {
    rows.push({
      key: 'reboot',
      tone: 'ok',
      title: 'Перезагрузка не требуется',
      subtitle: c.kernel.running ? `Ядро ${c.kernel.running}.` : 'Ядро актуально.',
      note: 'в норме',
    });
  }
  // 3. Агент
  const installed = c.agent.installed ?? server.agentVersion;
  if (!installed || c.agent.service === 'missing') {
    rows.push({
      key: 'agent',
      tone: server.agentStatus === 'online' ? 'ok' : 'warn',
      title: server.agentStatus === 'online' ? 'Агент в сети' : 'Агент не установлен',
      subtitle:
        server.agentStatus === 'online'
          ? 'Версию на сервере узнать не удалось.'
          : 'Поставьте его кнопкой «Установить агента» слева.',
      note: server.agentStatus === 'online' ? 'в норме' : '—',
    });
  } else if (c.agent.service && c.agent.service !== 'active') {
    rows.push({
      key: 'agent',
      tone: 'crit',
      title: `Агент ${installed} установлен, но служба не запущена`,
      subtitle: 'Переустановка заново скачает релиз и перезапустит службу.',
      action: { kind: 'agent_update', label: 'Переустановить' },
      tier: MAINTENANCE_TIERS.agent_update,
    });
  } else if (c.agent.latest && compareVersions(installed, c.agent.latest) < 0) {
    rows.push({
      key: 'agent',
      tone: 'warn',
      title: `Агент ${installed}, доступна ${c.agent.latest}`,
      subtitle: 'Обновление безопасно: агент перезапустится за секунду, метрики не прервутся.',
      action: { kind: 'agent_update' },
      tier: MAINTENANCE_TIERS.agent_update,
    });
  } else {
    rows.push({
      key: 'agent',
      tone: 'ok',
      title: `Агент ${installed}`,
      subtitle: c.agent.latest ? 'Последняя версия.' : 'Последнюю версию на GitHub узнать не удалось.',
      note: 'в норме',
    });
  }
  // 4. Диск
  if (c.disk.usedPct === null) {
    rows.push({ key: 'disk', tone: 'muted', title: 'Диск: нет данных', subtitle: '—', note: '—' });
  } else {
    const pct = Math.round(c.disk.usedPct);
    rows.push({
      key: 'disk',
      tone: pct >= 90 ? 'crit' : pct >= 80 ? 'warn' : 'ok',
      title: `Диск: ${pct}% занято`,
      subtitle: `${c.disk.freeMb !== null ? `Свободно ${fmtGb(c.disk.freeMb)}. ` : ''}Очистка убирает ненужные пакеты, старые ядра, кеш apt и лишний журнал.`,
      ...(c.supported
        ? { action: { kind: 'cleanup' as const }, tier: MAINTENANCE_TIERS.cleanup }
        : { note: 'в норме' }),
    });
  }
  // 5. Автообновления безопасности
  if (c.unattended === null) {
    rows.push({
      key: 'unattended',
      tone: 'muted',
      title: 'Автообновления безопасности',
      subtitle: 'Недоступно без apt.',
      note: '—',
    });
  } else if (c.unattended) {
    rows.push({
      key: 'unattended',
      tone: 'ok',
      title: 'Автообновления безопасности включены',
      subtitle: 'unattended-upgrades, без автоперезагрузки.',
      note: 'в норме',
    });
  } else {
    rows.push({
      key: 'unattended',
      tone: 'warn',
      title: 'Автообновления безопасности выключены',
      subtitle: 'Пакеты безопасности будут ждать ручного обновления.',
      action: { kind: 'unattended_enable' },
      tier: MAINTENANCE_TIERS.unattended_enable,
    });
  }
  return rows;
}

function stepSeconds(s: MaintenanceStep): string {
  if (!s.startedAt) return '';
  const end = s.finishedAt ? new Date(s.finishedAt).getTime() : Date.now();
  const sec = Math.max(0, Math.round((end - new Date(s.startedAt).getTime()) / 1000));
  return sec < 60 ? `${sec} с` : `${Math.floor(sec / 60)} мин ${sec % 60} с`;
}

function StepIcon({ status }: { status: MaintenanceStep['status'] }) {
  if (status === 'running')
    return <Loader2Icon className="size-3.5 animate-spin text-brand" aria-hidden="true" />;
  if (status === 'ok') return <CheckIcon className="size-3.5 text-ok" aria-hidden="true" />;
  if (status === 'failed') return <XIcon className="size-3.5 text-crit" aria-hidden="true" />;
  if (status === 'skipped') return <MinusIcon className="size-3.5 text-text-3" aria-hidden="true" />;
  return <CircleIcon className="size-3 text-text-3" aria-hidden="true" />;
}

const STEP_STATUS_LABEL: Record<MaintenanceStep['status'], string> = {
  pending: 'ждёт',
  running: 'идёт',
  ok: 'готово',
  failed: 'ошибка',
  skipped: 'пропущен',
};

/** Карточка запуска: шаги с длительностью и живой лог (открыт, пока идёт или если упало). */
function RunCard({ run, live }: { run: MaintenanceRun; live: boolean }) {
  const [open, setOpen] = useState(live || run.status === 'failed');
  const [showLog, setShowLog] = useState(live || run.status === 'failed');
  const logRef = useRef<HTMLPreElement>(null);
  // Пока идёт — раскрыто; когда закончилось успехом, сворачиваем сами.
  // biome-ignore lint/correctness/useExhaustiveDependencies: только на смену статуса
  useEffect(() => {
    if (live || run.status === 'failed') {
      setOpen(true);
      setShowLog(true);
    }
  }, [live, run.status, run.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: прокрутка к концу на каждое пополнение лога
  useEffect(() => {
    if (showLog && live) logRef.current?.scrollTo?.({ top: logRef.current.scrollHeight });
  }, [run.log, showLog, live]);

  const Icon = run.kind === 'check' ? RefreshCwIcon : ACTION_ICON[run.kind];
  const durationSec = Math.max(
    1,
    Math.round(
      ((run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now()) -
        new Date(run.startedAt).getTime()) /
        1000,
    ),
  );
  const result = live
    ? 'идёт'
    : run.status === 'ok'
      ? `успешно за ${durationSec} с`
      : `ошибка: ${run.error ?? 'неизвестно'}`;

  return (
    <section
      data-testid="maintenance-run"
      className={cn(
        'rounded-2xl border bg-surface',
        live ? 'border-brand/40' : run.status === 'failed' ? 'border-crit/40' : 'border-border',
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left"
      >
        <span
          className={cn(
            'grid size-7 flex-none place-items-center rounded-[8px]',
            live
              ? 'bg-brand-soft text-brand'
              : run.status === 'ok'
                ? 'bg-ok-soft text-ok'
                : 'bg-crit-soft text-crit',
          )}
        >
          {live ? (
            <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Icon className="size-4" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold">
            {MAINTENANCE_KIND_LABELS[run.kind]}
            <span className="font-normal text-text-3"> · {formatWhen(run.startedAt)}</span>
            {run.actorDisplay && <span className="font-normal text-text-3"> · {run.actorDisplay}</span>}
          </span>
          <span
            className={cn(
              'block truncate text-[12px]',
              live ? 'text-brand' : run.status === 'ok' ? 'text-ok' : 'text-crit',
            )}
          >
            {result}
          </span>
        </span>
        <ChevronDownIcon
          className={cn('size-4 flex-none text-text-3 transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div className="border-t border-border px-4 py-3">
          <ol className="flex flex-col gap-1.5" aria-label="Шаги">
            {run.steps.map((s) => (
              <li
                key={s.key}
                className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2.5 text-[12.5px]"
              >
                <span className="grid place-items-center">
                  <StepIcon status={s.status} />
                </span>
                <span
                  className={cn(
                    'truncate',
                    s.status === 'pending' || s.status === 'skipped' ? 'text-text-3' : '',
                  )}
                >
                  {s.label}
                  {s.detail && <span className="text-text-3"> · {s.detail}</span>}
                </span>
                <span className="text-[11.5px] text-text-3 tabular-nums">
                  {s.status === 'ok' ? stepSeconds(s) : STEP_STATUS_LABEL[s.status]}
                </span>
              </li>
            ))}
          </ol>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              aria-expanded={showLog}
              onClick={() => setShowLog((v) => !v)}
              className="cursor-pointer text-[12px] font-medium text-text-2 underline-offset-2 hover:underline"
            >
              {showLog ? 'Скрыть лог' : 'Показать лог'}
            </button>
            {live && (
              <span className="text-[12px] text-text-3">
                Шаги идут по очереди, после действия — проверка. При ошибке остановимся и покажем лог.
              </span>
            )}
          </div>
          {showLog && (
            <pre
              ref={logRef}
              data-testid="maintenance-log"
              className="mt-2 max-h-[220px] overflow-auto rounded-[10px] border border-border bg-bg-2 px-3 py-2 font-mono text-[11.5px] leading-[1.5] whitespace-pre-wrap break-words text-text-2"
            >
              {run.log || '—'}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Обслуживание сервера: чек-лист по результату суточной проверки (обновления, перезагрузка,
 * агент, диск, автообновления) с кнопками у проблем и уровнем T1/T2/T3 у каждого действия;
 * ниже — идущий или последний запуск с шагами и логом.
 */
export function MaintenanceTab({ server }: { server: Server }) {
  const state = useMaintenance(server.id);
  const start = useStartMaintenance(server.id);
  const [confirm, setConfirm] = useState<Exclude<MaintenanceKind, 'check' | 'agent_update'> | null>(null);
  const [, tick] = useState(0);
  const running = state.data?.running ?? null;
  // Секундомеры на шагах и «идёт N с» — раз в секунду, только пока что-то идёт.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const launch = async (kind: MaintenanceKind) => {
    try {
      await start.mutateAsync(kind);
      if (kind !== 'check') toast.success(`${MAINTENANCE_KIND_LABELS[kind]}: запущено на «${server.name}».`);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } finally {
      setConfirm(null);
    }
  };
  const onAction = (kind: Exclude<MaintenanceKind, 'check'>) => {
    if (kind === 'agent_update') void launch(kind);
    else setConfirm(kind);
  };

  if (state.isPending) {
    return (
      <div className="flex flex-col gap-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-14 rounded-[12px]" />
        ))}
      </div>
    );
  }
  if (state.isError) {
    return (
      <p
        role="alert"
        className="rounded-2xl border border-crit/40 bg-crit-soft px-4 py-3 text-[13px] text-crit"
      >
        {apiErrorMessage(state.error)}
      </p>
    );
  }
  const st = state.data;
  const check = st.check;
  const checking = running?.kind === 'check';
  const busy = running !== null || start.isPending;
  const rows = check ? buildRows(check, server) : [];
  const sshDown = server.sshOk === false;
  // Одна карточка: идущий запуск, а когда он закончится — он же как последний (ключ тот же, без перемонтирования).
  const shown = running ?? st.lastRun;

  return (
    <div className="flex flex-col gap-3">
      {/* Шапка: когда проверяли и когда проверим, кнопка «Проверить сейчас» */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12.5px] text-text-3">
        <span aria-live="polite">
          {checking
            ? 'Проверяем сервер…'
            : check
              ? `Проверено ${formatAgo(check.checkedAt)}${st.nextCheckAt ? ` · следующая ${formatIn(st.nextCheckAt)}` : ''}`
              : 'Проверки ещё не было'}
        </span>
        <span className="flex-1" />
        {(check || checking) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || sshDown}
            onClick={() => void launch('check')}
            className="h-8 rounded-[9px] border-border bg-surface-2 px-3 text-[12.5px] font-medium text-text-2 hover:bg-surface-3 hover:text-foreground"
          >
            <RefreshCwIcon className={cn('size-3.5', checking && 'animate-spin')} aria-hidden="true" />
            Проверить сейчас
          </Button>
        )}
      </div>

      {sshDown && (
        <p
          role="alert"
          className="rounded-[12px] border border-crit/40 bg-crit-soft px-4 py-2.5 text-[12.5px] text-crit"
        >
          SSH не отвечает: обслуживание недоступно, пока связь не восстановится. Проверьте связь слева.
        </p>
      )}
      {st.checkError && (
        <p
          role="alert"
          className="rounded-[12px] border border-warn/50 bg-warn-soft px-4 py-2.5 text-[12.5px] text-warn"
        >
          Последняя проверка не удалась: {st.checkError}
          {check ? ' Ниже — данные прошлой проверки.' : ''}
        </p>
      )}

      {!check && !checking && (
        <div className="grid place-items-center rounded-2xl border border-dashed border-border-2 px-6 py-12 text-center">
          <p className="text-[13.5px] font-semibold">Сервер ещё не проверяли</p>
          <p className="mt-1 max-w-[440px] text-[12.5px] text-text-3">
            Панель раз в сутки заходит по SSH и смотрит обновления, перезагрузку, версию агента, диск и
            автообновления. Первая проверка начнётся сама в течение пяти минут, либо запустите её сейчас.
          </p>
          {!sshDown && (
            <Button
              type="button"
              disabled={busy}
              onClick={() => void launch('check')}
              className="mt-4 h-9 rounded-[10px] bg-brand px-4 text-[13px] font-semibold text-(--ns-on-accent) hover:brightness-[1.07]"
            >
              Проверить сейчас
            </Button>
          )}
        </div>
      )}
      {!check && checking && (
        <div className="flex flex-col gap-2" aria-busy="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-14 rounded-[12px]" />
          ))}
        </div>
      )}

      {check && (
        <ul
          className="overflow-hidden rounded-2xl border border-border bg-surface"
          aria-label="Чек-лист сервера"
        >
          {rows.map((r) => {
            const Icon = TONE_ICON[r.tone];
            return (
              <li
                key={r.key}
                className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 border-t border-border px-4 py-3 first:border-t-0 max-sm:grid-cols-[28px_minmax(0,1fr)] max-sm:gap-y-2"
              >
                <span
                  className={cn('grid size-7 place-items-center rounded-[8px]', TONE_TILE[r.tone])}
                  aria-hidden="true"
                >
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium">{r.title}</span>
                  <span className="block text-[12px] text-text-3">{r.subtitle}</span>
                </span>
                <span className="flex items-center gap-2 max-sm:col-start-2 max-sm:justify-start">
                  {r.tier && <TierChip tier={r.tier} />}
                  {r.action ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy || sshDown}
                      onClick={() => onAction(r.action?.kind ?? 'apt_upgrade')}
                      className="h-8 rounded-[9px] border-border bg-surface-2 px-3 text-[12.5px] font-medium text-text-2 hover:bg-surface-3 hover:text-foreground"
                    >
                      {r.action.label ?? ACTION_BUTTON[r.action.kind]}
                    </Button>
                  ) : (
                    <span className="text-[12px] text-text-3">{r.note}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {shown && <RunCard key={shown.id} run={shown} live={running !== null} />}

      <p className="text-[11.5px] text-text-3">
        <TierChip tier="T1" /> панель делает сама, обратимо и с проверкой после · <TierChip tier="T2" /> с
        вашим подтверждением · <TierChip tier="T3" /> только вручную в терминале. Перезагрузка всегда T3.
      </p>

      {confirm && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && !start.isPending && setConfirm(null)}
          kind="warn"
          title={CONFIRM[confirm].title(server.name)}
          description={CONFIRM[confirm].description(check)}
          note={`Уровень ${MAINTENANCE_TIERS[confirm]}: ход и результат попадут в Журнал сервера.`}
          yesLabel={CONFIRM[confirm].yes}
          loading={start.isPending}
          onConfirm={() => launch(confirm)}
        />
      )}
    </div>
  );
}
