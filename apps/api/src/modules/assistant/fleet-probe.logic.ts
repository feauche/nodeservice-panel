import type { Server } from '@nodeservice/shared';

import { SH } from '../incidents/actions.registry.js';

/** Сколько независимых серверов задействуем и сколько портов проверяем за раз. */
export const PROBE_MAX = 3;
export const PORTS_MAX = 3;

const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;

/** Адрес пригоден для проверки: имя или IPv4. IPv6 и всё с лишними символами не берём (команда собирается из этих данных). */
export const isProbeHost = (host: string): boolean => HOST_RE.test(host) && !host.includes('..');

export function normalizePorts(raw: unknown, fallback: number): number[] {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const ports = [
    ...new Set(list.map((p) => Number(p)).filter((p) => Number.isInteger(p) && p >= 1 && p <= 65_535)),
  ];
  return (ports.length > 0 ? ports : [fallback]).slice(0, PORTS_MAX);
}

const prefix24 = (host: string): string | null => {
  const m = host.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
  return m?.[1] ?? null;
};

/**
 * Выбор независимых проверяющих: не сам сервер, SSH работает, разные хостеры и подсети.
 * Сначала по одному от каждого хостера, потом добираем остальными, но не из уже занятой подсети /24.
 */
export function pickProbes(target: Pick<Server, 'id'>, all: Server[], max = PROBE_MAX): Server[] {
  const pool = all
    .filter((s) => s.id !== target.id && s.sshOk === true && isProbeHost(s.host))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const chosen: Server[] = [];
  const providers = new Set<string>();
  const nets = new Set<string>();
  const take = (s: Server) => {
    chosen.push(s);
    providers.add(s.providerId ?? `none:${s.id}`);
    const net = prefix24(s.host);
    if (net) nets.add(net);
  };
  for (const s of pool) {
    if (chosen.length >= max) break;
    if (!providers.has(s.providerId ?? `none:${s.id}`) && !nets.has(prefix24(s.host) ?? '')) take(s);
  }
  for (const s of pool) {
    if (chosen.length >= max) break;
    if (!chosen.includes(s) && !nets.has(prefix24(s.host) ?? '')) take(s);
  }
  for (const s of pool) {
    if (chosen.length >= max) break;
    if (!chosen.includes(s)) take(s);
  }
  return chosen;
}

/**
 * Скрипт проверки для проверяющего сервера: TCP-соединение (bash /dev/tcp, 4 с на порт) и то, во что
 * имя резолвится у него. Только исходящие соединения, ничего не пишет. Адрес и порты проверены до сборки.
 */
export function buildReachCommand(host: string, ports: number[]): string {
  if (!isProbeHost(host)) throw new Error('Адрес не подходит для проверки.');
  const list = ports.filter((p) => Number.isInteger(p) && p >= 1 && p <= 65_535).slice(0, PORTS_MAX);
  if (list.length === 0) throw new Error('Не заданы порты.');
  return SH(
    [
      '# ns-reach',
      `h=${host}`,
      `for p in ${list.join(' ')}; do`,
      '  s=$(date +%s%N)',
      '  if timeout 4 bash -c "exec 3<>/dev/tcp/$h/$p" 2>/dev/null; then e=$(date +%s%N); echo "tcp $p open $(( (e-s)/1000000 ))"; else echo "tcp $p closed"; fi',
      'done',
      'getent hosts $h | { read -r a _; echo "dns $a"; }',
    ].join('\n'),
  );
}

export interface ReachPort {
  port: number;
  open: boolean;
  ms: number | null;
}
export interface ReachProbe {
  from: string;
  ok: boolean;
  error: string | null;
  ports: ReachPort[];
  dns: string | null;
}

