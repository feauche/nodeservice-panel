import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  formatScenarioHostName,
  type Scenario,
  type ScenarioOverview,
  scenarioConditionDescriptions,
  scenarioConditionLabel,
  scenarioConditions,
  scenarioHostsSchema,
  scenarioLabels,
} from '@nodeservice/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ArrowDownIcon,
  BellIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  ClipboardListIcon,
  CopyIcon,
  EllipsisIcon,
  EyeOffIcon,
  GitBranchIcon,
  GripVerticalIcon,
  ListChecksIcon,
  LockIcon,
  PlayIcon,
  PlusIcon,
  RadarIcon,
  SearchIcon,
  SendIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  TypeIcon,
  XIcon,
  ZapIcon,
} from 'lucide-react';
import { Popover } from 'radix-ui';
import { Children, type Dispatch, type ReactNode, type SetStateAction, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { RowsSkeleton } from '@/components/ui/loading-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useNodes, useRemnaPermissions } from '@/features/nodes/nodes-api';
import { plural } from '@/features/overview/overview-format';
import { useMonitoring } from '@/features/settings/settings-api';
import { Pill, Segmented, Toggle } from '@/features/settings/settings-ui';
import { useTelegramSettings } from '@/features/settings/telegram-api';
import { api, apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { RunStrip, RunsPanel } from './scenario-journal';
import { conditionsPhrase, lower, pickedWord, scopePhrase } from './scenario-text';

type Action = Scenario['actions'][number];
type Condition = Scenario['trigger'];
/** Вкладки окна сценария: правило, его срабатывания, пример сообщения в Telegram. */
export type EditorTab = 'rule' | 'runs' | 'message';

/** Что изменилось в сценарии — коротко, для полосы сохранения: «пауза 15 → 30 мин», «шаги». */
export function changesOf(a: Scenario, b: Scenario): string[] {
  const out: string[] = [];
  if (a.name.trim() !== b.name.trim()) out.push('название');
  if (
    a.trigger !== b.trigger ||
    a.conditionMode !== b.conditionMode ||
    a.conditions.join() !== b.conditions.join()
  )
    out.push('условие');
  if (a.holdMinutes !== b.holdMinutes) out.push(`держится ${b.holdMinutes} → ${a.holdMinutes} мин`);
  if (a.scope !== b.scope || a.nodes.join() !== b.nodes.join()) out.push('ноды');
  if (a.actions.join() !== b.actions.join()) out.push('шаги');
  if (a.renameMode !== b.renameMode || a.renameText !== b.renameText) out.push('имя Host');
  if (a.autoRestore !== b.autoRestore) out.push('возврат Host');
  if (JSON.stringify(a.hostBindings) !== JSON.stringify(b.hostBindings)) out.push('привязка Host');
  if (a.cooldownMinutes !== b.cooldownMinutes)
    out.push(`пауза ${b.cooldownMinutes} → ${a.cooldownMinutes} мин`);
  return out;
}

/** Шаги сценария: что делает и зачем — одной строкой под названием. Telegram всегда последний. */
export const STEPS: Record<Action, { title: string; hint: string; icon: typeof RadarIcon }> = {
  check_tcp: {
    title: 'Проверить TCP',
    hint: 'Check-Host проверит порт ноды из России и других стран. Бесплатно.',
    icon: RadarIcon,
  },
  record_event: {
    title: 'Записать событие',
    hint: 'Допишет срабатывание и итог в открытое событие ноды в «Событиях». Нет события — только в «Метриках».',
    icon: ClipboardListIcon,
  },
  hide_host: {
    title: 'Скрыть Host',
    hint: 'Host этой ноды выключается в Remnawave, клиенты уходят на другие ноды.',
    icon: EyeOffIcon,
  },
  rename_host: {
    title: 'Изменить имя Host',
    hint: 'Клиенты видят в списке подключений, что нода временно не работает.',
    icon: TypeIcon,
  },
  notify: {
    title: 'Уведомить в Telegram',
    hint: 'Сообщение с условием и результатом действий. Всегда последним.',
    icon: BellIcon,
  },
};
const ORDERABLE: Action[] = ['check_tcp', 'record_event', 'hide_host', 'rename_host'];
const CHIP =
  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[9px] border border-border-2 bg-surface px-2.5 text-[13px] font-semibold whitespace-nowrap transition-colors hover:border-ai/50 focus-visible:outline-2 focus-visible:outline-ai [&_svg]:size-3.5 [&_svg]:text-text-3';

/** Шаг «То»: номер по порядку, название и пояснение, переключатель; включённый — с ручкой для перестановки. */
function StepCard({
  action,
  on,
  index,
  sortable,
  onToggle,
  children,
}: {
  action: Action;
  on: boolean;
  index: number | null;
  sortable: boolean;
  onToggle: (on: boolean) => void;
  children?: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({
      id: action,
      disabled: !sortable,
    });
  const meta = STEPS[action];
  const nested = Children.toArray(children);
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'rounded-[14px] border bg-surface px-3.5 py-3 transition-[border-color,background-color]',
        on ? 'border-teal/45 bg-teal/[0.05]' : 'border-border',
        isDragging && 'relative z-10 shadow-float',
      )}
    >
      <div className="grid grid-cols-[18px_30px_minmax(0,1fr)_auto] items-center gap-3">
        {action === 'notify' ? (
          <LockIcon className="size-4 text-text-3" aria-label="Всегда последним" />
        ) : sortable ? (
          <button
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label={`Переставить шаг «${meta.title}»`}
            className="grid cursor-grab touch-none place-items-center rounded text-text-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand active:cursor-grabbing"
          >
            <GripVerticalIcon className="size-4" />
          </button>
        ) : (
          <span />
        )}
        <span
          className={cn(
            'grid size-[30px] place-items-center rounded-[9px] text-[13px] font-extrabold transition-colors',
            on ? 'bg-teal text-bg' : 'bg-surface-2 text-text-3',
          )}
          aria-hidden="true"
        >
          {index ?? '—'}
        </span>
        <span className="min-w-0">
          <b className="flex items-center gap-1.5 text-[14px] font-semibold">
            <meta.icon className="size-4 flex-none text-text-3" aria-hidden="true" />
            {meta.title}
          </b>
          <small className="mt-0.5 block text-[12.5px] leading-snug text-text-3">{meta.hint}</small>
        </span>
        <Toggle
          id={`scenario-step-${action}`}
          checked={on}
          onChange={onToggle}
          aria-label={`Шаг «${meta.title}»`}
        />
      </div>
      {on && nested.length > 0 && (
        <div className="mt-3 ml-[60px] flex flex-col gap-2.5 max-sm:ml-0">{nested}</div>
      )}
    </div>
  );
}

