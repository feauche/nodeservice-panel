import { FIND_NODE, SH } from '../incidents/actions.registry.js';
import { maskSecrets } from './terminal-hint.logic.js';

/**
 * Узкие инструменты чтения по SSH (J2). Правила безопасности те же, что у остальных T0-проверок:
 * команда собирается только из фиксированных кусков и проверенных чисел и имён (allowlist), ничего из чата
 * в shell не попадает; вывод ограничен и маскируется до отправки модели.
 */

export const LOGS_CHARS = 6000;
export const LOGS_LINES_MAX = 200;
export const LOGS_LINES_DEFAULT = 80;
export const LOGS_MINUTES_MAX = 24 * 60;
export const CONTAINERS_MAX = 40;
const SECTION_CHARS = 1600;

export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/* ---------- контейнеры ---------- */

export const CONTAINERS_COMMAND = SH(
  [
    '# ns-inspect:containers',
    'command -v docker >/dev/null 2>&1 || { echo "@@nodocker"; exit 0; }',
    `ids=$(docker ps -aq 2>/dev/null | head -${CONTAINERS_MAX})`,
    '[ -n "$ids" ] || { echo "@@empty"; exit 0; }',
    'docker inspect -f "{{.Name}}|{{.Config.Image}}|{{.State.Status}}|{{.RestartCount}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.StartedAt}}|{{.State.FinishedAt}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}" $ids 2>&1',
  ].join('\n'),
);

export interface ContainerInfo {
  name: string;
  image: string;
  state: string;
  restarts: number;
  exitCode: number;
  oomKilled: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  health: string | null;
}

export interface ContainersResult {
  docker: boolean;
  containers: ContainerInfo[];
  /** Что бросается в глаза: остановлен, много перезапусков, убит по памяти, нездоров. */
  attention: string[];
}

const zeroTime = (s: string): string | null => (!s || s.startsWith('0001-') ? null : s);

