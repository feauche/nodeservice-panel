import { z } from 'zod';
/**
 * Ответ одной точки DPI Checker. state: ok — открывается; fail — не открывается (reason — почему, по-русски);
 * unknown — точка сама без связи или ответа ещё нет, в итог не идёт. accessible — то же для старых клиентов.
 */
export const dpiPointSchema = z.object({
  location: z.string(),
  popId: z.number().nullable().default(null),
  accessible: z.boolean().nullable(),
  state: z.enum(['ok', 'fail', 'unknown']).default('unknown'),
  reason: z.string().nullable().default(null),
  latency: z.number().nullable(),
  /** Сколько попыток TLS прошло и сколько из них с замедлением: «5 из 5»; null — режим без этих данных. */
  tls: z.string().nullable().default(null),
  throttled: z.string().nullable().default(null),
  /** Перехвачен ли порт 80 по пути: «перехвачен», «не перехвачен»; null — неизвестно. */
  port80: z.string().nullable().default(null),
});
export const dpiCheckSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  createdAt: z.string(),
  completedAt: z.string().nullable().default(null),
  cost: z.number().nullable(),
  /** Отменённая до начала проверка: деньги вернули. */
  refunded: z.boolean().default(false),
  total: z.number(),
  success: z.number().nullable(),
  /** Точки без связи — не в счёт итога. */
  unknown: z.number().default(0),
  /** Ход идущей проверки: сколько пар «адрес × точка» готово. */
  progress: z.object({ done: z.number(), total: z.number(), percent: z.number() }).nullable().default(null),
  /** Откуда запущена: panel — из панели, остальное — сайт, бот или монитор DPI Checker. */
  source: z.string().nullable().default(null),
  results: z.array(dpiPointSchema),
  node: z.object({ uuid: z.string(), name: z.string(), panel: z.string() }).nullable().optional(),
});
export const dpiScheduleSchema = z.object({
  enabled: z.boolean(),
  minutes: z.number(),
  nodes: z.array(z.string()),
  pops: z.array(z.number()),
  nextAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export const dpiWorkspaceSchema = z.object({
  checks: z.array(dpiCheckSchema),
  pops: z.array(z.object({ id: z.number(), name: z.string(), provider: z.string() })),
  schedule: dpiScheduleSchema,
  /** Текущий баланс в долларах (обновляется не реже раза в минуту); null — не узнали. */
  balance: z.string().nullable().default(null),
  /** Цены DPI Checker за точку и за адрес на точке, в долларах; null — тарифы не загрузились. */
  prices: z
    .object({ ipPop: z.number(), ipResource: z.number(), vpnPop: z.number(), vpnResource: z.number() })
    .nullable()
    .default(null),
  /** Цена зонда подсети: фикс сразу и за гигабайт трафика по итогу, в долларах; null — тарифы не загрузились. */
  probePrice: z.object({ fixed: z.number(), perGb: z.number() }).nullable().default(null),
  /** Сколько точек в «оптимальном» наборе сервиса. */
  optimal: z.number().default(10),
});
/** Реестр РКН по адресу ноды: в реестре ли адрес или его подсеть, чья сеть. */
export const dpiRknSchema = z.object({
  address: z.string(),
  blocked: z.boolean(),
  subnet: z.string().nullable(),
  domain: z.boolean(),
  network: z.string().nullable(),
  refreshedAt: z.string().nullable(),
});
export const dpiScanStartSchema = z.object({ id: z.string(), status: z.string() });
export const dpiQuotaSchema = z.object({
  left: z.number().nullable(),
  limit: z.number().nullable(),
  unlimited: z.boolean(),
});
const dpiHostSchema = z.object({ ip: z.string(), domain: z.string(), note: z.string() });
/** «Шумные соседи»: соседи по подсети /24 с плохой репутацией в РФ, за рубежом и похожие на VPN. */
export const dpiNoisySchema = z.object({
  id: z.string(),
  status: z.string(),
  cidr: z.string().nullable(),
  count: z.number(),
  bad: z.array(dpiHostSchema),
  foreign: z.array(dpiHostSchema),
  vpn: z.array(dpiHostSchema),
  groups: z.array(z.object({ label: z.string(), count: z.number() })),
});
/** Зонд подсети /24: сколько соседних адресов закрыты из России и во сколько обошлось. */
export const dpiProbeSchema = z.object({
  id: z.string(),
  status: z.string(),
  cidr: z.string().nullable(),
  verdict: z.string().nullable(),
  blocked: z.number().nullable(),
  tested: z.number().nullable(),
  cost: z.number(),
  ips: z.array(
    z.object({ ip: z.string(), domain: z.string(), open: z.number(), closed: z.number(), total: z.number() }),
  ),
  error: z.string().nullable(),
});
/** Оценка цены до запуска (бесплатно): сколько спишут, хватит ли баланса, сколько минут. */
export const dpiEstimateSchema = z.object({
  cost: z.number(),
  balance: z.number().nullable(),
  affordable: z.boolean(),
  minutes: z.number().nullable(),
  pops: z.number(),
});
export const dnsRecordSchema = z.object({
  id: z.string(),
  provider: z.enum(['cloudflare', 'regru']),
  zone: z.string(),
  zoneId: z.string(),
  recordId: z.string(),
  name: z.string(),
  subname: z.string(),
  type: z.string(),
  content: z.string(),
  ttl: z.number(),
  nodes: z.array(z.object({ uuid: z.string(), name: z.string(), address: z.string() })),
});
export const dnsWorkspaceSchema = z.object({
  domains: z.array(z.object({ name: z.string(), provider: z.string(), hosts: z.array(z.string()) })),
  records: z.array(dnsRecordSchema),
  unmanaged: z.array(z.string()),
  errors: z.array(z.string()),
  checkedAt: z.string(),
  settings: z.object({
    automaticNodes: z.array(z.string()),
    automaticRecords: z.array(z.string()).default([]),
  }),
});
export const dnsHistorySchema = z.object({
  items: z.array(
    z.object({
      at: z.string(),
      domain: z.string(),
      provider: z.string(),
      old: z.string(),
      next: z.string(),
      status: z.string(),
      automatic: z.boolean(),
    }),
  ),
});
export type DpiCheck = z.infer<typeof dpiCheckSchema>;
export type DpiPoint = z.infer<typeof dpiPointSchema>;
export type DpiEstimate = z.infer<typeof dpiEstimateSchema>;
export type DnsRecord = z.infer<typeof dnsRecordSchema>;
