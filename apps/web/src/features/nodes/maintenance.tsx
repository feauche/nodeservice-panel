import {
  NODE_MAINTENANCE_REASON_MAX,
  type NodeMaintenance,
  type NodeMaintenanceStart,
  type RemnawaveNode,
} from '@nodeservice/shared';
import { CheckIcon, ClockIcon, Loader2Icon, TriangleAlertIcon, WrenchIcon } from 'lucide-react';
import { useState } from 'react';
import { DialogPrimaryButton, DialogSecondaryButton } from '@/components/dialog-actions';
import { DialogHead, dialogBox, dialogFoot, footButton } from '@/components/dialog-parts';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { hhmm } from '@/features/incidents/incident-format';
import { Toggle } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import {
  useEndMaintenance,
  useExtendMaintenance,
  useMaintenanceHosts,
  useStartMaintenance,
} from './maintenance-api';

/** Срок словами: «до 15:40» или «до выключения». */
export const maintenanceUntil = (m: Pick<NodeMaintenance, 'until'>) =>
  m.until ? `до ${hhmm(m.until)}` : 'до выключения';

/** Сколько осталось: «47 мин», «1 ч 12 мин», «меньше минуты». */
export function maintenanceLeft(until: string, now: number): string {
  const min = Math.ceil((Date.parse(until) - now) / 60_000);
  if (min <= 1) return 'меньше минуты';
  if (min < 60) return `${min} мин`;
  return min % 60 ? `${Math.floor(min / 60)} ч ${min % 60} мин` : `${Math.floor(min / 60)} ч`;
}

/**
 * Метка «Обслуживание» (витрина wave-maintenance-2026-10, раздел 2 — C): короткая в строке ноды, со сроком — в окне
 * ноды. Причина — при наведении.
 */
export function MaintenanceBadge({ m, long = false }: { m: NodeMaintenance; long?: boolean }) {
  return (
    <span
      title={
        m.reason
          ? `Обслуживание ${maintenanceUntil(m)}: «${m.reason}»`
          : `Обслуживание ${maintenanceUntil(m)}`
      }
      className="inline-flex flex-none items-center gap-1 rounded-full bg-brand-soft px-[9px] py-[3px] text-[11.5px] font-semibold whitespace-nowrap text-brand"
    >
      <WrenchIcon className="size-3" aria-hidden="true" />
      {long ? `Обслуживание · ${maintenanceUntil(m)}` : 'Обслуживание'}
    </span>
  );
}

const SIDE_BTN =
  'inline-flex h-9 min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border border-border bg-surface px-3 text-[12.5px] font-medium whitespace-nowrap text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-3.5';

/**
 * Карточка идущего обслуживания в паспорте ноды (витрина, раздел 1 — B): сколько осталось, полоса, причина, Host и
 * кнопки «+1 час» и «Закончить». Итог возврата Host показывается здесь же, пока окно открыто.
 */
