import {
  BILLING_CURRENCY_SIGN,
  BILLING_KIND_HINTS,
  BILLING_KIND_LABELS,
  BILLING_KINDS,
  BILLING_PERIOD_PRESETS,
  type BillingCurrency,
  type BillingItem,
  type BillingKind,
  type BillingPeriodUnit,
  type BillingSummary,
  billingItemUpsertSchema,
} from '@nodeservice/shared';
import { Loader2Icon, ServerIcon, XIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';

import { DialogPrimaryButton, DialogSecondaryButton } from '@/components/dialog-actions';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ProviderSelect } from '@/features/providers/provider-select';
import { useServers } from '@/features/servers/servers-api';
import { Toggle } from '@/features/settings/settings-ui';
import { apiErrorMessage, isApiError } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { useSaveBillingItem } from './billing-api';
import { KIND_ICON } from './billing-card';
import { fromLocalInput, rub, toLocalInput } from './billing-format';

const LBL = 'mb-1.5 flex items-baseline gap-1.5 text-[12px] font-medium text-text-2';
const HINT = 'mt-1.5 text-[11.5px] leading-snug text-text-3';
const CHIP =
  'h-8 cursor-pointer rounded-[9px] border px-3 text-[12.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-brand';
const chip = (on: boolean) =>
  cn(
    CHIP,
    on
      ? 'border-brand bg-brand-soft text-foreground'
      : 'border-border bg-surface-2 text-text-2 hover:text-foreground',
  );

const Req = () => <span className="text-crit">*</span>;
const Opt = () => <span className="text-[11px] font-normal text-text-3">необязательно</span>;

