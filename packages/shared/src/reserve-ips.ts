import { z } from 'zod';

/** IPv4 или IPv6 без порта — и в браузере, и на сервере. */
export const isReserveIp = (v: string) => z.ipv4().safeParse(v).success || z.ipv6().safeParse(v).success;

/**
 * Запасные IP ноды (0.111.0, витрина reference-pack-2026-10, раздел 4 — A): другие адреса того же сервера. Проверка —
 * Check-Host на этом адресе, живая нода никуда не переводится. Переключение — адрес ноды в Remnawave, Host с этим IP
 * и записи DNS со старым IP.
 */
export const reserveIpCheckSchema = z.object({
  at: z.string(),
  /** Отвечает из России и других стран — на него можно переключать. */
  ok: z.boolean(),
  verdict: z.enum(['reachable', 'russia_unreachable', 'russia_partial', 'port_unreachable', 'unknown']),
  /** Итог словами: «Отвечает · порт 443: 9 из 10 точек в РФ…». */
  text: z.string(),
});
export type ReserveIpCheck = z.infer<typeof reserveIpCheckSchema>;
export const reserveIpSchema = z.object({
  ip: z.string(),
  check: reserveIpCheckSchema.nullable(),
  /** Был рабочим адресом ноды до этого времени (ISO): так в список попадает старый адрес после переключения. */
  wasPrimaryUntil: z.string().nullable(),
});
export type ReserveIp = z.infer<typeof reserveIpSchema>;
export const reserveSwitchByLabels = {
  manual: 'вручную',
  auto: 'само, по блокировке',
  scenario: 'сценарием',
} as const;
export const nodeReserveSchema = z.object({
  items: z.array(reserveIpSchema),
  /** Переключать само, когда из России порт не виден, а из других стран виден. По умолчанию выключено. */
  auto: z.boolean(),
  lastSwitch: z
    .object({
      at: z.string(),
      from: z.string(),
      to: z.string(),
      by: z.enum(['manual', 'auto', 'scenario']),
    })
    .nullable(),
  /** Когда «само» последний раз пробовало и не нашло рабочего запасного: следующая попытка — через сутки. */
  autoTriedAt: z.string().nullable().optional(),
});
export type NodeReserve = z.infer<typeof nodeReserveSchema>;
export const RESERVE_IPS_MAX = 10;

/** Запасной адрес: IPv4 или IPv6 без порта. */
export const reserveIpAddSchema = z.object({
  ip: z.string().trim().refine(isReserveIp, 'Введите IP-адрес, например 203.0.113.10'),
});
export const reserveIpOrderSchema = z.object({ ips: z.array(z.string()).max(RESERVE_IPS_MAX) });
export const reserveAutoSchema = z.object({ auto: z.boolean() });
export const reserveSwitchSchema = z.object({ to: z.string() });

/**
 * Что поменяется при переключении (и что поменялось): адрес ноды в Remnawave, Host с этим IP, записи DNS со старым
 * IP. `ok` — null до переключения, true/false — итог шага; `error` — почему не вышло.
 */
export const reserveSwitchStepSchema = z.object({
  kind: z.enum(['node', 'host', 'dns']),
  title: z.string(),
  detail: z.string(),
  ok: z.boolean().nullable(),
  error: z.string().nullable(),
});
export type ReserveSwitchStep = z.infer<typeof reserveSwitchStepSchema>;
export const reserveSwitchPlanSchema = z.object({
  from: z.string(),
  to: z.string(),
  steps: z.array(reserveSwitchStepSchema),
  /** Почему переключать нельзя (адрес ноды — домен, адреса нет в списке); null — можно. */
  blocked: z.string().nullable(),
  /** DNS-интеграции не подключены или не ответили — записи DNS не поменяются, словами. */
  dnsNote: z.string().nullable(),
});
export type ReserveSwitchPlan = z.infer<typeof reserveSwitchPlanSchema>;
export const reserveSwitchResultSchema = z.object({
  plan: reserveSwitchPlanSchema,
  reserve: nodeReserveSchema,
  nodeName: z.string(),
});
export type ReserveSwitchResult = z.infer<typeof reserveSwitchResultSchema>;
