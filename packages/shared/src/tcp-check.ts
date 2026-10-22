import { z } from 'zod';
/**
 * Итог проверки порта: reachable — РФ отвечает вся; russia_unreachable — РФ не отвечает совсем, другие страны все;
 * russia_partial — другие страны все, РФ не со всех точек (блокировка у части провайдеров или сбой самой точки);
 * port_unreachable — не отвечает никто; unknown — данных не хватает или они расходятся.
 */
export const tcpVerdictSchema = z.enum([
  'reachable',
  'russia_unreachable',
  'russia_partial',
  'port_unreachable',
  'unknown',
]);
const tcpObservationSchema = z.object({
  node: z.string(),
  country: z.string(),
  city: z.string(),
  state: z.enum(['ok', 'failed', 'pending']),
  error: z.string().nullable(),
});
const base = z.object({
  verdict: tcpVerdictSchema,
  checkedAt: z.string(),
  target: z.string(),
  link: z.string().nullable(),
  observations: z.array(tcpObservationSchema),
  error: z.string().nullable(),
});
const withPorts = base.extend({ ports: z.array(base).optional() });
export const tcpCheckReportSchema = withPorts.extend({
  /** «Частично недоступен из РФ» повторился при проверке через минуту — это уже не сбой одной точки. */
  confirmed: z.boolean().optional(),
  /** Первая проверка, которую подтвердил повтор: в сообщении видны обе — «РФ, 16:09» и «РФ, 16:10». */
  first: withPorts.optional(),
});
export type TcpCheckReport = z.infer<typeof tcpCheckReportSchema>;
export const nodeTcpDiagnosticsSchema = z.object({
  source: z.literal('checkhost'),
  report: tcpCheckReportSchema,
  online: z.object({ before: z.number(), after: z.number() }).optional(),
});
export type NodeTcpDiagnostics = z.infer<typeof nodeTcpDiagnosticsSchema>;

export const nodeTcpHistorySchema = z.object({
  checks: z.array(z.object({ id: z.uuid(), report: tcpCheckReportSchema })),
});

/** Итог проверки порта — одними словами на странице события, в окне ноды и в Telegram. */
export const TCP_VERDICT_LABELS = {
  reachable: 'Доступен',
  russia_unreachable: 'Недоступен из РФ',
  russia_partial: 'Частично недоступен из РФ',
  port_unreachable: 'Не отвечает',
  unknown: 'Нет полного результата',
} as const;
export const TCP_VERDICT_HEADLINES = {
  reachable: 'IP доступен: хотя бы один порт отвечает',
  russia_unreachable: 'Вероятное ограничение доступа из РФ',
  russia_partial: 'Вероятная блокировка у части провайдеров РФ',
  port_unreachable: 'Проверенные TCP-порты не отвечают',
  unknown: 'Доступность пока не подтверждена',
} as const;
export const TCP_VERDICT_EXPLANATIONS = {
  reachable:
    'Есть успешные подключения из РФ и других стран. Если онлайн упал, причина требует отдельной проверки.',
  russia_unreachable: 'Проверенные порты недоступны из российских точек, но есть ответы из других стран.',
  russia_partial:
    'Из других стран порты отвечают со всех точек, из РФ — не со всех. Так выглядит блокировка у части провайдеров; бывает и сбой самой точки проверки, поэтому при падении онлайна панель перепроверяет через минуту.',
  port_unreachable:
    'Нет успешных подключений ни из РФ, ни из других стран. Возможны недоступность ноды, закрытые порты или фильтрация.',
  unknown:
    'Часть точек не ответила или результаты расходятся. Таких данных недостаточно для вывода о недоступности IP.',
} as const;

type TcpObservation = TcpCheckReport['observations'][number];
/** Точки проверки порта: российские и остальные. */
export const tcpRegions = (port: { observations: TcpObservation[] }) => ({
  ru: port.observations.filter((r) => r.country === 'ru'),
  other: port.observations.filter((r) => r.country !== 'ru'),
});
/**
 * Сколько точек ответило: «Ответили 3 из 3», «Не ответили 2 из 3» или «Недостаточно данных». Точка без ответа
 * отказом не считается — как в итоге проверки.
 */
export function tcpRegionSummary(rows: TcpObservation[]): string {
  const ok = rows.filter((r) => r.state === 'ok').length,
    failed = rows.filter((r) => r.state === 'failed').length;
  if (ok) return `Ответили ${ok} из ${rows.length}`;
  if (failed && failed === rows.filter((r) => r.state !== 'pending').length)
    return `Не ответили ${failed} из ${rows.length}`;
  return 'Недостаточно данных';
}
/**
 * Блокировка из РФ, на которую реагируют события и сценарии: РФ не отвечает совсем — или отвечает не со всех точек,
 * и это повторилось при проверке через минуту.
 */
export const tcpBlockedInRussia = (report: { verdict: string; confirmed?: boolean | undefined }) =>
  report.verdict === 'russia_unreachable' ||
  (report.verdict === 'russia_partial' && report.confirmed === true);
/** Порт из адреса проверки «1.2.3.4:443». */
export const tcpPortOf = (target: string): string => target.slice(target.lastIndexOf(':') + 1);
/**
 * Сколько точек ответило одной строкой: «из РФ 3 из 3, из других стран 3 из 3»; по нескольким портам —
 * «порт 443: РФ 3 из 3, другие 3 из 3; порт 80: …». Нет точек — пустая строка.
 */
export function tcpReachSummary(report: TcpCheckReport): string {
  const count = (rows: TcpObservation[]) =>
    `${rows.filter((r) => r.state === 'ok').length} из ${rows.length}`;
  const ports = report.ports?.length ? report.ports : [report];
  const [only] = ports;
  if (ports.length === 1 && only) {
    const { ru, other } = tcpRegions(only);
    return [ru.length ? `из РФ ${count(ru)}` : '', other.length ? `из других стран ${count(other)}` : '']
      .filter(Boolean)
      .join(', ');
  }
  return ports
    .map((p) => {
      const { ru, other } = tcpRegions(p);
      return `порт ${tcpPortOf(p.target)}: РФ ${count(ru)}, другие ${count(other)}`;
    })
    .join('; ');
}
/** Ссылка на отчёт Check-Host, которую можно показать кнопкой или ссылкой: только их собственный адрес. */
export const isCheckHostReport = (link: string | null | undefined): link is string =>
  typeof link === 'string' && /^https:\/\/check-host\.net\/check-report\/[a-zA-Z0-9_-]+$/.test(link);