/** Новое имя Host (пробелы — точками, как их поставит сценарий) и предупреждение о пределе Remnawave. */
function RenamePreview({ name, mode, text }: { name: string; mode: Scenario['renameMode']; text: string }) {
  const next = formatScenarioHostName(name, mode, text);
  return (
    <>
      <p className="mt-1 text-brand">→ {next.replaceAll(' ', '·')}</p>
      {next.length > 100 && (
        <p className="mt-1 text-[11.5px] text-warn">Длиннее 100 знаков — Remnawave такое имя не примет.</p>
      )}
    </>
  );
}

function CloseButton({
  busy,
  onClose,
  className,
}: {
  busy: boolean;
  onClose: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label="Закрыть окно"
      disabled={busy}
      onClick={onClose}
      className={cn(
        'grid size-9 flex-none cursor-pointer place-items-center rounded-[10px] border border-border bg-surface-2 text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground disabled:opacity-50',
        className,
      )}
    >
      <XIcon className="size-4" aria-hidden="true" />
    </button>
  );
}

function Note({ tone = 'muted', children }: { tone?: 'muted' | 'warn'; children: ReactNode }) {
  return (
    <p
      role={tone === 'warn' ? 'status' : undefined}
      className={cn(
        'rounded-[10px] px-3 py-2 text-[12.5px] leading-snug',
        tone === 'warn' ? 'border border-warn/30 bg-warn-soft text-text-2' : 'bg-surface-2 text-text-2',
      )}
    >
      {children}
    </p>
  );
}

/**
 * Редактор сценария «Если → то» (витрина redesign-2026-10, вариант A, сдержанно): условие читается фразой,
 * шаги — карточками по порядку, справа живой предпросмотр. Весь прежний функционал на месте: до трёх условий с
 * «и/или», подтверждение по времени, выбор нод, пять действий и их порядок, имя Host, возврат после
 * восстановления, пауза, ручная привязка Host и предпросмотр.
 */