export function parseContainers(stdout: string): ContainersResult {
  if (stdout.includes('@@nodocker')) return { docker: false, containers: [], attention: [] };
  const containers: ContainerInfo[] = [];
  for (const line of stdout.split('\n')) {
    const f = line.trim().split('|');
    if (f.length < 9) continue;
    containers.push({
      name: (f[0] ?? '').replace(/^\//, ''),
      image: f[1] ?? '',
      state: f[2] ?? '',
      restarts: Number(f[3]) || 0,
      exitCode: Number(f[4]) || 0,
      oomKilled: f[5] === 'true',
      startedAt: zeroTime(f[6] ?? ''),
      finishedAt: zeroTime(f[7] ?? ''),
      health: f[8] ? (f[8] as string) : null,
    });
  }
  const attention: string[] = [];
  for (const c of containers) {
    if (c.state === 'restarting') attention.push(`${c.name}: постоянно перезапускается`);
    else if (c.state !== 'running' && c.state !== 'created')
      attention.push(`${c.name}: не работает (${c.state}, код выхода ${c.exitCode})`);
    if (c.oomKilled) attention.push(`${c.name}: убит из-за нехватки памяти (OOM)`);
    if (c.restarts >= 3) attention.push(`${c.name}: ${c.restarts} перезапусков`);
    if (c.health === 'unhealthy') attention.push(`${c.name}: проверка здоровья не проходит`);
  }
  return { docker: true, containers, attention };
}

/* ---------- порты ---------- */

export const PORTS_COMMAND = SH(
  [
    '# ns-inspect:ports',
    'command -v ss >/dev/null 2>&1 || { echo "@@noss"; exit 0; }',
    'ss -tulnp 2>/dev/null | tail -n +2 | head -80',
  ].join('\n'),
);

export interface ListeningPort {
  proto: 'tcp' | 'udp';
  address: string;
  port: number;
  process: string | null;
  /** Слушает на всех адресах (доступен снаружи, если не закрыт файрволом) или только на localhost. */
  exposed: boolean;
}

const LISTEN_RE = /^(tcp|udp)\S*\s+\S+\s+\d+\s+\d+\s+(\S+):(\d+)\s+\S+\s*(.*)$/;

export function parsePorts(stdout: string): { available: boolean; ports: ListeningPort[] } {
  if (stdout.includes('@@noss')) return { available: false, ports: [] };
  const seen = new Set<string>();
  const ports: ListeningPort[] = [];
  for (const line of stdout.split('\n')) {
    const m = LISTEN_RE.exec(line.trim());
    if (!m) continue;
    const address = (m[2] ?? '').replace(/%.*$/, '');
    const local = /^(127\.|\[?::1\]?$)/.test(address);
    const port = Number(m[3]);
    const process = /\(\("([^"]+)"/.exec(m[4] ?? '')?.[1] ?? null;
    const key = `${m[1]}:${port}:${process ?? ''}:${local}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ports.push({ proto: m[1] as 'tcp' | 'udp', address, port, process, exposed: !local });
  }
  ports.sort((a, b) => a.port - b.port);
  return { available: true, ports };
}

/* ---------- диск ---------- */

export const DISK_COMMAND = SH(
  [
    '# ns-inspect:disk',
    'echo "@@df"; df -hP -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null',
    'echo "@@du"; timeout 10 du -xh / --max-depth=1 2>/dev/null | sort -h | tail -12',
    'echo "@@docker"; timeout 6 docker system df 2>/dev/null',
    'echo "@@journal"; journalctl --disk-usage 2>/dev/null',
  ].join('\n'),
);

export interface DiskResult {
  filesystems: string;
  biggestDirs: string;
  docker: string;
  journal: string;
}

const section = (text: string, name: string): string => {
  const m = new RegExp(`@@${name}\\n([\\s\\S]*?)(?=\\n@@|$)`).exec(text);
  const body = (m?.[1] ?? '').trim();
  return body.length > SECTION_CHARS ? `${body.slice(0, SECTION_CHARS)}…` : body;
};

export function parseDisk(stdout: string): DiskResult {
  return {
    filesystems: section(stdout, 'df'),
    biggestDirs: section(stdout, 'du'),
    docker: section(stdout, 'docker'),
    journal: section(stdout, 'journal'),
  };
}

/* ---------- ядро ---------- */

export const KERNEL_COMMAND = SH(
  [
    '# ns-inspect:kernel',
    '(dmesg -T 2>/dev/null || journalctl -k --no-pager -o short-iso 2>/dev/null) | grep -iE "out of memory|oom-kill|killed process|i/o error|ext4-fs error|xfs.*error|nf_conntrack: table full|segfault|call trace|hardware error|blocked for more than" | tail -40',
  ].join('\n'),
);

export function parseKernel(stdout: string): { events: string[]; masked: number } {
  const lines = stdout
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-40);
  const { text, count } = maskSecrets(lines.join('\n'));
  return { events: text ? text.split('\n') : [], masked: count };
}

/* ---------- сертификат ---------- */

const SERVERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
export const isServerName = (s: string): boolean => SERVERNAME_RE.test(s) && !s.includes('..');

export function certCommand(port: number, servername?: string): string {
  const name = servername && isServerName(servername) ? ` -servername ${servername}` : '';
  return SH(
    [
      '# ns-inspect:cert',
      "for a in 127.0.0.1 $(hostname -I 2>/dev/null | awk '{print $1}'); do",
      `  pem=$(echo | timeout 8 openssl s_client -connect "$a:${port}"${name} 2>/dev/null | sed -n '/BEGIN CERTIFICATE/,/END CERTIFICATE/p')`,
      '  [ -n "$pem" ] && break',
      'done',
      '[ -n "$pem" ] || { echo "@@nocert"; exit 0; }',
      'printf \'%s\\n\' "$pem" | openssl x509 -noout -subject -issuer -startdate -enddate -ext subjectAltName 2>&1',
    ].join('\n'),
  );
}

export interface CertResult {
  present: boolean;
  subject: string | null;
  issuer: string | null;
  notBefore: string | null;
  notAfter: string | null;
  daysLeft: number | null;
  names: string[];
}

const parseOpensslDate = (s: string | undefined): { iso: string; ms: number } | null => {
  if (!s) return null;
  const ms = Date.parse(s.replace(/\s+/g, ' ').trim());
  return Number.isFinite(ms) ? { iso: new Date(ms).toISOString(), ms } : null;
};

export function parseCert(stdout: string, nowMs: number = Date.now()): CertResult {
  if (stdout.includes('@@nocert'))
    return {
      present: false,
      subject: null,
      issuer: null,
      notBefore: null,
      notAfter: null,
      daysLeft: null,
      names: [],
    };
  const val = (key: string): string | undefined => new RegExp(`^${key}=(.*)$`, 'm').exec(stdout)?.[1]?.trim();
  const end = parseOpensslDate(val('notAfter'));
  const start = parseOpensslDate(val('notBefore'));
  const names = [...stdout.matchAll(/DNS:([^\s,]+)/g)].map((m) => m[1] as string);
  return {
    present: true,
    subject: val('subject') ?? null,
    issuer: val('issuer') ?? null,
    notBefore: start?.iso ?? null,
    notAfter: end?.iso ?? null,
    daysLeft: end ? Math.floor((end.ms - nowMs) / 86_400_000) : null,
    names: [...new Set(names)].slice(0, 20),
  };
}

/* ---------- журналы ---------- */

export const LOG_TARGETS = ['agent', 'ssh', 'docker', 'system', 'container'] as const;
export type LogTarget = (typeof LOG_TARGETS)[number];

/** Имя контейнера: как принимает Docker, без ведущего дефиса и лишних символов. */
export const isContainerName = (s: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,60}$/.test(s);

const UNITS: Record<Exclude<LogTarget, 'system' | 'container'>, string> = {
  agent: '-u nodeservice-agent',
  ssh: '-u ssh -u sshd',
  docker: '-u docker',
};

/** Команда журнала цели за период; null — цель неизвестна или имя контейнера недопустимо. */
export function logsCommand(
  target: string,
  sinceMinutes: number,
  lines: number,
  container?: string,
): string | null {
  const n = clampInt(sinceMinutes, 1, LOGS_MINUTES_MAX, 60);
  const l = clampInt(lines, 10, LOGS_LINES_MAX, LOGS_LINES_DEFAULT);
  const head = `# ns-inspect:logs:${target}`;
  if (target === 'container') {
    if (!container || !isContainerName(container)) return null;
    return SH([head, `docker logs --since ${n}m --tail ${l} "${container}" 2>&1`].join('\n'));
  }
  const base = `--since "${n} minutes ago" -n ${l} --no-pager -o short-iso 2>&1`;
  if (target === 'system') return SH([head, `journalctl -p warning ${base}`].join('\n'));
  if (target === 'agent' || target === 'ssh' || target === 'docker')
    return SH([head, `journalctl ${UNITS[target]} ${base}`].join('\n'));
  return null;
}

export interface LogsResult {
  lines: number;
  masked: number;
  truncated: boolean;
  matched: number | null;
  text: string;
}

/** Хвост журнала для модели: секреты и адреса скрыты, при `contains` остаются строки с этим словом, длина ограничена с конца. */
export function prepareLogs(stdout: string, contains?: string): LogsResult {
  let lines = stdout.replace(/\r/g, '').split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let matched: number | null = null;
  const needle = contains?.trim().toLowerCase();
  if (needle) {
    lines = lines.filter((l) => l.toLowerCase().includes(needle));
    matched = lines.length;
  }
  const joined = lines.join('\n');
  const truncated = joined.length > LOGS_CHARS;
  const tail = truncated ? joined.slice(-LOGS_CHARS) : joined;
  const { text, count } = maskSecrets(tail);
  return { lines: text ? text.split('\n').length : 0, masked: count, truncated, matched, text };
}

/** Журнал контейнера ноды за период (та же находка контейнера, что и у остальных действий панели). */
export function nodeLogsCommand(sinceMinutes: number | undefined, lines: number): string {
  const since = sinceMinutes ? ` --since ${clampInt(sinceMinutes, 1, LOGS_MINUTES_MAX, 60)}m` : '';
  const l = clampInt(lines, 10, LOGS_LINES_MAX, LOGS_LINES_DEFAULT);
  return SH(
    `# ns-inspect:node-logs\n${FIND_NODE}; [ -n "$N" ] || { echo "контейнер ноды не найден"; exit 3; }; docker logs${since} --tail ${l} "$N" 2>&1`,
  );
}
