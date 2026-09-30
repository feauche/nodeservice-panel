import {
  addBillingPeriod,
  BILLING_KINDS,
  type BillingCurrency,
  type BillingDueState,
  type BillingForecast,
  type BillingForecastItem,
  type BillingItem,
  type BillingItemUpsert,
  type BillingPayment,
  type BillingStatPeriod,
  type BillingStats,
  type BillingSummary,
  type BillingTotal,
} from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';

import { mockProviders } from './providers-mock';
import { mockServers } from './servers-mock';

/** Курс «получен только что» на сегодняшнюю московскую дату — как у панели, которой ЦБ ответил. */
function freshRates(): BillingSummary['rates'] {
  return {
    USD: 81.5,
    EUR: 95.2,
    date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date()),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Мок биллинга: оплаты и продления в памяти, курс ЦБ постоянный ($ 81,50 ₽, € 95,20 ₽). Итоги считаются
 * по календарю браузера — как на сервере, только без часового пояса владельца.
 */
export const mockBilling = {
  items: [] as Array<BillingItem & { notified?: string | null }>,
  payments: [] as BillingPayment[],
  rates: freshRates(),
};

const DAY = 86_400_000;
let seq = 0;
const uuid = (kind: string) => `0192c000-${kind}-7000-8000-${String(++seq).padStart(12, '0')}`;
/** Рублей за единицу валюты; курса нет (тест «курс не получен») — 0, как непосчитанная сумма. */
const rateOf = (c: BillingCurrency): number =>
  c === 'RUB' ? 1 : ((c === 'USD' ? mockBilling.rates.USD : mockBilling.rates.EUR) ?? 0);

function dueState(i: Pick<BillingItem, 'paidUntil' | 'archivedAt' | 'remindDays'>): BillingDueState {
  if (i.archivedAt) return 'archived';
  const left = Date.parse(i.paidUntil) - Date.now();
  if (left <= 0) return 'overdue';
  if (left < DAY) return 'today';
  if (left < (i.remindDays ?? 3) * DAY) return 'soon';
  return 'ok';
}

const fresh = (i: BillingItem): BillingItem => ({
  ...i,
  dueState: dueState(i),
  amountRubTodayMinor: Math.round(i.amountMinor * rateOf(i.currency)),
});

function fromUpsert(b: BillingItemUpsert, base?: BillingItem): BillingItem {
  return fresh({
    id: base?.id ?? uuid('bbbb'),
    kind: b.kind,
    title: b.title,
    providerId: b.providerId,
    serverIds: b.serverIds,
    domain: b.domain || null,
    amountMinor: Math.round(b.amount * 100),
    currency: b.currency,
    periodUnit: b.periodUnit,
    periodCount: b.periodUnit === 'once' ? 1 : b.periodCount,
    paidUntil: new Date(b.paidUntil).toISOString(),
    autoCharge: b.periodUnit === 'once' ? false : b.autoCharge,
    remindDays: b.remindDays,
    note: b.note || null,
    archivedAt: base?.archivedAt ?? null,
    createdAt: base?.createdAt ?? new Date().toISOString(),
    dueState: 'ok',
    amountRubTodayMinor: null,
  });
}

function pay(item: BillingItem, paidAt: Date, to: Date, counted: boolean, amountMinor = item.amountMinor) {
  const rate = rateOf(item.currency);
  const p: BillingPayment = {
    id: uuid('cafe'),
    itemId: item.id,
    paidAt: paidAt.toISOString(),
    counted,
    amountMinor: counted ? amountMinor : 0,
    currency: item.currency,
    rate,
    amountRubMinor: counted ? Math.round(amountMinor * rate) : 0,
    extendedFrom: item.paidUntil,
    extendedTo: to.toISOString(),
    actor: 'admin',
    undoable: false,
  };
  mockBilling.payments.unshift(p);
  item.paidUntil = to.toISOString();
  return p;
}

export function seedBilling(): void {
  seq = 0;
  mockBilling.items = [];
  mockBilling.payments = [];
  mockBilling.rates = freshRates();
  const [s1, s2] = mockServers.items;
  const prov = (name: string) => mockProviders.items.find((p) => p.name === name)?.id ?? null;
  const now = Date.now();
  const add = (b: Omit<BillingItemUpsert, 'paidUntil'> & { at: number }) => {
    const { at, ...rest } = b;
    const item = fromUpsert({ ...rest, paidUntil: new Date(now + at).toISOString() });
    mockBilling.items.push(item);
    return item;
  };
  const base = { domain: null, autoCharge: false, remindDays: null, note: null, periodCount: 1 } as const;
  const i1 = add({
    ...base,
    kind: 'server',
    title: 'de-fra-01 · VPS 2 ГБ',
    providerId: prov('Aéza'),
    serverIds: s1 ? [s1.id] : [],
    amount: 9.5,
    currency: 'EUR',
    periodUnit: 'day',
    periodCount: 30,
    at: 2 * DAY + 3 * 3_600_000,
  });
  add({
    ...base,
    kind: 'rent',
    title: 'Вход с белым IP',
    providerId: null,
    serverIds: s2 ? [s2.id] : [],
    amount: 1500,
    currency: 'RUB',
    periodUnit: 'month',
    at: -DAY - 2 * 3_600_000,
    note: 'Иван, перевод на карту до 10:00',
  });
  const i3 = add({
    ...base,
    kind: 'server',
    title: 'nl-ams-02 · CX22',
    providerId: prov('Hetzner'),
    serverIds: s2 ? [s2.id] : [],
    amount: 4.51,
    currency: 'EUR',
    periodUnit: 'month',
    autoCharge: true,
    at: 12 * DAY,
  });
  add({
    ...base,
    kind: 'other',
    title: 'Резервные копии S3',
    providerId: null,
    serverIds: [],
    amount: 3,
    currency: 'USD',
    periodUnit: 'month',
    at: 5 * 3_600_000,
  });
  add({
    ...base,
    kind: 'cert',
    title: '*.lumaxvds.org — certwarden',
    providerId: null,
    serverIds: [s1, s2].filter(Boolean).map((s) => s?.id ?? ''),
    domain: 'lumaxvds.org',
    amount: 0,
    currency: 'RUB',
    periodUnit: 'day',
    periodCount: 90,
    at: 21 * DAY,
  });
  add({
    ...base,
    kind: 'domain',
    title: 'lumaxvds.org',
    providerId: prov('Timeweb'),
    serverIds: [],
    domain: 'lumaxvds.org',
    amount: 1290,
    currency: 'RUB',
    periodUnit: 'year',
    at: 64 * DAY,
  });
  // История: пара оплат в этом месяце и раньше в году — чтобы статистика не была пустой.
  const past = (item: BillingItem, daysAgo: number) => {
    const from = new Date(Date.parse(item.paidUntil) - 30 * DAY);
    const saved = item.paidUntil;
    item.paidUntil = from.toISOString();
    pay(item, new Date(now - daysAgo * DAY), new Date(saved), true);
  };
  past(i1, 1);
  past(i3, 3);
  for (let m = 1; m <= 7; m += 1) {
    const p = pay({ ...i3 }, new Date(now - m * 30 * DAY), new Date(now - (m - 1) * 30 * DAY), true);
    p.amountRubMinor = Math.round(451 * (90 + m));
  }
  for (const i of mockBilling.items) Object.assign(i, fresh(i));
}

function bounds(period: BillingStatPeriod, now = new Date()): { from: Date; to: Date } {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  if (period === 'day') return { from: new Date(y, m, d), to: new Date(y, m, d + 1) };
  if (period === 'week') {
    const wd = (now.getDay() + 6) % 7;
    return { from: new Date(y, m, d - wd), to: new Date(y, m, d - wd + 7) };
  }
  if (period === 'month') return { from: new Date(y, m, 1), to: new Date(y, m + 1, 1) };
  return { from: new Date(y, 0, 1), to: new Date(y + 1, 0, 1) };
}

function total(period: BillingStatPeriod): BillingTotal {
  const { from, to } = bounds(period);
  const rows = mockBilling.payments.filter(
    (p) => p.counted && Date.parse(p.paidAt) >= from.getTime() && Date.parse(p.paidAt) < to.getTime(),
  );
  const byCurrency = new Map<BillingCurrency, number>();
  for (const p of rows) byCurrency.set(p.currency, (byCurrency.get(p.currency) ?? 0) + p.amountMinor);
  let expected = 0;
  const start = Math.max(Date.now(), from.getTime());
  for (const i of mockBilling.items) {
    if (i.archivedAt) continue;
    let d = new Date(i.paidUntil);
    let n = 0;
    if (d.getTime() < start) {
      n = 1;
      if (i.periodUnit !== 'once')
        while (d.getTime() < start && n < 400) d = addBillingPeriod(d, i.periodUnit, i.periodCount);
      else d = to;
    }
    while (d < to && n < 400) {
      n += 1;
      if (i.periodUnit === 'once') break;
      d = addBillingPeriod(d, i.periodUnit, i.periodCount);
    }
    expected += n * Math.round(i.amountMinor * rateOf(i.currency));
  }
  return {
    spentRubMinor: rows.reduce((a, p) => a + p.amountRubMinor, 0),
    payments: rows.length,
    byCurrency: [...byCurrency].map(([currency, amountMinor]) => ({ currency, amountMinor })),
    expectedRubMinor: expected,
    from: from.toISOString(),
    to: to.toISOString(),
  };
}

function summary(): BillingSummary {
  const active = mockBilling.items.filter((i) => !i.archivedAt).map(fresh);
  active.sort((a, b) => Date.parse(a.paidUntil) - Date.parse(b.paidUntil));
  const byServer: BillingSummary['byServer'] = [];
  for (const i of active) {
    if (i.kind !== 'server' && i.kind !== 'rent') continue;
    for (const sid of i.serverIds)
      if (!byServer.some((b) => b.serverId === sid))
        byServer.push({
          serverId: sid,
          itemId: i.id,
          title: i.title,
          paidUntil: i.paidUntil,
          dueState: i.dueState,
          amountMinor: i.amountMinor,
          currency: i.currency,
        });
  }
  const first = active[0];
  return {
    day: total('day'),
    week: total('week'),
    month: total('month'),
    year: total('year'),
    overdue: active.filter((i) => i.dueState === 'overdue').length,
    dueToday: active.filter((i) => i.dueState === 'today').length,
    next: first
      ? {
          itemId: first.id,
          title: first.title,
          paidUntil: first.paidUntil,
          amountMinor: first.amountMinor,
          currency: first.currency,
        }
      : null,
    byServer,
    rates: { ...mockBilling.rates },
  };
}

function stats(period: BillingStatPeriod): BillingStats {
  const { from, to } = bounds(period);
  const year = bounds('year');
  const kindOf = (id: string) => mockBilling.items.find((i) => i.id === id);
  const inYear = mockBilling.payments.filter(
    (p) =>
      p.counted && Date.parse(p.paidAt) >= year.from.getTime() && Date.parse(p.paidAt) < year.to.getTime(),
  );
  const inPeriod = inYear.filter(
    (p) => Date.parse(p.paidAt) >= from.getTime() && Date.parse(p.paidAt) < to.getTime(),
  );
  const prov = new Map<string, { providerId: string | null; name: string; rubMinor: number }>();
  const kinds = new Map<string, number>();
  for (const p of inPeriod) {
    const it = kindOf(p.itemId);
    const pid = it?.providerId ?? null;
    const key = pid ?? '—';
    const cur = prov.get(key) ?? {
      providerId: pid,
      name: mockProviders.items.find((x) => x.id === pid)?.name ?? 'Без провайдера',
      rubMinor: 0,
    };
    cur.rubMinor += p.amountRubMinor;
    prov.set(key, cur);
    if (it) kinds.set(it.kind, (kinds.get(it.kind) ?? 0) + p.amountRubMinor);
  }
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    byKind: {} as Record<string, number>,
  }));
  for (const p of inYear) {
    const it = kindOf(p.itemId);
    const b = months[new Date(p.paidAt).getMonth()];
    if (b && it) b.byKind[it.kind] = (b.byKind[it.kind] ?? 0) + p.amountRubMinor;
  }
  return {
    period,
    total: total(period),
    byProvider: [...prov.values()].sort((a, b) => b.rubMinor - a.rubMinor),
    byKind: BILLING_KINDS.filter((k) => kinds.has(k)).map((k) => ({ kind: k, rubMinor: kinds.get(k) ?? 0 })),
    months,
  };
}