export function ScenarioEditor({
  draft,
  original = null,
  initialTab = 'rule',
  runsNode,
  summary = null,
  timeZone,
  rules = [],
  setDraft,
  busy,
  onSave,
  onClose,
  onDelete,
  onDuplicate,
  onToggleEnabled,
  error,
}: {
  draft: Scenario;
  /** Сохранённый сценарий — с чем сравнивать правки; null — новый. */
  original?: Scenario | null;
  initialTab?: EditorTab;
  /** С какой ноды начать отбор во вкладке «Срабатывания» (переход из окна ноды). */
  runsNode?: string;
  /** Строка сводки этого сценария: полоска и числа. */
  summary?: ScenarioOverview['items'][number] | null;
  timeZone?: string;
  rules?: Scenario[];
  setDraft: Dispatch<SetStateAction<Scenario | null>>;
  busy: boolean;
  onSave: () => void;
  onClose: () => void;
  onDelete?: () => void;
  onDuplicate?: () => void;
  /** «Включён» сохраняется сразу, отдельно от остальных правок (только у сохранённого сценария). */
  onToggleEnabled?: (enabled: boolean) => void | Promise<void>;
  error: string | null;
}) {
  const nodes = useNodes();
  const telegram = useTelegramSettings();
  const monitoring = useMonitoring();
  const [search, setSearch] = useState('');
  const [holdInput, setHoldInput] = useState(String(draft.holdMinutes));
  const [cooldownInput, setCooldownInput] = useState(String(draft.cooldownMinutes));
  const [deleting, setDeleting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [tab, setTab] = useState<EditorTab>(original ? initialTab : 'rule');
  const [showAllHosts, setShowAllHosts] = useState(false);
  // Что поменяли относительно сохранённого — подпись в полосе сохранения и вопрос при закрытии.
  const changes = original ? changesOf(draft, original) : [];
  const close = () => (changes.length ? setLeaving(true) : onClose());
  const tabs: Array<[EditorTab, string, typeof RadarIcon]> = [
    ['rule', 'Правило', SlidersHorizontalIcon],
    ...(original
      ? ([['runs', 'Срабатывания', ListChecksIcon]] as Array<[EditorTab, string, typeof RadarIcon]>)
      : []),
    ['message', 'Сообщение', SendIcon],
  ];
  const conditions = scenarioConditions(draft);
  const all = nodes.data?.nodes ?? [];
  const hostStep = draft.actions.some((a) => a === 'hide_host' || a === 'rename_host');
  const hosts = useQuery({
    queryKey: ['scenario-hosts'],
    queryFn: ({ signal }) => api.get('/scenarios/hosts', scenarioHostsSchema, signal),
    enabled: hostStep,
    staleTime: 15_000,
  });
  // Право «Изменение Host» Remnawave заранее не сообщает: видно только после попытки (или отказа).
  const permissions = useRemnaPermissions(hostStep);
  const hostRight = permissions.data?.items.find((p) => p.scope === 'hosts:update')?.state;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const change = (v: Partial<Scenario>) => {
    const next = { ...draft, ...v };
    if (next.scope === 'selected')
      next.hostBindings = next.hostBindings.filter((b) => next.nodes.includes(b.nodeUuid));
    setDraft(next);
  };
  const setConditions = (list: Condition[]) =>
    change({ conditions: list, trigger: list[0] ?? draft.trigger });
  const enabledOrder: Action[] = draft.actions.filter((a) => a !== 'notify');
  const withNotify = (order: Action[], notify = draft.actions.includes('notify')) =>
    notify ? [...order, 'notify' as const] : order;
  const toggleStep = (action: Action, on: boolean) => {
    if (action === 'notify') change({ actions: withNotify(enabledOrder, on) });
    else
      change({
        actions: withNotify(on ? [...enabledOrder, action] : enabledOrder.filter((a) => a !== action)),
      });
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = enabledOrder.indexOf(active.id as Action);
    const to = enabledOrder.indexOf(over.id as Action);
    if (from < 0 || to < 0) return;
    change({ actions: withNotify(arrayMove(enabledOrder, from, to)) });
  };

  const timeValid = (v: string, min: number, max: number) =>
    v.trim() !== '' && Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max;
  // Почему «Сохранить» недоступна — коротко рядом с кнопкой, а не молча.
  const blocker =
    draft.name.trim().length < 2
      ? 'Название — от двух букв'
      : !draft.actions.length
        ? 'Включите хотя бы один шаг'
        : draft.scope === 'selected' && !draft.nodes.length
          ? 'Выберите ноды'
          : draft.actions.includes('rename_host') && !draft.renameText.trim()
            ? 'Введите текст для имени Host'
            : !timeValid(holdInput, 1, 60)
              ? 'Время — от 1 до 60 мин'
              : !timeValid(cooldownInput, 5, 1440)
                ? 'Пауза — от 5 до 1440 мин'
                : null;

  const allowedNodes = all.filter((n) => draft.scope === 'all' || draft.nodes.includes(n.uuid));
  const targets = (hosts.data?.hosts ?? [])
    .map((h) => {
      const manual = draft.hostBindings.find((b) => b.hostUuid === h.uuid);
      const ids = manual && !h.nodes.length ? [manual.nodeUuid] : h.nodes;
      return {
        ...h,
        nodes: ids,
        nodeNames: ids.map((id) => all.find((n) => n.uuid === id)?.name ?? id),
        automaticNodes: h.nodes,
      };
    })
    .filter(
      (h) => !h.nodes.length || draft.scope === 'all' || h.nodes.some((id) => draft.nodes.includes(id)),
    );
  const willChange = targets.filter((h) => h.nodes.length === 1);
  const count = draft.nodes.length;
  const scopeText =
    draft.scope === 'all' ? 'любой ноде' : count ? `${count} ${pickedWord(count)}` : 'выберите ноды';
  // В пересказе до трёх нод — по именам: «на нодах «Турция - 1» и «США - 1»».
  const readScope = scopePhrase(draft, all);
  const visibleNodes = all.filter((n) =>
    `${n.name} ${n.address}`.toLowerCase().includes(search.toLowerCase()),
  );
  const sample = allowedNodes[0];
  const steps = draft.actions.map((a) => lower(STEPS[a].title));
  const telegramState = telegram.isPending
    ? { tone: 'muted' as const, text: 'Проверяю настройки Telegram…' }
    : telegram.isError
      ? {
          tone: 'warn' as const,
          text: 'Не удалось проверить Telegram — проверьте подключение перед включением.',
        }
      : !telegram.data?.destinations.length
        ? { tone: 'warn' as const, text: 'Сообщение не придёт: Telegram не подключён.' }
        : // Шаг сам и есть согласие на сообщение: отдельного переключателя в настройках Telegram нет.
          { tone: 'ok' as const, text: 'Сообщение придёт в Telegram; в тихие часы — в утренней сводке.' };
  // Пример итога для ноды-образца — теми же словами, что пишет сервер: TCP, событие, Host (один раз на запуск).
  const sampleHosts = sample ? targets.filter((h) => h.nodes.includes(sample.uuid)) : [];
  // Строка на шаг со значком итога, как в сообщении сервера (витрина telegram-2026-10, сценарий A).
  const ownHost = sampleHosts.find((h) => h.nodes.length === 1);
  const rename = draft.actions.includes('rename_host');
  const lines = enabledOrder
    .filter(
      (a, i) =>
        !(a === 'rename_host' || a === 'hide_host') ||
        i === enabledOrder.findIndex((b) => b === 'hide_host' || b === 'rename_host'),
    )
    .map((a) =>
      a === 'check_tcp'
        ? '🔴 TCP: недоступен из РФ'
        : a === 'record_event'
          ? `✅ Записано в событие «${conditions.includes('offline') ? 'Нода не на связи' : '…'}»`
          : !hosts.data
            ? '… Host'
            : !ownHost
              ? `🟠 ${rename ? 'Имя Host не изменено' : 'Host не скрыт'}: у ноды нет своих Host`
              : rename
                ? `✅ Имя Host: «${ownHost.name}» → «${formatScenarioHostName(ownHost.name, draft.renameMode, draft.renameText.trim() || '…')}»`
                : `✅ Скрыт Host: «${ownHost.name}»`,
    );
  const tableCell = 'border border-[#2b3a4c] px-2 py-1';
  const kicker = 'text-[11px] font-semibold tracking-[0.1em] text-text-3 uppercase';

  return (
    <Dialog open onOpenChange={(v) => !v && !busy && close()}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          // Окно постоянного размера на всех вкладках (витрина scenarios-2026-10b, окно A): шапка, вкладки,
          // прокрутка внутри, внизу — полоса сохранения.
          'flex h-[min(780px,calc(100dvh-40px))] w-[min(1180px,calc(100vw-40px))] flex-col gap-0 overflow-hidden rounded-[18px] border border-border-2 bg-surface p-0 shadow-float sm:max-w-[1180px]',
          'max-md:top-0 max-md:left-0 max-md:h-dvh max-md:w-screen max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none max-md:border-0',
        )}
        overlayClassName="bg-black/45 backdrop-blur-sm"
      >
        <header className="flex flex-none items-start gap-3 px-[22px] pt-5 pb-3 max-md:px-4">
          <span className="grid size-10 flex-none place-items-center rounded-[12px] bg-ai-soft text-ai max-sm:hidden">
            <GitBranchIcon className="size-[18px]" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate font-heading text-[18px] font-bold">
              {original ? draft.name.trim() || 'Без названия' : 'Новый сценарий'}
            </DialogTitle>
            <DialogDescription className="mt-0.5 line-clamp-2 text-[12.5px] text-text-3">
              Если {conditionsPhrase(draft)} держится {draft.holdMinutes} мин{' '}
              {readScope ? `на ${readScope}` : '(ноды не выбраны)'}
            </DialogDescription>
          </div>
          <div className="flex h-10 flex-none items-center gap-2.5 rounded-[10px] border border-border px-3">
            <span className="text-[13px] text-text-2 max-sm:hidden">Включён</span>
            <Toggle
              id="scenario-enabled"
              checked={draft.enabled}
              disabled={busy}
              onChange={(enabled) => (onToggleEnabled ? void onToggleEnabled(enabled) : change({ enabled }))}
              aria-label="Сценарий включён"
            />
          </div>
          {(onDuplicate || onDelete) && (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Ещё действия со сценарием"
                className="grid size-10 flex-none cursor-pointer place-items-center rounded-[10px] border border-border bg-surface-2 text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground"
              >
                <EllipsisIcon className="size-4" aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onDuplicate && (
                  <DropdownMenuItem onSelect={() => onDuplicate()}>
                    <CopyIcon aria-hidden="true" />
                    Создать копию
                  </DropdownMenuItem>
                )}
                {onDelete && (
                  <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
                    <Trash2Icon aria-hidden="true" />
                    Удалить сценарий
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <CloseButton busy={busy} onClose={close} className="size-10" />
        </header>
        <div
          role="tablist"
          aria-label="Разделы сценария"
          className="flex flex-none gap-1 border-b border-border px-[22px] max-md:overflow-x-auto max-md:px-4"
        >
          {tabs.map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={cn(
                '-mb-px flex h-11 cursor-pointer items-center gap-2 border-b-2 px-3 text-[13.5px] font-medium whitespace-nowrap transition-colors',
                tab === key
                  ? 'border-brand text-foreground'
                  : 'border-transparent text-text-3 hover:text-foreground',
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
              {label}
              {key === 'runs' && summary && (
                <i className="rounded-full bg-surface-3 px-1.5 text-[11px] font-semibold text-text-2 not-italic tabular-nums">
                  {summary.week}
                </i>
              )}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto" role="tabpanel">
          {tab === 'runs' ? (
            <div className="px-[22px] py-5 max-md:px-4">
              <RunsPanel
                rule={draft}
                rules={rules}
                nodes={all}
                summary={summary}
                {...(runsNode ? { initialNode: runsNode } : {})}
                emptyText={`«${draft.name}» за этот период не срабатывал.`}
              />
            </div>
          ) : tab === 'message' ? (
            <div className="mx-auto flex max-w-[460px] flex-col gap-3 px-[22px] py-6 max-md:px-4">
              {!draft.actions.includes('notify') && (
                <Note tone="warn">
                  Шаг «Уведомить в Telegram» выключен — сообщения не будет. Так оно выглядело бы:
                </Note>
              )}
              <div className="rounded-[14px] border border-[#243140] bg-[#17212b] px-3 py-2.5 text-[12.5px] leading-relaxed text-[#e9edf4]">
                <b>🟡 Сценарий: {draft.name || 'без названия'}</b>
                <br />
                <b>{sample?.name ?? 'Нода'}</b>
                {sample?.address && (
                  <span className="text-[#9fb0c4]">
                    {' '}
                    · <span className="font-mono text-[11.5px]">{sample.address}</span>
                  </span>
                )}
                <br />
                <br />
                <b>Условие:</b> {scenarioConditionLabel(draft)}
                {/* Пустая строка между условием и шагами — как в сообщении. */}
                {lines.length > 0 && <span className="block h-3" aria-hidden="true" />}
                {lines.map((line) => (
                  <span key={line} className="block">
                    {line}
                  </span>
                ))}
                {draft.actions.includes('check_tcp') && (
                  <table className="mt-2 border-collapse text-[11.5px]">
                    <tbody>
                      <tr className="bg-[#22303f]">
                        <th className={cn(tableCell, 'text-left font-medium')}>Откуда</th>
                        <th className={cn(tableCell, 'text-left font-mono font-medium')}>5492</th>
                      </tr>
                      <tr>
                        <td className={tableCell}>РФ</td>
                        <td className={tableCell}>0 из 3</td>
                      </tr>
                      <tr>
                        <td className={tableCell}>Другие страны</td>
                        <td className={tableCell}>3 из 3</td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </div>
              <p className="text-[12px] leading-snug text-text-3">
                Пример{sample ? ` для ноды ${sample.name}` : ''}, если TCP недоступен из РФ: строка на шаг со
                значком итога (✅ сделано, 🟠 замечание, ❌ не вышло), под ними — таблица портов.
              </p>
              <p className="flex flex-wrap items-center gap-2 text-[12.5px] text-text-2">
                <Pill tone={telegramState.tone}>
                  {telegramState.tone === 'ok' ? 'Подключён' : 'Внимание'}
                </Pill>
                {telegramState.text}
              </p>
            </div>
          ) : (
            <div className="grid gap-4 px-[22px] py-5 max-md:px-4 lg:grid-cols-[minmax(0,1fr)_330px]">
              <div className="flex min-w-0 flex-col gap-3.5">
                <label htmlFor="scenario-name" className="block">
                  <span className="mb-1.5 block text-[12.5px] font-medium text-text-2">Название</span>
                  <Input
                    id="scenario-name"
                    className="h-10"
                    value={draft.name}
                    onChange={(e) => change({ name: e.target.value })}
                  />
                </label>
                <section className="rounded-2xl border border-ai/30 bg-ai/[0.05] px-4 py-3.5">
                  <h3 className="mb-2.5 flex items-center gap-2 text-[10.5px] font-extrabold tracking-[0.12em] text-ai uppercase">
                    <ZapIcon className="size-3.5" aria-hidden="true" />
                    Если
                  </h3>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[14px] leading-8">
                    {conditions.map((condition, index) => (
                      <span key={condition} className="contents">
                        {index > 0 && (
                          <Select
                            value={draft.conditionMode}
                            onValueChange={(conditionMode) =>
                              change({ conditionMode: conditionMode as Scenario['conditionMode'] })
                            }
                          >
                            <SelectTrigger
                              aria-label="Как сочетать условия"
                              className={cn(CHIP, 'h-8 w-auto text-ai')}
                            >
                              <SelectValue>{draft.conditionMode === 'all' ? 'и' : 'или'}</SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="all">и — все условия одновременно</SelectItem>
                              <SelectItem value="any">или — хватит любого</SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                        <span className="inline-flex items-center gap-1">
                          <Select
                            value={condition}
                            onValueChange={(value) =>
                              setConditions(
                                conditions.map((c, i) => (i === index ? (value as Condition) : c)),
                              )
                            }
                          >
                            <SelectTrigger
                              aria-label={`Условие ${index + 1}`}
                              className={cn(CHIP, 'h-8 w-auto')}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(Object.keys(scenarioLabels) as Condition[])
                                .filter((key) => key === condition || !conditions.includes(key))
                                .map((key) => (
                                  <SelectItem key={key} value={key}>
                                    {scenarioLabels[key]}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                          {conditions.length > 1 && (
                            <button
                              type="button"
                              aria-label={`Удалить условие ${index + 1}`}
                              className="grid size-6 cursor-pointer place-items-center rounded-md text-text-3 hover:bg-surface-2 hover:text-foreground"
                              onClick={() => setConditions(conditions.filter((_, i) => i !== index))}
                            >
                              <XIcon className="size-3.5" aria-hidden="true" />
                            </button>
                          )}
                        </span>
                      </span>
                    ))}
                    <span className="text-text-2">держится</span>
                    <label className={cn(CHIP, 'cursor-text gap-1 pr-2.5 focus-within:border-ai/60')}>
                      <input
                        aria-label="Подтверждение, минут"
                        inputMode="numeric"
                        aria-invalid={!timeValid(holdInput, 1, 60)}
                        value={holdInput}
                        onChange={(e) => {
                          setHoldInput(e.target.value);
                          if (timeValid(e.target.value, 1, 60))
                            change({ holdMinutes: Number(e.target.value) });
                        }}
                        style={{ width: `${Math.max(holdInput.length, 1) + 0.4}ch` }}
                        className="bg-transparent text-center outline-none"
                      />
                      мин
                    </label>
                    <span className="text-text-2">на</span>
                    {/* modal: окно поверх диалога со своей прокруткой — иначе диалог глушит колесо мыши в списке нод. */}
                    <Popover.Root modal>
                      <Popover.Trigger asChild>
                        <button
                          type="button"
                          className={cn(
                            CHIP,
                            draft.scope === 'selected' && !count && 'border-warn/50 text-warn',
                          )}
                        >
                          {scopeText}
                          <ChevronDownIcon aria-hidden="true" />
                        </button>
                      </Popover.Trigger>
                      <Popover.Portal>
                        <Popover.Content
                          align="start"
                          sideOffset={6}
                          collisionPadding={12}
                          className="z-[60] flex max-h-[var(--radix-popover-content-available-height)] w-[340px] flex-col rounded-[14px] border border-border-2 bg-surface p-3.5 shadow-float outline-none"
                        >
                          <Segmented<Scenario['scope']>
                            label="Какие ноды"
                            value={draft.scope}
                            onChange={(scope) => change({ scope, nodes: scope === 'all' ? [] : draft.nodes })}
                            items={[
                              { key: 'all', label: 'Любая нода' },
                              { key: 'selected', label: 'Выбранные' },
                            ]}
                          />
                          {draft.scope === 'all' ? (
                            <p className="mt-2.5 text-[12.5px] leading-snug text-text-3">
                              Общий сценарий: применяется к каждой ноде при её собственном сбое.
                            </p>
                          ) : (
                            <>
                              <div className="relative mt-2.5">
                                <SearchIcon
                                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-3"
                                  aria-hidden="true"
                                />
                                <Input
                                  className="h-10 pl-9"
                                  aria-label="Найти ноду"
                                  placeholder="Найти ноду"
                                  value={search}
                                  onChange={(e) => setSearch(e.target.value)}
                                />
                              </div>
                              <div className="mt-2 flex items-center gap-3 text-[12.5px]">
                                <span className="flex-1 text-text-3 tabular-nums">
                                  Выбрано {count} из {all.length}
                                </span>
                                <button
                                  type="button"
                                  className="cursor-pointer text-brand hover:underline"
                                  onClick={() =>
                                    change({
                                      nodes: [
                                        ...new Set([...draft.nodes, ...visibleNodes.map((n) => n.uuid)]),
                                      ],
                                    })
                                  }
                                >
                                  Выбрать все
                                </button>
                                <button
                                  type="button"
                                  className="cursor-pointer text-text-3 hover:text-foreground"
                                  onClick={() => change({ nodes: [] })}
                                >
                                  Очистить
                                </button>
                              </div>
                              <fieldset
                                aria-label="Ноды сценария"
                                className="-mx-1.5 mt-2 max-h-[300px] min-h-0 min-w-0 overflow-y-auto overscroll-contain border-t border-border px-1.5 pt-1.5"
                              >
                                {visibleNodes.map((n) => (
                                  <label
                                    key={n.uuid}
                                    htmlFor={`scenario-node-${n.uuid}`}
                                    className="flex cursor-pointer items-center gap-2.5 rounded-[8px] px-1.5 py-1.5 text-[13px] hover:bg-surface-2"
                                  >
                                    <Checkbox
                                      id={`scenario-node-${n.uuid}`}
                                      checked={draft.nodes.includes(n.uuid)}
                                      onCheckedChange={(v) =>
                                        change({
                                          nodes: v
                                            ? [...draft.nodes, n.uuid]
                                            : draft.nodes.filter((id) => id !== n.uuid),
                                        })
                                      }
                                    />
                                    <span className="truncate">{n.name}</span>
                                  </label>
                                ))}
                                {nodes.isPending &&
                                  [1, 2, 3, 4].map((row) => (
                                    <div key={row} className="flex items-center gap-2.5 px-1.5 py-2">
                                      <Skeleton className="size-4 rounded-[5px]" />
                                      <Skeleton className="h-3 w-[55%]" />
                                    </div>
                                  ))}
                                {!nodes.isPending && !visibleNodes.length && (
                                  <p className="px-1.5 py-2 text-[12.5px] text-text-3">Ничего не найдено.</p>
                                )}
                              </fieldset>
                            </>
                          )}
                        </Popover.Content>
                      </Popover.Portal>
                    </Popover.Root>
                    {conditions.length < 3 && (
                      <button
                        type="button"
                        className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-[9px] border border-dashed border-border-2 px-2.5 text-[12.5px] font-medium text-text-2 hover:border-ai/50 hover:text-foreground"
                        onClick={() => {
                          const next = (Object.keys(scenarioLabels) as Condition[]).find(
                            (c) => !conditions.includes(c),
                          );
                          if (next) setConditions([...conditions, next]);
                        }}
                      >
                        <PlusIcon className="size-3.5" aria-hidden="true" />
                        Условие
                      </button>
                    )}
                  </div>
                  <ul className="mt-2.5 flex flex-col gap-1 text-[12px] leading-snug text-text-3">
                    {conditions.map((c) => (
                      <li key={c}>
                        <b className="font-semibold text-text-2">{scenarioLabels[c]}:</b>{' '}
                        {scenarioConditionDescriptions[c]}
                      </li>
                    ))}
                    {conditions.includes('tcp_unreachable') &&
                      monitoring.data?.enabled &&
                      monitoring.data.checkHostEnabled && (
                        <li>
                          TCP проверяется раз в {monitoring.data.checkHostCooldownMinutes} мин, порты{' '}
                          {monitoring.data.checkHostPort} и порт ноды; неполный результат — повтор через
                          минуту.
                        </li>
                      )}
                  </ul>
                </section>
                {monitoring.data && !monitoring.data.enabled && (
                  <Note tone="warn">
                    Мониторинг нод выключен — сценарий не выполнится.{' '}
                    <Link to="/settings/monitoring" className="text-brand hover:underline">
                      Мониторинг нод →
                    </Link>
                  </Note>
                )}
                {monitoring.data?.enabled &&
                  conditions.includes('tcp_unreachable') &&
                  !monitoring.data.checkHostEnabled && (
                    <Note tone="warn">
                      TCP-проверки выключены — условие «TCP недоступен» не подтвердится.{' '}
                      <Link to="/settings/monitoring" className="text-brand hover:underline">
                        Мониторинг нод →
                      </Link>
                    </Note>
                  )}

                <div className="-my-1 flex justify-center text-text-3" aria-hidden="true">
                  <ArrowDownIcon className="size-4" />
                </div>

                <section className="flex flex-col gap-2.5">
                  <h3 className="flex items-center gap-2 text-[10.5px] font-extrabold tracking-[0.12em] text-teal uppercase">
                    <PlayIcon className="size-3.5" aria-hidden="true" />
                    То — по порядку
                  </h3>
                  <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                    <SortableContext items={enabledOrder} strategy={verticalListSortingStrategy}>
                      {[...enabledOrder, ...ORDERABLE.filter((a) => !enabledOrder.includes(a))].map(
                        (action) => {
                          const on = draft.actions.includes(action);
                          const firstHost = enabledOrder.find(
                            (a) => a === 'hide_host' || a === 'rename_host',
                          );
                          return (
                            <StepCard
                              key={action}
                              action={action}
                              on={on}
                              index={on ? enabledOrder.indexOf(action) + 1 : null}
                              sortable={on && enabledOrder.length > 1}
                              onToggle={(v) => toggleStep(action, v)}
                            >
                              {action === 'check_tcp' &&
                                monitoring.data &&
                                (monitoring.data.checkHostEnabled ? (
                                  <Note>
                                    Порт {monitoring.data.checkHostPort} из «Мониторинга нод» и порт ноды.
                                    Если данных мало, в итоге будет «недостаточно данных».
                                  </Note>
                                ) : (
                                  <Note tone="warn">
                                    TCP-проверки выключены в «Мониторинге нод» — шаг не выполнится.
                                  </Note>
                                ))}
                              {action === 'rename_host' && (
                                <>
                                  <Segmented<Scenario['renameMode']>
                                    label="Как изменить имя Host"
                                    value={draft.renameMode}
                                    onChange={(renameMode) => change({ renameMode })}
                                    items={[
                                      { key: 'replace', label: 'Заменить имя' },
                                      { key: 'prepend', label: 'В начало, после флага' },
                                      { key: 'append', label: 'В конец' },
                                    ]}
                                  />
                                  <label htmlFor="scenario-rename" className="block">
                                    <span className="mb-1.5 block text-[12.5px] font-medium text-text-2">
                                      Текст или эмодзи
                                    </span>
                                    <Input
                                      id="scenario-rename"
                                      className="h-10"
                                      placeholder="Например: 🔴 или временно недоступен"
                                      value={draft.renameText}
                                      onChange={(e) => change({ renameText: e.target.value })}
                                    />
                                    <span className="mt-1.5 block text-[12px] text-text-3">
                                      Пробел до и после текста добавляется сам — как в предпросмотре справа.
                                    </span>
                                  </label>
                                </>
                              )}
                              {action === firstHost && hostRight === 'denied' && (
                                <Note tone="warn">
                                  У API-ключа нет права «Изменение Host» — Remnawave отказала. Права ключа не
                                  меняются: выпустите в Remnawave новый ключ с правами на чтение и изменение
                                  Host и замените его в «Ноды» → «Настроить подключение».
                                </Note>
                              )}
                              {action === firstHost && hostRight === 'unknown' && (
                                <Note>
                                  Право ключа «Изменение Host» проверится при первом срабатывании: Remnawave
                                  не сообщает права заранее. Итог будет в событии ноды и в Telegram.
                                </Note>
                              )}
                              {action === firstHost && (
                                <label
                                  htmlFor="scenario-restore"
                                  className="flex cursor-pointer items-start gap-2.5 text-[13px]"
                                >
                                  <Checkbox
                                    id="scenario-restore"
                                    className="mt-0.5"
                                    checked={draft.autoRestore}
                                    onCheckedChange={(v) => change({ autoRestore: v === true })}
                                  />
                                  <span>
                                    Вернуть Host как был, когда нода восстановится
                                    <span className="mt-0.5 block text-[12px] text-text-3">
                                      Только для изменений этого сценария, если Host с тех пор не меняли.
                                    </span>
                                  </span>
                                </label>
                              )}
                            </StepCard>
                          );
                        },
                      )}
                    </SortableContext>
                  </DndContext>
                  <StepCard
                    action="notify"
                    on={draft.actions.includes('notify')}
                    index={draft.actions.includes('notify') ? enabledOrder.length + 1 : null}
                    sortable={false}
                    onToggle={(v) => toggleStep('notify', v)}
                  >
                    <p className="flex flex-wrap items-center gap-2 text-[12.5px] text-text-2">
                      <Pill tone={telegramState.tone}>
                        {telegramState.tone === 'ok' ? 'Подключён' : 'Внимание'}
                      </Pill>
                      {telegramState.text}
                      <Link to="/settings/notifications" className="text-brand hover:underline">
                        Настройки уведомлений
                      </Link>
                    </p>
                  </StepCard>
                </section>
                <label
                  htmlFor="scenario-cooldown"
                  className="flex flex-wrap items-center gap-2 text-[12.5px] text-text-2"
                >
                  Пауза между повторными сбоями
                  <Input
                    id="scenario-cooldown"
                    inputMode="numeric"
                    aria-invalid={!timeValid(cooldownInput, 5, 1440)}
                    className="h-10 w-[76px] text-right"
                    value={cooldownInput}
                    onChange={(e) => {
                      setCooldownInput(e.target.value);
                      if (timeValid(e.target.value, 5, 1440))
                        change({ cooldownMinutes: Number(e.target.value) });
                    }}
                  />
                  мин
                  <span className="basis-full text-[12px] text-text-3">
                    Сработал на ноде — следующий раз на ней не раньше чем через это время, даже если сбой
                    повторится.
                  </span>
                </label>
              </div>

              <aside className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-0 lg:self-start">
                <section className="rounded-2xl border border-border bg-bg-2 px-4 py-3.5">
                  <h3 className={cn(kicker, 'mb-2')}>Как это прочитать</h3>
                  <p className="text-[13px] leading-relaxed">
                    Если{' '}
                    <b>
                      {conditions
                        .map((c) => lower(scenarioLabels[c]))
                        .join(draft.conditionMode === 'all' ? ' и ' : ' или ')}
                    </b>{' '}
                    держится <b>{draft.holdMinutes} мин</b>{' '}
                    {readScope ? (
                      <>
                        на <b>{readScope}</b>
                      </>
                    ) : (
                      <b className="text-warn">(ноды не выбраны)</b>
                    )}
                    , то:{' '}
                    {steps.length ? (
                      steps.map((s, i) => `${i + 1}) ${s}`).join(', ')
                    ) : (
                      <span className="text-warn">шаги не выбраны</span>
                    )}
                    . Повтор не раньше чем через {draft.cooldownMinutes} мин.
                  </p>
                </section>
                {hostStep && (
                  <section className="rounded-2xl border border-border bg-bg-2 px-4 py-3.5">
                    <h3 className={cn(kicker, 'mb-2')}>
                      Затронутые Host{hosts.data ? ` · ${targets.length}` : ''}
                    </h3>
                    {hosts.isPending ? (
                      <RowsSkeleton rows={2} label="Загрузка Host" />
                    ) : hosts.isError ? (
                      <p role="alert" className="text-[12.5px] text-crit">
                        {apiErrorMessage(hosts.error)}
                      </p>
                    ) : !targets.length ? (
                      <p className="text-[12.5px] text-text-3">У выбранных нод нет связанных Host.</p>
                    ) : (
                      <>
                        <p className="mb-1.5 text-[12.5px] text-text-2">
                          <b className="font-semibold text-foreground">{willChange.length}</b>{' '}
                          {plural(willChange.length, 'будет изменён', 'будут изменены', 'будут изменены')}
                          {targets.length > willChange.length && (
                            <>
                              ,{' '}
                              <b className="font-semibold text-foreground">
                                {targets.length - willChange.length}
                              </b>{' '}
                              {plural(
                                targets.length - willChange.length,
                                'пропускается',
                                'пропускаются',
                                'пропускаются',
                              )}{' '}
                              — у них нет своей ноды
                            </>
                          )}
                          .
                        </p>
                        <div className="flex flex-col">
                          {(showAllHosts ? targets : targets.slice(0, 3)).map((h) => (
                            <div
                              key={h.uuid}
                              className="border-t border-border py-2.5 text-[12.5px] first:border-t-0"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <span className="min-w-0 font-medium break-words">{h.name}</span>
                                {h.nodes.length !== 1 ? (
                                  <Pill tone="warn">Пропускается</Pill>
                                ) : draft.actions.includes('hide_host') &&
                                  h.disabled &&
                                  !draft.actions.includes('rename_host') ? (
                                  <Pill>Уже выключен</Pill>
                                ) : (
                                  <Pill tone="ok">Будет изменён</Pill>
                                )}
                              </div>
                              <p className="mt-0.5 font-mono text-[11px] break-all text-text-3">
                                {h.address}
                                {h.port ? `:${h.port}` : ''}
                              </p>
                              {draft.actions.includes('rename_host') &&
                                draft.renameText &&
                                h.nodes.length === 1 && (
                                  <RenamePreview
                                    name={h.name}
                                    mode={draft.renameMode}
                                    text={draft.renameText}
                                  />
                                )}
                              <p className="mt-1 text-[11.5px] text-text-3">
                                {h.nodeNames.join(', ') || 'Нода не назначена'} ·{' '}
                                {h.automaticNodes.length
                                  ? h.bindingSource
                                  : draft.hostBindings.some((b) => b.hostUuid === h.uuid)
                                    ? 'ручная привязка в этом сценарии'
                                    : h.nodes.length > 1
                                      ? 'общий для нескольких нод'
                                      : 'связь не определена'}
                              </p>
                              {!h.automaticNodes.length && (
                                <Select
                                  value={
                                    draft.hostBindings.find((b) => b.hostUuid === h.uuid)?.nodeUuid ?? 'auto'
                                  }
                                  onValueChange={(value) =>
                                    change({
                                      hostBindings: [
                                        ...draft.hostBindings.filter((b) => b.hostUuid !== h.uuid),
                                        ...(value === 'auto' ? [] : [{ hostUuid: h.uuid, nodeUuid: value }]),
                                      ],
                                    })
                                  }
                                >
                                  <SelectTrigger
                                    aria-label={`Нода для Host ${h.name}`}
                                    className="mt-2 h-9 text-[12.5px]"
                                  >
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="auto">Не изменять этот Host</SelectItem>
                                    {allowedNodes.map((n) => (
                                      <SelectItem key={n.uuid} value={n.uuid}>
                                        {n.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              )}
                              {h.restoration && (
                                <p className="mt-1 text-[11.5px] text-warn">{h.restoration}</p>
                              )}
                            </div>
                          ))}
                        </div>
                        {targets.length > 3 && (
                          <button
                            type="button"
                            onClick={() => setShowAllHosts((v) => !v)}
                            className="mt-2 h-9 w-full cursor-pointer rounded-[10px] border border-border bg-surface text-[12.5px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-foreground"
                          >
                            {showAllHosts ? 'Свернуть' : `Показать все ${targets.length}`}
                          </button>
                        )}
                      </>
                    )}
                  </section>
                )}
                {original && summary && (
                  <section className="rounded-2xl border border-border bg-bg-2 px-4 py-3.5">
                    <h3 className={cn(kicker, 'mb-2.5')}>Срабатывания</h3>
                    <RunStrip strip={summary.strip} size="sm" timeZone={timeZone ?? 'UTC'} />
                    <p className="mt-2 text-[12.5px] text-text-2">
                      <b className="font-semibold text-foreground">{summary.week}</b> за 7 дней
                      {summary.weekWarn + summary.weekCrit > 0 && (
                        <span className="text-warn">
                          , {summary.weekWarn + summary.weekCrit} с замечанием
                        </span>
                      )}
                      .
                    </p>
                    <button
                      type="button"
                      onClick={() => setTab('runs')}
                      className="mt-1.5 inline-flex cursor-pointer items-center gap-1 text-[12.5px] font-medium text-brand hover:underline"
                    >
                      Открыть «Срабатывания»
                      <ChevronRightIcon className="size-3.5" aria-hidden="true" />
                    </button>
                  </section>
                )}
              </aside>
            </div>
          )}
        </div>

        <footer className="flex flex-none flex-wrap items-center gap-3 border-t border-border bg-bg-2 px-[22px] py-3.5 max-md:px-4">
          <span
            className="flex min-w-0 flex-1 items-center gap-2 text-[12.5px] max-md:basis-full"
            aria-live="polite"
          >
            {error ? (
              <span className="text-crit">{error}</span>
            ) : blocker ? (
              <span className="text-warn">{blocker}</span>
            ) : changes.length ? (
              <>
                <i className="size-2 flex-none rounded-full bg-warn" aria-hidden="true" />
                <span className="min-w-0 truncate text-text-2">
                  Есть несохранённые изменения: {changes.slice(0, 3).join(', ')}
                  {changes.length > 3 ? ` и ещё ${changes.length - 3}` : ''}
                </span>
              </>
            ) : original ? (
              <span className="flex items-center gap-2 text-text-3">
                <CircleCheckIcon className="size-4" aria-hidden="true" />
                Изменений нет
              </span>
            ) : (
              <span className="text-text-3">
                Новый сценарий начнёт работать после сохранения, если он включён.
              </span>
            )}
          </span>
          {onDelete && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setDeleting(true)}
              className="inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-[10px] border border-border bg-surface px-3.5 text-[13px] font-medium text-text-2 transition-colors hover:border-crit/50 hover:text-crit disabled:opacity-50"
            >
              <Trash2Icon className="size-4" aria-hidden="true" />
              Удалить
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={close}
            className="inline-flex h-10 cursor-pointer items-center rounded-[10px] border border-border bg-surface px-4 text-[13px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            type="button"
            disabled={busy || Boolean(blocker) || (Boolean(original) && !changes.length)}
            onClick={onSave}
            className="inline-flex h-10 cursor-pointer items-center justify-center rounded-[10px] bg-cta px-4 text-[13px] font-semibold text-cta-foreground transition-colors hover:bg-(--ns-cta-hover) disabled:cursor-default disabled:opacity-50 max-md:flex-1"
          >
            {busy ? 'Сохраняю…' : 'Сохранить'}
          </button>
        </footer>
      </DialogContent>
      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        kind="warn"
        title="Закрыть без сохранения?"
        description={`Несохранённые изменения пропадут: ${changes.join(', ')}.`}
        yesLabel="Закрыть"
        onConfirm={() => {
          setLeaving(false);
          onClose();
        }}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        kind="crit"
        title="Удалить сценарий?"
        description={`Сценарий «${draft.name}» перестанет срабатывать. Уже сделанные изменения Host он не вернёт.`}
        yesLabel="Да, удалить"
        loading={busy}
        onConfirm={() => {
          setDeleting(false);
          onDelete?.();
        }}
      />
    </Dialog>
  );
}
