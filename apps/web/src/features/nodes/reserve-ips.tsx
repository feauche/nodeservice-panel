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
  isReserveIp,
  type NodeReserve,
  nodeReserveSchema,
  type RemnawaveNode,
  type ReserveIp,
  type ReserveSwitchResult,
  reserveSwitchByLabels,
  reserveSwitchPlanSchema,
  reserveSwitchResultSchema,
} from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftRightIcon,
  CircleCheckIcon,
  CircleXIcon,
  GripVerticalIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { DialogPrimaryButton, DialogSecondaryButton } from '@/components/dialog-actions';
import { DialogHead, dialogBox, dialogFoot, footButton } from '@/components/dialog-parts';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { dayLabel, hhmm } from '@/features/incidents/incident-format';
import { Toggle } from '@/features/settings/settings-ui';
import { api, apiErrorMessage, request } from '@/lib/api';
import { toast } from '@/lib/notify';
import { plural } from '@/lib/plural';
import { cn } from '@/lib/utils';

const when = (iso: string) => `${dayLabel(iso, Date.now()).toLowerCase()} в ${hhmm(iso)}`;
const enc = encodeURIComponent;
/** Кнопки строки — одной высоты; иконковая — квадратная той же высоты. */
const ROW_BTN =
  'inline-flex h-8 cursor-pointer max-sm:min-w-0 max-sm:flex-1 max-sm:px-2 items-center justify-center gap-1.5 rounded-[9px] border border-border bg-surface px-3 text-[12.5px] font-medium whitespace-nowrap text-text-2 transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand disabled:cursor-default disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:flex-none';
const ICON_BTN =
  'grid size-8 flex-none cursor-pointer place-items-center rounded-[9px] border border-border bg-surface text-text-3 transition-colors hover:border-crit/50 hover:bg-crit-soft hover:text-crit focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50 [&_svg]:size-3.5';

function useReserve(uuid: string) {
  const client = useQueryClient();
  const key = ['nodes', 'reserve', uuid];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.get(`/nodes/${uuid}/reserve`, nodeReserveSchema, signal),
  });
  const set = (data: NodeReserve) => client.setQueryData(key, data);
  return { query, set, key };
}

/** Состояние адреса одной точкой и словом: рабочий, отвечает, не отвечает, не проверен. */
function Status({ item }: { item: ReserveIp }) {
  const c = item.check;
  const [tone, word] = !c
    ? (['text-text-3', 'Не проверен'] as const)
    : c.ok
      ? (['text-ok', 'Отвечает'] as const)
      : c.verdict === 'russia_partial' || c.verdict === 'unknown'
        ? (['text-warn', c.verdict === 'unknown' ? 'Нет ответа' : 'Частично'] as const)
        : (['text-crit', 'Не отвечает'] as const);
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-[12px] font-semibold whitespace-nowrap', tone)}
    >
      <span className="size-[7px] rounded-full bg-current" aria-hidden="true" />
      {word}
    </span>
  );
}