/** Разбор вывода скрипта проверки; нераспознанные строки игнорируются. */
export function parseReach(stdout: string, ports: number[]): { ports: ReachPort[]; dns: string | null } {
  const seen = new Map<number, ReachPort>();
  let dns: string | null = null;
  for (const line of stdout.split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'tcp' && t[1] && (t[2] === 'open' || t[2] === 'closed')) {
      const port = Number(t[1]);
      seen.set(port, { port, open: t[2] === 'open', ms: t[2] === 'open' && t[3] ? Number(t[3]) : null });
    } else if (t[0] === 'dns' && t[1] && /^[0-9a-fA-F:.]+$/.test(t[1])) dns = t[1];
  }
  return { ports: ports.flatMap((p) => (seen.has(p) ? [seen.get(p) as ReachPort] : [])), dns };
}

export type PortVerdict = 'reachable' | 'closed_everywhere' | 'partial' | 'unknown';
export interface ReachSummary {
  port: number;
  open: number;
  closed: number;
  verdict: PortVerdict;
  text: string;
}

const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11
    ? one
    : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)
      ? few
      : many;

/** Вывод по портам считает код, а не модель: одинаковые данные — одинаковая трактовка. */
export function summarizeReach(probes: ReachProbe[], ports: number[]): ReachSummary[] {
  const ok = probes.filter((p) => p.ok);
  return ports.map((port) => {
    const rows = ok.flatMap((p) => p.ports.filter((x) => x.port === port));
    const open = rows.filter((r) => r.open).length;
    const closed = rows.length - open;
    const total = rows.length;
    const verdict: PortVerdict =
      total === 0 ? 'unknown' : closed === 0 ? 'reachable' : open === 0 ? 'closed_everywhere' : 'partial';
    const of = `${total} ${plural(total, 'проверяющего сервера', 'проверяющих сервера', 'проверяющих серверов')}`;
    const text =
      verdict === 'reachable'
        ? `Порт ${port}: открыт со всех (${of}).`
        : verdict === 'closed_everywhere'
          ? `Порт ${port}: закрыт со всех (${of}). Похоже, сервис не слушает порт или его закрывает фильтр у хостера.`
          : verdict === 'partial'
            ? `Порт ${port}: открыт с ${open}, закрыт с ${closed} из ${total}. Так выглядит блокировка или сбой маршрута для части направлений.`
            : `Порт ${port}: проверить не удалось.`;
    return { port, open, closed, verdict, text };
  });
}

/** Что отвечает DNS у разных проверяющих: расхождение — признак подмены или сбоя резолвера. */
export function dnsSummary(probes: ReachProbe[]): { answers: string[]; consistent: boolean } {
  const answers = [...new Set(probes.filter((p) => p.ok && p.dns).map((p) => p.dns as string))];
  return { answers, consistent: answers.length <= 1 };
}

export interface ProcRow {
  pid: number;
  user: string;
  name: string;
  cpu: number;
  mem: number;
}

/** Команда осмотра: только имя процесса (`comm`), не аргументы, чтобы пароли из командных строк не уходили модели. */
export const PROCESSES_COMMAND = SH(
  [
    'echo "== cpu"; ps -eo pid=,user=,comm=,pcpu=,pmem= --sort=-pcpu | head -8',
    'echo "== mem"; ps -eo pid=,user=,comm=,pcpu=,pmem= --sort=-pmem | head -8',
    'echo "== load"; cat /proc/loadavg',
  ].join('; '),
);

export function parsePs(stdout: string): { cpu: ProcRow[]; mem: ProcRow[]; load: string | null } {
  const out = { cpu: [] as ProcRow[], mem: [] as ProcRow[], load: null as string | null };
  let section: 'cpu' | 'mem' | 'load' | null = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line === '== cpu') section = 'cpu';
    else if (line === '== mem') section = 'mem';
    else if (line === '== load') section = 'load';
    else if (section === 'load' && line) out.load = line.split(/\s+/).slice(0, 3).join(' ');
    else if (section === 'cpu' || section === 'mem') {
      const m = line.match(/^(\d+)\s+(\S+)\s+(.+?)\s+([\d.]+)\s+([\d.]+)$/);
      if (m)
        out[section].push({
          pid: Number(m[1]),
          user: m[2] as string,
          name: m[3] as string,
          cpu: Number(m[4]),
          mem: Number(m[5]),
        });
    }
  }
  return out;
}