export function MaintenanceCard({ node, m }: { node: RemnawaveNode; m: NodeMaintenance }) {
  const now = useNow(true, 30_000);
  const extend = useExtendMaintenance(node.uuid);
  const end = useEndMaintenance(node.uuid);
  const total = m.until ? Date.parse(m.until) - Date.parse(m.startedAt) : 0;
  const share =
    m.until && total > 0 ? Math.min(100, Math.max(2, ((now - Date.parse(m.startedAt)) / total) * 100)) : 0;
  const hosts = m.hosts;
  const error = extend.error ?? end.error;
  return (
    <section
      aria-label="Обслуживание ноды"
      className="flex flex-col gap-2 rounded-[14px] border border-brand/40 bg-brand-soft px-3.5 py-3"
    >
      <div className="flex items-center gap-2 text-[13.5px] font-semibold text-brand">
        <WrenchIcon className="size-3.5 flex-none" aria-hidden="true" />
        {m.until ? `Осталось ${maintenanceLeft(m.until, now)}` : 'До выключения'}
        <span className="ml-auto text-[12px] font-medium text-text-2">
          {m.until ? `до ${hhmm(m.until)}` : `с ${hhmm(m.startedAt)}`}
        </span>
      </div>
      {m.until && (
        <div className="h-1 overflow-hidden rounded-full bg-brand/20" aria-hidden="true">
          <div className="h-full rounded-full bg-brand" style={{ width: `${share}%` }} />
        </div>
      )}
      <p className="m-0 text-[12.5px] leading-relaxed text-text-2">
        {m.reason ? `«${m.reason}». ` : ''}Тревоги, сценарии и автозамена DNS по ноде молчат.
        {hosts && hosts.hidden.length > 0 && ` Host отключены: ${hosts.hidden.length}.`}
      </p>
      {hosts?.error && (
        <p className="m-0 flex items-start gap-1.5 text-[12px] leading-snug text-warn">
          <TriangleAlertIcon className="mt-0.5 size-3.5 flex-none" aria-hidden="true" />
          {hosts.error}
        </p>
      )}
      {error && (
        <p role="alert" className="m-0 text-[12px] leading-snug text-crit">
          {apiErrorMessage(error)}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        {m.until ? (
          <button
            type="button"
            className={SIDE_BTN}
            disabled={extend.isPending || end.isPending}
            onClick={() => extend.mutate()}
          >
            {extend.isPending ? (
              <Loader2Icon className="animate-spin" aria-hidden="true" />
            ) : (
              <ClockIcon aria-hidden="true" />
            )}
            +1 час
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          className={SIDE_BTN}
          disabled={extend.isPending || end.isPending}
          onClick={() => end.mutate()}
        >
          {end.isPending && <Loader2Icon className="animate-spin" aria-hidden="true" />}
          Закончить
        </button>
      </div>
    </section>
  );
}

const DURATIONS: ReadonlyArray<{ key: NodeMaintenanceStart['minutes']; label: string; foot: string }> = [
  { key: 30, label: '30 мин', foot: 'На 30 минут' },
  { key: 60, label: '1 час', foot: 'На 1 час' },
  { key: 180, label: '3 часа', foot: 'На 3 часа' },
  { key: null, label: 'До выключения', foot: 'Без срока' },
];

const QUIET = [
  'События по ноде не заводятся',
  'Сообщений в Telegram нет',
  'Сценарии ноду пропускают',
  'Автозамена DNS ждёт',
];

/** Что отключится при «Отключить Host»: список Host ноды или почему отключать нечего. */
function HostsPreview({ uuid }: { uuid: string }) {
  const q = useMaintenanceHosts(uuid, true);
  if (q.isPending)
    return (
      <div
        className="mt-2.5 flex flex-col gap-2 border-t border-border pt-2.5"
        role="status"
        aria-label="Загружаем Host ноды"
      >
        <Skeleton className="h-4 w-[70%]" />
        <Skeleton className="h-4 w-[55%]" />
      </div>
    );
  if (q.error)
    return (
      <p className="mt-2.5 text-[12px] text-warn">Список Host не прочитан: {apiErrorMessage(q.error)}</p>
    );
  const { hosts, shared, alreadyHidden } = q.data;
  const notes = [
    shared > 0 && `общих Host нескольких нод не трогаем: ${shared}`,
    alreadyHidden > 0 && `уже отключены: ${alreadyHidden}`,
  ].filter(Boolean);
  return (
    <div className="mt-2.5 border-t border-border pt-1">
      {hosts.length === 0 ? (
        <p className="mt-1.5 text-[12.5px] text-text-3">У ноды нет своих Host, которые можно отключить.</p>
      ) : (
        <ul aria-label="Host, которые отключатся" className="m-0 flex list-none flex-col p-0">
          {hosts.map((h) => (
            <li key={h.uuid} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-1.5 text-[12.5px]">
              <span className="min-w-0 break-words">{h.name}</span>
              <span className="ml-auto font-mono text-[12px] break-all text-text-3 max-sm:ml-0 max-sm:basis-full">
                {h.address}
                {h.port ? `:${h.port}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {notes.length > 0 && <p className="mt-1.5 text-[12px] text-text-3">{notes.join(', ')}.</p>}
    </div>
  );
}

/**
 * Окно «Обслуживание ноды» (витрина wave-maintenance-2026-10, раздел 1 — B): срок, причина, «Скрыть Host» со списком
 * и что замолчит. Полоса снизу — как у остальных окон панели: кнопки 40 px.
 */
export function MaintenanceDialog({ node, onClose }: { node: RemnawaveNode; onClose: () => void }) {
  const [minutes, setMinutes] = useState<NodeMaintenanceStart['minutes']>(60);
  const [reason, setReason] = useState('');
  const [hideHosts, setHideHosts] = useState(false);
  const start = useStartMaintenance(node.uuid);
  const now = useNow(true, 30_000);
  const busy = start.isPending;
  async function submit() {
    try {
      await start.mutateAsync({ minutes, reason: reason.trim(), hideHosts });
      onClose();
    } catch {
      // Ошибка показана в окне: start.error.
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent showCloseButton={false} className={cn(dialogBox, 'sm:max-w-[560px]')}>
        <DialogHead
          title={`Обслуживание ноды «${node.name}»`}
          description="Панель не будет тревожить по этой ноде, пока вы с ней работаете."
        />
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5 max-sm:px-4">
          <div>
            <div id="mt-term" className="mb-1.5 text-[12.5px] font-medium text-text-2">
              На сколько
            </div>
            <div
              role="radiogroup"
              aria-labelledby="mt-term"
              className="grid grid-cols-4 gap-1.5 max-sm:grid-cols-2"
            >
              {DURATIONS.map((d) => (
                // biome-ignore lint/a11y/useSemanticElements: кнопки-варианты одной высоты, как Segmented
                <button
                  key={String(d.key)}
                  type="button"
                  role="radio"
                  aria-checked={minutes === d.key}
                  onClick={() => setMinutes(d.key)}
                  className={cn(
                    'h-10 cursor-pointer rounded-[10px] border px-2 text-[13px] whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-brand',
                    minutes === d.key
                      ? 'border-brand bg-brand-soft font-semibold text-foreground'
                      : 'border-border bg-surface-2 text-text-2 hover:bg-surface-3 hover:text-foreground',
                  )}
                >
                  {d.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[12px] text-text-3">
              {minutes === null
                ? 'Без срока: обслуживание идёт, пока вы не нажмёте «Закончить».'
                : `Закончится само в ${hhmm(new Date(now + minutes * 60_000).toISOString())}. Продлить можно в любой момент.`}
            </p>
          </div>
          <div>
            <label
              htmlFor="mt-reason"
              className="mb-1.5 flex items-center text-[12.5px] font-medium text-text-2"
            >
              Причина
              <span className="ml-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] font-semibold text-text-3">
                Необязательно
              </span>
            </label>
            <Input
              id="mt-reason"
              value={reason}
              maxLength={NODE_MAINTENANCE_REASON_MAX}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Например: обновляю ядро"
              className="h-10"
            />
            <p className="mt-1.5 text-[12px] text-text-3">
              Видна в карточке ноды и в «Журнале». Пусто — запишется просто «обслуживание».
            </p>
          </div>
          <div className="rounded-[14px] border border-border bg-surface-2 px-3.5 py-3">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <label htmlFor="mt-hide" className="block cursor-pointer text-[13.5px] font-semibold">
                  Отключить Host на это время
                </label>
                <p className="mt-0.5 text-[12.5px] leading-snug text-text-3">
                  Клиенты не попадут на ноду, пока вы с ней работаете. Когда обслуживание закончится, панель
                  вернёт Host как были.
                </p>
              </div>
              <Toggle id="mt-hide" checked={hideHosts} onChange={setHideHosts} />
            </div>
            {hideHosts && <HostsPreview uuid={node.uuid} />}
          </div>
          <div className="rounded-[14px] border border-border bg-bg-2 px-3.5 py-3">
            <div className="mb-1.5 text-[11px] font-semibold tracking-[0.1em] text-text-3 uppercase">
              Пока идёт обслуживание
            </div>
            <ul className="m-0 grid list-none grid-cols-2 gap-x-3.5 gap-y-1.5 p-0 max-sm:grid-cols-1">
              {QUIET.map((q) => (
                <li key={q} className="flex items-center gap-1.5 text-[12.5px] text-text-2">
                  <CheckIcon className="size-3.5 flex-none text-ok" aria-hidden="true" />
                  {q}
                </li>
              ))}
            </ul>
            <p className="mt-2 border-t border-border pt-2 text-[12px] leading-snug text-text-3">
              Если к концу срока нода так и не заработает, придёт обычная тревога. Включение и окончание
              записываются в «Журнал».
            </p>
          </div>
          {start.error && (
            <p
              role="alert"
              className="rounded-[10px] border border-crit/30 bg-crit-soft px-3 py-2 text-[12.5px] text-crit"
            >
              {apiErrorMessage(start.error)}
            </p>
          )}
        </div>
        <div className={dialogFoot}>
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3 max-sm:hidden">
            {DURATIONS.find((d) => d.key === minutes)?.foot}
            {hideHosts ? ', Host отключатся' : ''}
          </p>
          <div className="flex gap-2 max-sm:flex-col">
            <DialogSecondaryButton disabled={busy} onClick={onClose} className={footButton}>
              Отмена
            </DialogSecondaryButton>
            <DialogPrimaryButton
              disabled={busy}
              onClick={() => void submit()}
              className="h-10 min-w-[128px] flex-none rounded-[10px] px-4 whitespace-nowrap max-sm:w-full sm:w-auto sm:flex-none sm:max-w-none"
            >
              {busy && <Loader2Icon className="animate-spin" aria-hidden="true" />}
              Включить обслуживание
            </DialogPrimaryButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
