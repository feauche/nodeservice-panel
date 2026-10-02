import type { Notification, NotificationSeverity } from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';
import {
  BellIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  HardDriveDownloadIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { formatWhen } from '@/features/audit/audit-format';
import { openServer, serverIdFromLink } from '@/features/servers/server-modal-store';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { useClearNotifications, useNotifications, useReadAllNotifications } from './notifications-api';

type Category = 'all' | 'attention' | 'checks' | 'maintenance' | 'system';

const FILTERS: Array<{ key: Category; label: string }> = [
  { key: 'all', label: 'Все отчёты' },
  { key: 'attention', label: 'Требуют внимания' },
  { key: 'checks', label: 'Автопроверки' },
  { key: 'maintenance', label: 'Обслуживание' },
  { key: 'system', label: 'Система' },
];

function categoryOf(n: Notification): Exclude<Category, 'all' | 'attention'> {
  const text = `${n.title} ${n.body ?? ''}`.toLowerCase();
  if (/обслуж|агент|обновл/.test(text)) return 'maintenance';
  if (/проверк|геоблок|регион ip|качество ip|dpi/.test(text)) return 'checks';
  return 'system';
}

const CATEGORY_LABEL = { checks: 'автопроверка', maintenance: 'обслуживание', system: 'система' } as const;

const LOOK: Record<NotificationSeverity, { Icon: typeof BellIcon; tone: string; badge: string }> = {
  ok: { Icon: CheckCircle2Icon, tone: 'bg-ok-soft text-ok', badge: 'bg-ok-soft text-ok' },
  info: { Icon: ShieldCheckIcon, tone: 'bg-brand-soft text-brand', badge: 'bg-brand-soft text-brand' },
  warn: { Icon: TriangleAlertIcon, tone: 'bg-warn-soft text-warn', badge: 'bg-warn-soft text-warn' },
  crit: { Icon: CircleAlertIcon, tone: 'bg-crit-soft text-crit', badge: 'bg-crit-soft text-crit' },
};

const STATUS: Record<NotificationSeverity, string> = {
  ok: 'завершено',
  info: 'информация',
  warn: 'нужно внимание',
  crit: 'критично',
};

function dayLabel(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Сегодня';
  if (date.toDateString() === yesterday.toDateString()) return 'Вчера';
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(date);
}

function groupByDay(items: Notification[]): Array<{ day: string; items: Notification[] }> {
  const groups: Array<{ day: string; items: Notification[] }> = [];
  for (const item of items) {
    const day = dayLabel(item.createdAt);
    const current = groups.at(-1);
    if (current?.day === day) current.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

export function NotificationsCenterPage() {
  const query = useNotifications();
  const readAll = useReadAllNotifications();
  const clear = useClearNotifications();
  const [filter, setFilter] = useState<Category>('all');
  const [confirmClear, setConfirmClear] = useState(false);
  const items = query.data?.items ?? [];

  useEffect(() => {
    if (!query.data?.unread) return;
    const timer = setTimeout(() => void readAll.mutateAsync().catch(() => undefined), 1500);
    return () => clearTimeout(timer);
  }, [query.data?.unread, readAll.mutateAsync]);

  const visible = useMemo(
    () =>
      items.filter((n) => {
        if (filter === 'all') return true;
        if (filter === 'attention') return n.severity === 'warn' || n.severity === 'crit';
        return categoryOf(n) === filter;
      }),
    [filter, items],
  );
  const attention = items.filter((n) => n.severity === 'warn' || n.severity === 'crit').length;
  const today = new Date().toDateString();
  const todayItems = items.filter((n) => new Date(n.createdAt).toDateString() === today);
  const maintenance = todayItems.filter((n) => categoryOf(n) === 'maintenance').length;
  const checks = todayItems.filter((n) => categoryOf(n) === 'checks').length;

  return (
    <div className="space-y-4" data-testid="notifications-center">
      <div className="grid grid-cols-2 gap-2.5 xl:grid-cols-4">
        <Metric
          label="Требуют внимания"
          value={attention}
          note={attention ? 'проверьте отчёты ниже' : 'всё спокойно'}
        />
        <Metric label="Новых" value={query.data?.unread ?? 0} note="с последнего просмотра" />
        <Metric label="Автопроверки сегодня" value={checks} note="сохранённых отчётов" />
        <Metric label="Обслуживание сегодня" value={maintenance} note="завершённых серий" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setFilter(item.key)}
            className={cn(
              'h-8 cursor-pointer rounded-[9px] border px-3 text-[12.5px] font-medium transition-colors',
              filter === item.key
                ? 'border-brand/45 bg-brand-soft text-brand'
                : 'border-border bg-surface text-text-2 hover:bg-surface-2 hover:text-foreground',
            )}
          >
            {item.label}
            {item.key === 'attention' && attention > 0 ? ` · ${attention}` : ''}
          </button>
        ))}
        <span className="flex-1" />
        <Button variant="ghost" size="sm" disabled={items.length === 0} onClick={() => setConfirmClear(true)}>
          <Trash2Icon /> Очистить историю
        </Button>
      </div>

      {query.isPending && <LoadingCards />}
      {query.isError && (
        <div className="rounded-[14px] border border-crit/30 bg-crit-soft px-4 py-5 text-[13px] text-crit">
          {apiErrorMessage(query.error)}{' '}
          <button
            type="button"
            className="cursor-pointer font-semibold underline"
            onClick={() => void query.refetch()}
          >
            Повторить
          </button>
        </div>
      )}
      {query.data && visible.length === 0 && (
        <div className="rounded-[14px] border border-border bg-surface px-5 py-12 text-center">
          <BellIcon className="mx-auto size-7 text-text-3" />
          <p className="mt-2 text-[14px] font-semibold">Здесь пока нет отчётов</p>
          <p className="mt-1 text-[12.5px] text-text-3">
            Результаты автоматических проверок и обслуживания появятся после ближайшего запуска.
          </p>
        </div>
      )}
      {visible.length > 0 && (
        <div className="space-y-5">
          {groupByDay(visible).map((group) => (
            <section key={group.day} aria-label={group.day}>
              <h2 className="mb-2.5 text-[11px] font-semibold tracking-[0.08em] text-text-3 uppercase">
                {group.day}
              </h2>
              <div className="space-y-2.5">
                {group.items.map((n) => (
                  <ReportCard key={n.id} notification={n} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        kind="warn"
        title="Очистить историю уведомлений?"
        description="Отчёты исчезнут из этого раздела. Инциденты и записи Журнала останутся на месте."
        yesLabel="Очистить"
        loading={clear.isPending}
        onConfirm={async () => {
          try {
            await clear.mutateAsync();
            setConfirmClear(false);
          } catch (err) {
            setConfirmClear(false);
            toast.error(apiErrorMessage(err));
          }
        }}
      />
    </div>
  );
}

function Metric({ label, value, note }: { label: string; value: number; note: string }) {
  return (
    <div className="rounded-[13px] border border-border bg-surface px-3.5 py-3">
      <span className="block text-[11px] text-text-3">{label}</span>
      <strong className="mt-0.5 block font-heading text-[19px]">{value}</strong>
      <span className="text-[11px] text-text-2">{note}</span>
    </div>
  );
}

function ReportCard({ notification: n }: { notification: Notification }) {
  const [expanded, setExpanded] = useState(false);
  const look = LOOK[n.severity];
  const Icon =
    categoryOf(n) === 'maintenance'
      ? RefreshCwIcon
      : categoryOf(n) === 'checks'
        ? HardDriveDownloadIcon
        : look.Icon;
  const serverId = n.link ? serverIdFromLink(n.link.to) : null;
  const hasDetails = Boolean(n.body && (n.body.length > 420 || n.body.split('\n').length > 6));
  return (
    <article
      className={cn(
        'overflow-hidden rounded-[14px] border bg-surface',
        n.readAt ? 'border-border' : 'border-brand/35 shadow-[inset_3px_0_0_var(--ns-brand)]',
      )}
    >
      <div className="flex items-start gap-3 p-4">
        <span className={cn('grid size-9 flex-none place-items-center rounded-[10px]', look.tone)}>
          <Icon className="size-4.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[13.5px] leading-snug font-bold">{n.title}</h2>
          <time className="mt-1 block text-[11.5px] text-text-3" dateTime={n.createdAt}>
            {formatWhen(n.createdAt)} · {CATEGORY_LABEL[categoryOf(n)]}
          </time>
        </div>
        <span className={cn('rounded-full px-2 py-1 text-[10.5px] font-semibold', look.badge)}>
          {STATUS[n.severity]}
        </span>
      </div>
      {n.body && (
        <div className="border-t border-border bg-bg-2/55 px-4 py-3">
          <div
            className={cn(
              'text-[12.5px] leading-relaxed whitespace-pre-line text-text-2',
              hasDetails &&
                !expanded &&
                'max-h-24 overflow-hidden [mask-image:linear-gradient(#000_65%,transparent)]',
            )}
          >
            {categoryOf(n) === 'checks' && n.body.includes('\nПо серверам:\n') ? (
              <CheckReportBody body={n.body} />
            ) : (
              n.body
            )}
          </div>
          {hasDetails && (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="mt-2 inline-flex cursor-pointer items-center gap-1 text-[11.5px] font-semibold text-brand hover:underline"
              aria-expanded={expanded}
            >
              {expanded ? (
                <>
                  Свернуть <ChevronUpIcon className="size-3.5" />
                </>
              ) : (
                <>
                  Показать подробности <ChevronDownIcon className="size-3.5" />
                </>
              )}
            </button>
          )}
        </div>
      )}
      {n.link && (
        <div className="border-t border-border px-4 py-2.5 text-[12px]">
          {serverId ? (
            <button
              type="button"
              onClick={() => openServer(serverId)}
              className="cursor-pointer font-semibold text-brand hover:underline"
            >
              {n.link.label} →
            </button>
          ) : (
            <Link to={n.link.to} className="font-semibold text-brand hover:underline">
              {n.link.label} →
            </Link>
          )}
        </div>
      )}
    </article>
  );
}

function CheckReportBody({ body }: { body: string }) {
  const [summary = '', rows = ''] = body.split('\nПо серверам:\n', 2);
  const groups: Array<{ title: string; detail: string[] }> = [];
  for (const line of rows.split('\n')) {
    if (line.startsWith('• ')) groups.push({ title: line.slice(2), detail: [] });
    else if (line.trim().startsWith('↳')) groups.at(-1)?.detail.push(line.trim().slice(1).trim());
  }
  return (
    <div className="flex flex-col gap-2.5 whitespace-normal">
      <p className="m-0 whitespace-pre-line">{summary}</p>
      <div className="overflow-hidden rounded-[10px] border border-border bg-surface">
        {groups.map((group) => {
          const state =
            group.title.includes('стало хуже') || group.title.includes('ошибка')
              ? 'worse'
              : group.title.includes('исправилось')
                ? 'better'
                : 'same';
          return (
            <div
              key={`${group.title}-${group.detail.join()}`}
              className="flex flex-wrap items-start gap-2 border-t border-border px-3 py-2.5 first:border-t-0"
            >
              <div className="min-w-0 flex-1">
                <b className="block text-[12.5px] font-semibold text-foreground">
                  {group.title.split(' · ')[0]}
                </b>
                {group.title.includes(' · ') && (
                  <span className="text-[11.5px] text-text-3">
                    {group.title.slice(group.title.indexOf(' · ') + 3)}
                  </span>
                )}
                {group.detail.map((line) => (
                  <span key={line} className="mt-1 block text-[11.5px] text-text-2">
                    {line}
                  </span>
                ))}
              </div>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10.5px] font-semibold',
                  state === 'worse'
                    ? 'bg-crit-soft text-crit'
                    : state === 'better'
                      ? 'bg-ok-soft text-ok'
                      : 'bg-surface-3 text-text-3',
                )}
              >
                {state === 'worse' ? 'хуже' : state === 'better' ? 'исправилось' : 'без изменений'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LoadingCards() {
  return (
    <div className="space-y-2.5">
      {[0, 1, 2].map((n) => (
        <div key={n} className="h-32 animate-pulse rounded-[14px] border border-border bg-surface" />
      ))}
    </div>
  );
}