const notFound = () =>
  HttpResponse.json(
    {
      type: 'urn:nodeservice:problem:billing-not-found',
      title: 'Оплата не найдена.',
      status: 404,
      detail: 'Оплата не найдена.',
    },
    { status: 404, headers: { 'content-type': 'application/problem+json' } },
  );
const bad = (detail: string, status = 400) =>
  HttpResponse.json(
    { type: 'about:blank', title: detail, status, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

const withUndo = (itemId: string): BillingPayment[] => {
  const item = mockBilling.items.find((i) => i.id === itemId);
  return mockBilling.payments
    .filter((p) => p.itemId === itemId)
    .sort((a, b) => Date.parse(b.paidAt) - Date.parse(a.paidAt))
    .map((p, idx) => ({ ...p, undoable: idx === 0 && p.extendedTo === item?.paidUntil }));
};

function forecast(): BillingForecast {
  const now = new Date();
  const horizon = new Date(now.getFullYear() + 1, now.getMonth() + 4, 1);
  const all: BillingForecastItem[] = [];
  for (const i of mockBilling.items) {
    if (i.archivedAt) continue;
    let d = new Date(i.paidUntil);
    const push = (at: Date, overdue: boolean) =>
      all.push({
        itemId: i.id,
        title: i.title,
        provider: mockProviders.items.find((p) => p.id === i.providerId)?.name ?? null,
        date: at.toISOString(),
        overdue,
        amountMinor: i.amountMinor,
        currency: i.currency,
        rubMinor: Math.round(i.amountMinor * rateOf(i.currency)),
        auto: i.autoCharge,
      });
    if (d < now) {
      push(now, true);
      if (i.periodUnit === 'once') continue;
      while (d < now) d = addBillingPeriod(d, i.periodUnit, i.periodCount);
    }
    for (let n = 0; d < horizon && n < 400; n += 1) {
      push(d, false);
      if (i.periodUnit === 'once') break;
      d = addBillingPeriod(d, i.periodUnit, i.periodCount);
    }
  }
  all.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const within = (from: Date, to: Date) =>
    all.filter((x) => Date.parse(x.date) >= from.getTime() && Date.parse(x.date) < to.getTime());
  const sum = (l: BillingForecastItem[]) => l.reduce((a, x) => a + (x.rubMinor ?? 0), 0);
  const in7 = within(now, new Date(now.getTime() + 7 * DAY));
  const in30 = within(now, new Date(now.getTime() + 30 * DAY));
  const wk = bounds('week');
  const weeks = [0, 1, 2].map((k) => {
    const from = new Date(wk.from.getTime() + k * 7 * DAY);
    const to = new Date(wk.to.getTime() + k * 7 * DAY);
    const items = within(k === 0 ? now : from, to);
    return { from: from.toISOString(), to: to.toISOString(), rubMinor: sum(items), items };
  });
  const months = [-3, -2, -1, 0, 1, 2, 3].map((off) => {
    const from = new Date(now.getFullYear(), now.getMonth() + off, 1);
    const to = new Date(now.getFullYear(), now.getMonth() + off + 1, 1);
    return {
      year: from.getFullYear(),
      month: from.getMonth() + 1,
      paidRubMinor: mockBilling.payments
        .filter(
          (p) => p.counted && Date.parse(p.paidAt) >= from.getTime() && Date.parse(p.paidAt) < to.getTime(),
        )
        .reduce((a, p) => a + p.amountRubMinor, 0),
      forecastRubMinor: to <= now ? 0 : sum(within(from > now ? from : now, to)),
    };
  });
  const perUnit = { day: 365, week: 52, month: 12, year: 1, once: 0 } as const;
  return {
    next7: { rubMinor: sum(in7), count: in7.length },
    next30: { rubMinor: sum(in30), count: in30.length, auto: in30.filter((x) => x.auto).length },
    restOfYear: { rubMinor: sum(within(now, bounds('year').to)), months: 12 - now.getMonth() },
    perYearRubMinor: mockBilling.items
      .filter((i) => !i.archivedAt)
      .reduce(
        (a, i) =>
          a + Math.round((perUnit[i.periodUnit] / i.periodCount) * i.amountMinor * rateOf(i.currency)),
        0,
      ),
    first: all[0] ?? null,
    weeks,
    months,
    rateMissing: false,
  };
}

export const billingHandlers = [
  http.get('/api/billing/forecast', () => HttpResponse.json(forecast())),
  http.get('/api/billing/items', ({ request }) => {
    const archived = new URL(request.url).searchParams.get('archived') === '1';
    const items = mockBilling.items
      .filter((i) => Boolean(i.archivedAt) === archived)
      .map(fresh)
      .sort((a, b) =>
        archived
          ? Date.parse(b.archivedAt ?? '') - Date.parse(a.archivedAt ?? '')
          : Date.parse(a.paidUntil) - Date.parse(b.paidUntil),
      );
    return HttpResponse.json({ items });
  }),
  http.post('/api/billing/items', async ({ request }) => {
    const b = (await request.json()) as BillingItemUpsert;
    const item = fromUpsert(b);
    mockBilling.items.push(item);
    return HttpResponse.json(item, { status: 201 });
  }),
  http.put('/api/billing/items/:id', async ({ params, request }) => {
    const i = mockBilling.items.findIndex((x) => x.id === params.id);
    const cur = mockBilling.items[i];
    if (!cur) return notFound();
    const b = (await request.json()) as BillingItemUpsert;
    const item = fromUpsert(b, cur);
    mockBilling.items[i] = item;
    return HttpResponse.json(item);
  }),
  http.delete('/api/billing/items/:id', ({ params }) => {
    if (!mockBilling.items.some((x) => x.id === params.id)) return notFound();
    mockBilling.items = mockBilling.items.filter((x) => x.id !== params.id);
    mockBilling.payments = mockBilling.payments.filter((p) => p.itemId !== params.id);
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/api/billing/items/:id/archive', async ({ params, request }) => {
    const item = mockBilling.items.find((x) => x.id === params.id);
    if (!item) return notFound();
    const b = (await request.json()) as { archived: boolean };
    item.archivedAt = b.archived ? new Date().toISOString() : null;
    return HttpResponse.json(fresh(item));
  }),
  http.post('/api/billing/items/:id/extend', async ({ params, request }) => {
    const item = mockBilling.items.find((x) => x.id === params.id);
    if (!item) return notFound();
    const b = (await request.json()) as {
      period?: boolean;
      days?: number;
      until?: string;
      count: boolean;
      amount?: number;
    };
    const from = new Date(item.paidUntil);
    let to: Date | null = null;
    if (b.until) to = new Date(b.until);
    else if (b.days) to = new Date(from.getTime() + b.days * DAY);
    else if (b.period && item.periodUnit !== 'once')
      to = addBillingPeriod(from, item.periodUnit, item.periodCount);
    if (!to) return bad('Разовую оплату продлевают на число дней или до точной даты.');
    if (to.getTime() === from.getTime()) return bad('Новая дата совпадает с текущей.');
    const amount = b.amount !== undefined ? Math.round(b.amount * 100) : item.amountMinor;
    const p = pay(item, new Date(), to, b.count, amount);
    Object.assign(item, fresh(item));
    return HttpResponse.json({ item: fresh(item), payment: { ...p, undoable: true } });
  }),
  http.get('/api/billing/items/:id/payments', ({ params }) => {
    if (!mockBilling.items.some((x) => x.id === params.id)) return notFound();
    return HttpResponse.json({ items: withUndo(String(params.id)) });
  }),
  http.patch('/api/billing/payments/:id', async ({ params, request }) => {
    const p = mockBilling.payments.find((x) => x.id === params.id);
    if (!p) return notFound();
    const b = (await request.json()) as { paidAt?: string; amount?: number };
    if (b.paidAt) p.paidAt = new Date(b.paidAt).toISOString();
    if (b.amount !== undefined) {
      p.amountMinor = Math.round(b.amount * 100);
      p.counted = true;
      p.amountRubMinor = Math.round(p.amountMinor * p.rate);
    }
    return HttpResponse.json({ ...p, undoable: false });
  }),
  http.delete('/api/billing/payments/:id', ({ params }) => {
    const p = mockBilling.payments.find((x) => x.id === params.id);
    if (!p) return notFound();
    const item = mockBilling.items.find((i) => i.id === p.itemId);
    if (!item) return notFound();
    const [latest] = withUndo(item.id);
    if (latest?.id !== p.id || !latest.undoable)
      return bad('Отменить можно только последнее продление, пока дату не меняли.', 409);
    mockBilling.payments = mockBilling.payments.filter((x) => x.id !== p.id);
    item.paidUntil = p.extendedFrom;
    return HttpResponse.json(fresh(item));
  }),
  http.get('/api/billing/summary', () => HttpResponse.json(summary())),
  http.get('/api/billing/stats', ({ request }) => {
    const period = (new URL(request.url).searchParams.get('period') ?? 'month') as BillingStatPeriod;
    return HttpResponse.json(stats(period));
  }),
];