function Label({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return htmlFor ? (
    <label htmlFor={htmlFor} className={LBL}>
      {children}
    </label>
  ) : (
    <span className={LBL}>{children}</span>
  );
}

const REMIND = [
  { v: null, label: 'Как обычно' },
  { v: 1, label: 'За 1 день' },
  { v: 7, label: 'За 7 дней' },
  { v: 14, label: 'За 14 дней' },
] as const;
const UNITS: ReadonlyArray<{ key: Exclude<BillingPeriodUnit, 'once'>; label: string }> = [
  { key: 'day', label: 'дней' },
  { key: 'week', label: 'недель' },
  { key: 'month', label: 'месяцев' },
  { key: 'year', label: 'лет' },
];

const SERVERS_LABEL: Record<BillingKind, string> = {
  server: 'Сервер',
  rent: 'Сервер',
  domain: 'Где используется',
  cert: 'Где развёрнут',
  other: 'Серверы',
};
const SERVERS_HINT: Record<BillingKind, string> = {
  server: 'С сервером оплата появится в его карточке, а Джарвис учтёт её, если сервер упадёт.',
  rent: 'Если аренда даёт конкретный сервер — укажите его: при падении Джарвис проверит оплату.',
  domain: 'Серверы, на которые смотрит домен. Для справки.',
  cert: 'Серверы, где лежит сертификат (например, через certwarden). Джарвис подскажет, где продлевать.',
  other: 'Если оплата относится к серверам — отметьте их.',
};

/**
 * Добавить или изменить оплату (витрина, 5A): одно окно сверху вниз — что, кто, где, сколько, как часто,
 * до какого числа. Поля выровнены по сетке в две колонки, на телефоне — одна.
 */
export function ItemDialog({
  open,
  onOpenChange,
  item = null,
  rates,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  item?: BillingItem | null;
  rates: BillingSummary['rates'] | undefined;
}) {
  const save = useSaveBillingItem();
  const servers = useServers();
  const [kind, setKind] = useState<BillingKind>('server');
  const [title, setTitle] = useState('');
  const [providerId, setProviderId] = useState<string | null>(null);
  const [serverIds, setServerIds] = useState<string[]>([]);
  const [domain, setDomain] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<BillingCurrency>('RUB');
  const [unit, setUnit] = useState<BillingPeriodUnit>('month');
  const [count, setCount] = useState(1);
  const [custom, setCustom] = useState(false);
  const [paidUntil, setPaidUntil] = useState('');
  const [remind, setRemind] = useState<number | null>(null);
  const [autoCharge, setAutoCharge] = useState(false);
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  // biome-ignore lint/correctness/useExhaustiveDependencies: форма заполняется при открытии
  useEffect(() => {
    if (!open) return;
    setKind(item?.kind ?? 'server');
    setTitle(item?.title ?? '');
    setProviderId(item?.providerId ?? null);
    setServerIds(item?.serverIds ?? []);
    setDomain(item?.domain ?? '');
    setAmount(item ? String(item.amountMinor / 100) : '');
    setCurrency(item?.currency ?? 'RUB');
    setUnit(item?.periodUnit ?? 'month');
    setCount(item?.periodCount ?? 1);
    setCustom(
      item
        ? !BILLING_PERIOD_PRESETS.some((p) => p.unit === item.periodUnit && p.count === item.periodCount)
        : false,
    );
    setPaidUntil(toLocalInput(item?.paidUntil ?? new Date(Date.now() + 30 * 86_400_000).toISOString()));
    setRemind(item?.remindDays ?? null);
    setAutoCharge(item?.autoCharge ?? false);
    setNote(item?.note ?? '');
    setErrors({});
  }, [open, item?.id]);

  const list = servers.data?.items ?? [];
  // У «Сервера» и «Аренды» — один сервер, у сертификата, домена и прочего — несколько.
  const single = kind === 'server' || kind === 'rent';
  const pickServer = (id: string | null) => {
    if (single) {
      setServerIds(id ? [id] : []);
      // Название и провайдер по серверу, если их ещё не задали.
      const s = list.find((x) => x.id === id);
      if (s && !title.trim()) setTitle(s.name);
      if (s?.providerId && !providerId) setProviderId(s.providerId);
      return;
    }
    if (id) setServerIds((cur) => (cur.includes(id) ? cur : [...cur, id]));
  };
  const serverOption = (s: (typeof list)[number]) => ({
    value: s.id,
    label: s.name,
    keywords: s.host,
    node: (
      <span className="flex min-w-0 items-center gap-2">
        <ServerIcon className="size-3.5 flex-none text-text-3" aria-hidden="true" />
        <span className="truncate">{s.name}</span>
        <span className="truncate font-mono text-[11.5px] text-text-3">{s.host}</span>
      </span>
    ),
  });
  const amountNum = Number(amount.replace(',', '.'));
  const rate = currency === 'RUB' ? null : (rates?.[currency] ?? null);
  const busy = save.isPending;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const body = {
      kind,
      title,
      providerId,
      serverIds: single ? serverIds.slice(0, 1) : serverIds,
      domain: kind === 'domain' || kind === 'cert' ? domain.trim() || null : null,
      amount: amount.trim() === '' ? Number.NaN : amountNum,
      currency,
      periodUnit: unit,
      periodCount: unit === 'once' ? 1 : count,
      paidUntil: fromLocalInput(paidUntil) ?? '',
      autoCharge: unit === 'once' ? false : autoCharge,
      remindDays: remind,
      note: note.trim() || null,
    };
    const parsed = billingItemUpsertSchema.safeParse(body);
    const errs: Record<string, string> = {};
    if (!parsed.success)
      for (const i of parsed.error.issues) {
        const k = String(i.path[0]);
        errs[k] ??=
          k === 'amount'
            ? 'Укажите сумму числом, например 9.50 или 0'
            : k === 'paidUntil'
              ? 'Укажите дату и время'
              : k === 'title'
                ? 'Укажите название'
                : i.message;
      }
    if (Object.keys(errs).length > 0 || !parsed.success) {
      setErrors(errs);
      return;
    }
    try {
      const saved = await save.mutateAsync({ id: item?.id ?? null, body: parsed.data });
      toast.success(item ? `«${saved.title}» сохранена.` : `Оплата «${saved.title}» добавлена.`);
      onOpenChange(false);
    } catch (err) {
      if (isApiError(err) && err.errors.length > 0) {
        const byPath: Record<string, string> = {};
        for (const er of err.errors) byPath[er.path] ??= er.message;
        setErrors(byPath);
      } else setErrors({ form: apiErrorMessage(err) });
    }
  };

  const presetOn = (p: { unit: BillingPeriodUnit; count: number }) =>
    !custom && p.unit === unit && p.count === count;
  const periodHint =
    unit === 'once'
      ? 'Разовая оплата: после срока карточку можно продлить на дни или убрать в архив.'
      : unit === 'month'
        ? '«Месяц» — то же число следующего месяца, как у большинства хостеров.'
        : unit === 'day' && count === 30
          ? '«30 дней» — ровно 30 суток от оплаты.'
          : 'Следующая оплата отсчитывается от даты «Оплачено до».';

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100vh-48px)] flex-col gap-0 overflow-hidden rounded-2xl border-border-2 bg-surface p-0 sm:max-w-[620px]"
      >
        <DialogHeader className="flex-none gap-1 border-b border-border px-6 py-4 text-left">
          <DialogTitle className="font-heading text-[18px]">
            {item ? 'Изменить оплату' : 'Новая оплата'}
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-text-3">
            Что оплачиваем, кому, сколько и до какого числа. Сумма в рублях считается по курсу ЦБ на день
            оплаты.
          </DialogDescription>
        </DialogHeader>
        <form
          id="billing-form"
          onSubmit={submit}
          noValidate
          className="flex min-h-0 flex-col gap-5 overflow-y-auto px-6 py-5"
        >
          <div>
            <Label>
              Что оплачиваем <Req />
            </Label>
            <div
              role="radiogroup"
              aria-label="Тип оплаты"
              className="grid grid-cols-5 gap-2 max-sm:grid-cols-3"
            >
              {BILLING_KINDS.map((k) => {
                const Icon = KIND_ICON[k];
                return (
                  // biome-ignore lint/a11y/useSemanticElements: см. группу выше
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={kind === k}
                    onClick={() => {
                      setKind(k);
                      if (k === 'server' || k === 'rent') setServerIds((c) => c.slice(0, 1));
                    }}
                    className={cn(
                      'flex h-[62px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-[11px] border text-[12.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-brand',
                      kind === k
                        ? 'border-brand bg-brand-soft text-foreground'
                        : 'border-border bg-surface-2 text-text-2 hover:text-foreground',
                    )}
                  >
                    <Icon className="size-[18px]" aria-hidden="true" />
                    {BILLING_KIND_LABELS[k]}
                  </button>
                );
              })}
            </div>
            <p className={HINT}>{BILLING_KIND_HINTS[kind]}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="bill-title">
                Название <Req />
              </Label>
              <Input
                id="bill-title"
                value={title}
                maxLength={120}
                disabled={busy}
                placeholder={
                  kind === 'domain' ? 'lumaxvds.org' : kind === 'cert' ? '*.example.com' : 'Финляндия #01'
                }
                aria-invalid={errors.title ? true : undefined}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setErrors((p) => ({ ...p, title: '' }));
                }}
                className="h-10 rounded-[10px] bg-surface-2"
              />
              {errors.title && <p className="mt-1.5 text-[12px] text-crit">{errors.title}</p>}
            </div>
            <div>
              <Label htmlFor="bill-provider">
                Провайдер <Opt />
              </Label>
              <ProviderSelect
                id="bill-provider"
                value={providerId}
                onChange={setProviderId}
                disabled={busy}
                className="h-10 w-full"
              />
            </div>
          </div>

          <div>
            <Label htmlFor="bill-server">
              {SERVERS_LABEL[kind]} <Opt />
            </Label>
            {list.length === 0 ? (
              <p className="rounded-[10px] border border-dashed border-border-2 px-3 py-2.5 text-[12.5px] text-text-3">
                Серверов в NodeService пока нет.
              </p>
            ) : single ? (
              <Combobox
                id="bill-server"
                ariaLabel={SERVERS_LABEL[kind]}
                value={serverIds[0] ?? null}
                onChange={pickServer}
                options={list.map(serverOption)}
                placeholder={<span className="text-text-3">Без сервера</span>}
                emptyLabel="Без сервера"
                searchPlaceholder="Найти сервер…"
                disabled={busy}
                className="h-10 w-full"
              />
            ) : (
              <div className="flex flex-col gap-2" data-testid="billing-servers">
                {serverIds.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {serverIds.map((id) => {
                      const srv = list.find((x) => x.id === id);
                      return (
                        <span
                          key={id}
                          className="inline-flex h-7 items-center gap-1.5 rounded-[8px] border border-border bg-surface-2 pr-1 pl-2.5 text-[12.5px]"
                        >
                          <ServerIcon className="size-3.5 text-text-3" aria-hidden="true" />
                          {srv?.name ?? 'сервер удалён'}
                          <button
                            type="button"
                            aria-label={`Убрать ${srv?.name ?? 'сервер'}`}
                            onClick={() => setServerIds((cur) => cur.filter((x) => x !== id))}
                            className="grid size-5 cursor-pointer place-items-center rounded-[6px] text-text-3 hover:bg-surface-3 hover:text-foreground"
                          >
                            <XIcon className="size-3.5" aria-hidden="true" />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}
                <Combobox
                  id="bill-server"
                  ariaLabel={`${SERVERS_LABEL[kind]}: добавить сервер`}
                  value={null}
                  onChange={pickServer}
                  options={list.filter((x) => !serverIds.includes(x.id)).map(serverOption)}
                  placeholder={
                    <span className="text-text-3">
                      {serverIds.length > 0 ? 'Добавить ещё сервер…' : 'Выберите сервер'}
                    </span>
                  }
                  searchPlaceholder="Найти сервер…"
                  disabled={busy || serverIds.length >= list.length}
                  className="h-10 w-full"
                />
              </div>
            )}
            {errors.serverIds ? (
              <p className="mt-1.5 text-[12px] text-crit">{errors.serverIds}</p>
            ) : (
              <p className={HINT}>{SERVERS_HINT[kind]}</p>
            )}
          </div>

          {(kind === 'domain' || kind === 'cert') && (
            <div>
              <Label htmlFor="bill-domain">
                Домен <Opt />
              </Label>
              <Input
                id="bill-domain"
                value={domain}
                disabled={busy}
                placeholder="example.com"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => setDomain(e.target.value)}
                className="h-10 rounded-[10px] bg-surface-2 font-mono text-[13px]"
              />
              <p className={HINT}>
                {kind === 'cert'
                  ? 'Домен сертификата. Продлевать его панель не умеет — только напомнит.'
                  : 'Продлевается у регистратора, панель напомнит о сроке.'}
              </p>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="bill-amount">
                Сумма <Req />
              </Label>
              <div className="relative">
                <Input
                  id="bill-amount"
                  inputMode="decimal"
                  value={amount}
                  disabled={busy}
                  placeholder={kind === 'cert' ? '0' : '9.50'}
                  aria-invalid={errors.amount ? true : undefined}
                  onChange={(e) => {
                    setAmount(e.target.value.replace(/[^\d.,]/g, ''));
                    setErrors((p) => ({ ...p, amount: '' }));
                  }}
                  className="h-10 rounded-[10px] bg-surface-2 pr-8 tabular-nums"
                />
                <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[13px] text-text-3">
                  {BILLING_CURRENCY_SIGN[currency]}
                </span>
              </div>
              {errors.amount ? (
                <p className="mt-1.5 text-[12px] text-crit">{errors.amount}</p>
              ) : (
                <p className={HINT}>
                  {rate && amount.trim() !== '' && Number.isFinite(amountNum)
                    ? `≈ ${rub(Math.round(amountNum * 100 * rate))} по курсу ЦБ сегодня`
                    : kind === 'cert'
                      ? 'Бесплатный сертификат — 0: напоминание всё равно придёт.'
                      : 'Сколько списывают за один период.'}
                </p>
              )}
            </div>
            <div>
              <Label>
                Валюта <Req />
              </Label>
              <div role="radiogroup" aria-label="Валюта" className="grid grid-cols-3 gap-2">
                {(['RUB', 'USD', 'EUR'] as const).map((c) => (
                  // biome-ignore lint/a11y/useSemanticElements: см. группу выше
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={currency === c}
                    onClick={() => setCurrency(c)}
                    className={cn(chip(currency === c), 'h-10 text-[14px]')}
                  >
                    {BILLING_CURRENCY_SIGN[c]}
                  </button>
                ))}
              </div>
              <p className={HINT}>
                {currency === 'RUB'
                  ? 'Рубли — без пересчёта.'
                  : rate
                    ? `Курс ЦБ сегодня: ${rate.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`
                    : 'Курс ЦБ подставится в момент оплаты.'}
              </p>
            </div>
          </div>

          <div>
            <Label>
              Как часто платить <Req />
            </Label>
            <div className="flex flex-wrap gap-2">
              {BILLING_PERIOD_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  aria-pressed={presetOn(p)}
                  onClick={() => {
                    setCustom(false);
                    setUnit(p.unit);
                    setCount(p.count);
                  }}
                  className={chip(presetOn(p))}
                >
                  {p.label}
                </button>
              ))}
              <button
                type="button"
                aria-pressed={custom}
                onClick={() => {
                  setCustom(true);
                  if (unit === 'once') setUnit('day');
                }}
                className={chip(custom)}
              >
                своё…
              </button>
            </div>
            {custom && (
              <div className="mt-2.5 flex items-center gap-2 text-[13px]">
                <span className="text-text-2">Каждые</span>
                <Input
                  aria-label="Сколько"
                  inputMode="numeric"
                  value={String(count)}
                  onChange={(e) =>
                    setCount(Math.max(1, Math.min(1000, Number(e.target.value.replace(/\D/g, '')) || 1)))
                  }
                  className="h-9 w-[72px] rounded-[9px] bg-surface-2 text-center tabular-nums"
                />
                <div className="flex gap-1.5">
                  {UNITS.map((u) => (
                    <button
                      key={u.key}
                      type="button"
                      aria-pressed={unit === u.key}
                      onClick={() => setUnit(u.key)}
                      className={chip(unit === u.key)}
                    >
                      {u.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <p className={HINT}>{periodHint}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="bill-until">
                Оплачено до <Req />
              </Label>
              <Input
                id="bill-until"
                type="datetime-local"
                value={paidUntil}
                disabled={busy}
                aria-invalid={errors.paidUntil ? true : undefined}
                onChange={(e) => setPaidUntil(e.target.value)}
                className="h-10 rounded-[10px] bg-surface-2 text-[13px]"
              />
              {errors.paidUntil ? (
                <p className="mt-1.5 text-[12px] text-crit">{errors.paidUntil}</p>
              ) : (
                <p className={HINT}>Когда нужна следующая оплата. Время важно для посуточных тарифов.</p>
              )}
            </div>
            <div>
              <Label>
                Напомнить <Opt />
              </Label>
              <div className="grid grid-cols-2 gap-2">
                {REMIND.map((r) => (
                  <button
                    key={r.label}
                    type="button"
                    aria-pressed={remind === r.v}
                    onClick={() => setRemind(r.v)}
                    className={chip(remind === r.v)}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <p className={HINT}>«Как обычно» — за 3 дня без звука и в день срока со звуком.</p>
            </div>
          </div>

          {unit !== 'once' && (
            <div className="flex items-center gap-4 rounded-[12px] border border-border px-4 py-3">
              <div className="min-w-0 flex-1">
                <label htmlFor="bill-auto" className="block cursor-pointer text-[13px] font-semibold">
                  Списывается сама
                </label>
                <p className="mt-0.5 text-[12px] leading-snug text-text-3">
                  Автоплатёж у провайдера: в срок панель сама продлит дату и учтёт сумму. Напоминаний не
                  будет.
                </p>
              </div>
              <Toggle id="bill-auto" checked={autoCharge} onChange={setAutoCharge} />
            </div>
          )}

          <div>
            <Label htmlFor="bill-note">
              Заметка <Opt />
            </Label>
            <Input
              id="bill-note"
              value={note}
              maxLength={1000}
              disabled={busy}
              placeholder="Как платить, логин кабинета, номер договора…"
              onChange={(e) => setNote(e.target.value)}
              className="h-10 rounded-[10px] bg-surface-2"
            />
          </div>
          {errors.form && (
            <p role="alert" className="text-[12px] text-crit">
              {errors.form}
            </p>
          )}
        </form>
        <div className="flex flex-none items-center gap-3 border-t border-border bg-bg-2 px-6 py-3.5 max-sm:flex-col max-sm:items-stretch">
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
            <span className="text-crit">*</span> обязательные поля. Изменения попадают в Журнал.
          </p>
          <div className="flex gap-2 max-sm:flex-col">
            <DialogSecondaryButton
              disabled={busy}
              onClick={() => onOpenChange(false)}
              className="h-10 w-[128px] flex-none rounded-[10px] max-sm:w-full sm:max-w-none"
            >
              Отмена
            </DialogSecondaryButton>
            <DialogPrimaryButton
              type="submit"
              form="billing-form"
              disabled={busy}
              className="h-10 w-[128px] flex-none rounded-[10px] max-sm:w-full sm:max-w-none"
            >
              {busy && <Loader2Icon className="animate-spin" aria-hidden="true" />}
              {item ? 'Сохранить' : 'Добавить'}
            </DialogPrimaryButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