function Row({
  item,
  sortable,
  busy,
  disabled,
  onCheck,
  onRemove,
  onSwitch,
}: {
  item: ReserveIp;
  sortable: boolean;
  /** Что идёт у этой строки — крутилка на своей кнопке. */
  busy: 'check' | 'remove' | null;
  /** Идёт что-то другое — кнопки строки ждут. */
  disabled: boolean;
  onCheck: () => void;
  onRemove: () => void;
  onSwitch: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.ip, disabled: !sortable });
  const sub = [
    item.wasPrimaryUntil ? `Был рабочим до ${when(item.wasPrimaryUntil)}` : '',
    item.check ? `${item.check.text} · ${when(item.check.at)}` : 'Не проверен',
  ].filter(Boolean);
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'flex items-center gap-3 border-t border-border bg-surface px-3.5 py-2.5 first:border-t-0 max-sm:flex-wrap',
        isDragging && 'relative z-10 shadow-float',
      )}
    >
      {sortable ? (
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Переставить адрес ${item.ip}`}
          className="grid flex-none cursor-grab touch-none place-items-center rounded text-text-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand active:cursor-grabbing"
        >
          <GripVerticalIcon className="size-4" aria-hidden="true" />
        </button>
      ) : (
        <span className="w-4 flex-none" />
      )}
      <span className="min-w-0 flex-1">
        <b className="block font-mono text-[13px] font-semibold break-all">{item.ip}</b>
        <small className="mt-0.5 block text-[12px] leading-snug text-text-3">{sub.join(' · ')}</small>
      </span>
      <Status item={item} />
      <span className="flex flex-none items-center gap-1.5 max-sm:ml-7 max-sm:min-w-0 max-sm:flex-[1_1_calc(100%-1.75rem)]">
        {item.check?.ok ? (
          <button type="button" className={ROW_BTN} disabled={disabled} onClick={onSwitch}>
            <ArrowLeftRightIcon aria-hidden="true" />
            Переключить
          </button>
        ) : null}
        <button type="button" className={ROW_BTN} disabled={disabled} onClick={onCheck}>
          {busy === 'check' ? (
            <Loader2Icon className="animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCwIcon aria-hidden="true" />
          )}
          Проверить
        </button>
        <button
          type="button"
          className={ICON_BTN}
          disabled={disabled}
          aria-label={`Убрать адрес ${item.ip}`}
          title="Убрать из запасных"
          onClick={onRemove}
        >
          {busy === 'remove' ? (
            <Loader2Icon className="animate-spin" aria-hidden="true" />
          ) : (
            <Trash2Icon aria-hidden="true" />
          )}
        </button>
      </span>
    </li>
  );
}

/**
 * «Запасные IP» во вкладке «Подключение» окна ноды (витрина reference-pack-2026-10, раздел 4 — A): рабочий адрес,
 * запасные с итогом Check-Host, «Добавить и проверить», порядок перетаскиванием, «Переключить» с планом и «Переключать
 * само» (выключено по умолчанию).
 */
export function ReserveIpsCard({ node }: { node: RemnawaveNode }) {
  const { query, set } = useReserve(node.uuid);
  const [ip, setIp] = useState('');
  const [busy, setBusy] = useState<{ ip: string; what: 'check' | 'remove' } | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const add = useMutation({
    mutationFn: (value: string) => api.post(`/nodes/${node.uuid}/reserve`, { ip: value }, nodeReserveSchema),
    onSuccess: (data, value) => {
      set(data);
      setIp('');
      const check = data.items.find((i) => i.ip === value.trim())?.check;
      if (check && !check.ok) toast.warning(`${value.trim()}: ${check.text}`);
    },
  });
  const auto = useMutation({
    mutationFn: (value: boolean) =>
      api.put(`/nodes/${node.uuid}/reserve/auto`, { auto: value }, nodeReserveSchema),
    onSuccess: set,
  });
  const data = query.data;
  const items = data?.items ?? [];
  async function act(item: ReserveIp, what: 'check' | 'remove') {
    setBusy({ ip: item.ip, what });
    try {
      set(
        what === 'check'
          ? await api.post(`/nodes/${node.uuid}/reserve/${enc(item.ip)}/check`, {}, nodeReserveSchema)
          : await request(`/nodes/${node.uuid}/reserve/${enc(item.ip)}`, {
              method: 'DELETE',
              schema: nodeReserveSchema,
            }),
      );
    } catch (e) {
      toast.error(apiErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  async function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id || !data) return;
    const from = items.findIndex((i) => i.ip === active.id),
      to = items.findIndex((i) => i.ip === over.id);
    const next = arrayMove(items, from, to);
    set({ ...data, items: next });
    try {
      set(
        await api.put(`/nodes/${node.uuid}/reserve/order`, { ips: next.map((i) => i.ip) }, nodeReserveSchema),
      );
    } catch (e) {
      toast.error(apiErrorMessage(e));
      void query.refetch();
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (isReserveIp(ip.trim())) add.mutate(ip.trim());
  }
  const valid = isReserveIp(ip.trim());
  return (
    <>
      <section
        aria-label="Запасные IP"
        className="flex flex-col gap-3 rounded-[14px] border border-border bg-surface px-4 py-3.5"
      >
        <div className="flex items-center gap-2">
          <h3 className="m-0 font-heading text-[14px] font-semibold">Запасные IP</h3>
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] font-semibold text-text-3">
            Необязательно
          </span>
          {data && (
            <span className="ml-auto text-[12px] text-text-3">
              {items.length ? `${items.length} ${plural(items.length, 'адрес', 'адреса', 'адресов')}` : 'Нет'}
            </span>
          )}
        </div>
        {query.isPending ? (
          <div aria-busy="true" className="flex flex-col gap-2">
            <Skeleton className="h-12 rounded-[12px]" />
            <Skeleton className="h-12 rounded-[12px]" />
          </div>
        ) : query.isError ? (
          <p role="alert" className="m-0 text-[12.5px] text-crit">
            {apiErrorMessage(query.error)}
          </p>
        ) : (
          <>
            <ul className="m-0 flex list-none flex-col overflow-hidden rounded-[12px] border border-border p-0">
              <li className="flex items-center gap-3 bg-ok/[0.06] px-3.5 py-2.5">
                <span className="w-4 flex-none" />
                <span className="min-w-0 flex-1">
                  <b className="block font-mono text-[13px] font-semibold break-all">{node.address}</b>
                  <small className="mt-0.5 block text-[12px] text-text-3">
                    Рабочий адрес · сейчас у ноды в Remnawave
                    {data?.lastSwitch?.to === node.address &&
                      ` · с ${when(data.lastSwitch.at)}, ${reserveSwitchByLabels[data.lastSwitch.by]}`}
                  </small>
                </span>
                <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-ok">
                  <span className="size-[7px] rounded-full bg-current" aria-hidden="true" />
                  Рабочий
                </span>
              </li>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={(e) => void onDragEnd(e)}
              >
                <SortableContext items={items.map((i) => i.ip)} strategy={verticalListSortingStrategy}>
                  {items.map((item) => (
                    <Row
                      key={item.ip}
                      item={item}
                      sortable={items.length > 1}
                      busy={busy?.ip === item.ip ? busy.what : null}
                      disabled={busy !== null || add.isPending}
                      onCheck={() => void act(item, 'check')}
                      onRemove={() => void act(item, 'remove')}
                      onSwitch={() => setTarget(item.ip)}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            </ul>
            <form onSubmit={submit} className="flex gap-2 max-sm:flex-col">
              <Input
                aria-label="Запасной IP-адрес"
                value={ip}
                onChange={(e) => setIp(e.target.value)}
                placeholder="IP-адрес запасного адреса этого сервера"
                autoComplete="off"
                spellCheck={false}
                className="h-10 min-w-0 flex-1 rounded-[10px] bg-surface-2 font-mono max-sm:flex-none"
              />
              <DialogPrimaryButton
                type="submit"
                disabled={!valid || add.isPending}
                className="h-10 w-[200px] flex-none rounded-[10px] max-sm:order-last max-sm:w-full sm:flex-none sm:max-w-none"
              >
                {add.isPending ? (
                  <Loader2Icon className="animate-spin" aria-hidden="true" />
                ) : (
                  <PlusIcon aria-hidden="true" />
                )}
                {add.isPending ? 'Проверяю…' : 'Добавить и проверить'}
              </DialogPrimaryButton>
            </form>
            {add.error && (
              <p role="alert" className="m-0 text-[12.5px] text-crit">
                {apiErrorMessage(add.error)}
              </p>
            )}
            <p className="m-0 text-[12px] leading-relaxed text-text-3">
              Проверка — Check-Host: открыт ли порт ноды на этом адресе из России и других стран. Нода при
              этом никуда не переводится, клиенты ничего не замечают. Порядок — перетаскиванием: «Переключать
              само» и сценарий берут первый, который отвечает.
            </p>
          </>
        )}
      </section>
      {data && (
        <section className="flex items-start gap-3 rounded-[14px] border border-border bg-surface px-4 py-3.5">
          <span className="min-w-0 flex-1">
            <b className="block text-[13.5px] font-semibold">Переключать само</b>
            <small className="mt-0.5 block text-[12px] leading-relaxed text-text-3">
              Необязательно, по умолчанию выключено. Когда Check-Host из России порт ноды не видит, а из
              других стран видит, панель проверит запасные по порядку и переключит на первый, который
              отвечает. Не чаще раза в сутки — чтобы не сжечь все адреса подряд. Ни один не отвечает — ничего
              не трогает и пишет об этом в событие ноды.
            </small>
          </span>
          <Toggle
            id={`reserve-auto-${node.uuid}`}
            aria-label="Переключать само"
            checked={data.auto}
            disabled={auto.isPending || !items.length}
            onChange={(v) => auto.mutate(v)}
          />
        </section>
      )}
      {target && <SwitchDialog node={node} to={target} onClose={() => setTarget(null)} onDone={set} />}
    </>
  );
}

/** «Переключить»: что поменяется (до), что поменялось (после) — по шагам. */
function SwitchDialog({
  node,
  to,
  onClose,
  onDone,
}: {
  node: RemnawaveNode;
  to: string;
  onClose: () => void;
  onDone: (reserve: NodeReserve) => void;
}) {
  const client = useQueryClient();
  const plan = useQuery({
    queryKey: ['nodes', 'reserve-plan', node.uuid, to],
    queryFn: ({ signal }) =>
      api.get(`/nodes/${node.uuid}/reserve/plan?to=${enc(to)}`, reserveSwitchPlanSchema, signal),
    staleTime: 0,
    retry: false,
  });
  const [result, setResult] = useState<ReserveSwitchResult | null>(null);
  const go = useMutation({
    mutationFn: () => api.post(`/nodes/${node.uuid}/reserve/switch`, { to }, reserveSwitchResultSchema),
    onSuccess: (r) => {
      setResult(r);
      onDone(r.reserve);
      void client.invalidateQueries({ queryKey: ['nodes'] });
      void client.invalidateQueries({ queryKey: ['remnawave'] });
      const failed = r.plan.steps.filter((s) => s.ok === false).length;
      if (!failed) toast.success(`«${node.name}» переключена на ${to}`);
    },
  });
  const steps = result?.plan.steps ?? plan.data?.steps ?? [];
  const blocked = plan.data?.blocked ?? null;
  return (
    <Dialog open onOpenChange={(o) => !o && !go.isPending && onClose()}>
      <DialogContent showCloseButton={false} className={cn(dialogBox, 'sm:max-w-[600px]')}>
        <DialogHead
          title={result ? `«${node.name}» — итог переключения` : `Переключить «${node.name}» на ${to}?`}
          description="Клиенты с доменами переедут на новый адрес, когда обновится DNS (обычно 1–5 минут)."
        />
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-5 max-sm:px-4">
          {plan.isPending ? (
            <div aria-busy="true" className="flex flex-col gap-2">
              <Skeleton className="h-12 rounded-[12px]" />
              <Skeleton className="h-12 rounded-[12px]" />
            </div>
          ) : plan.isError ? (
            <p role="alert" className="m-0 text-[12.5px] text-crit">
              {apiErrorMessage(plan.error)}
            </p>
          ) : blocked ? (
            <p
              role="alert"
              className="m-0 rounded-[10px] border border-warn/35 bg-warn/[0.06] px-3 py-2.5 text-[12.5px] text-text-2"
            >
              {blocked}
            </p>
          ) : (
            <ul
              aria-label="Что поменяется"
              className="m-0 flex list-none flex-col overflow-hidden rounded-[12px] border border-border p-0"
            >
              {steps.map((s) => (
                <li
                  key={`${s.kind}:${s.title}:${s.detail}`}
                  className="flex items-start gap-3 border-t border-border px-3.5 py-2.5 first:border-t-0"
                >
                  <span className="min-w-0 flex-1">
                    <b className="block text-[13px] font-semibold">{s.title}</b>
                    <small className="mt-0.5 block font-mono text-[12px] break-all text-text-3">
                      {s.detail}
                    </small>
                    {s.error && (
                      <small className="mt-1 block text-[12px] leading-snug text-crit">{s.error}</small>
                    )}
                  </span>
                  {s.ok === null ? (
                    <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold whitespace-nowrap text-text-3">
                      {go.isPending ? (
                        <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
                      ) : null}
                      {go.isPending ? 'Меняю…' : 'Поменяется'}
                    </span>
                  ) : s.ok ? (
                    <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold whitespace-nowrap text-ok">
                      <CircleCheckIcon className="size-3.5" aria-hidden="true" />
                      Готово
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold whitespace-nowrap text-crit">
                      <CircleXIcon className="size-3.5" aria-hidden="true" />
                      Не вышло
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {plan.data && !blocked && !steps.some((s) => s.kind === 'dns') && !plan.data.dnsNote && (
            <p className="m-0 text-[12px] leading-snug text-text-3">
              Записей DNS со старым IP в подключённых DNS-интеграциях нет.
            </p>
          )}
          {plan.data?.dnsNote && (
            <p className="m-0 text-[12px] leading-snug text-warn">{plan.data.dnsNote}</p>
          )}
          {go.error && (
            <p
              role="alert"
              className="m-0 rounded-[10px] border border-crit/30 bg-crit-soft px-3 py-2 text-[12.5px] text-crit"
            >
              {apiErrorMessage(go.error)}
            </p>
          )}
          {!blocked && plan.data && (
            <p className="m-0 text-[12px] leading-snug text-text-3">
              {result
                ? `Прежний адрес ${result.plan.from} теперь в списке запасных с пометкой «Был рабочим до …». Всё записано в «Журнал» и в события ноды.`
                : `Прежний адрес ${plan.data.from} останется в списке запасных с пометкой «Был рабочим до …». Всё записывается в «Журнал» и в события ноды.`}
            </p>
          )}
        </div>
        <div className={dialogFoot}>
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3 max-sm:hidden">
            {result
              ? 'Переключение закончено.'
              : 'Если Remnawave не сменит адрес ноды, остальное не тронется.'}
          </p>
          <div className="flex gap-2 max-sm:flex-col">
            {result ? (
              <DialogPrimaryButton onClick={onClose} className={footButton}>
                Закрыть
              </DialogPrimaryButton>
            ) : (
              <>
                <DialogSecondaryButton disabled={go.isPending} onClick={onClose} className={footButton}>
                  Отмена
                </DialogSecondaryButton>
                <DialogPrimaryButton
                  disabled={go.isPending || !plan.data || Boolean(blocked)}
                  onClick={() => go.mutate()}
                  className={footButton}
                >
                  {go.isPending && <Loader2Icon className="animate-spin" aria-hidden="true" />}
                  Переключить
                </DialogPrimaryButton>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
