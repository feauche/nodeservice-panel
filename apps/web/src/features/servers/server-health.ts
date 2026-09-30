import type { AgentStatus, OverviewServerMetrics, Server } from '@nodeservice/shared';
import { formatPct } from '@/features/overview/overview-format';

/** Одно слово о сервере для точки статуса, фильтра и цвета спарклайна. */
export type ServerHealth = 'ok' | 'warn' | 'crit';

/**
 * Подпись уровня — для сегмента фильтра и точки там, где причина написана рядом или назвать её негде
 * (строка списка, окно сервера, имя сервера в чате). «Сбой», а не «Офлайн»: на этом уровне либо с сервером
 * нет связи (выключен ли он, панель не знает), либо сервер на связи, но на нём не работает нода.
 */
export const HEALTH_LABELS: Record<ServerHealth, string> = {
  ok: 'В норме',
  warn: 'Требует внимания',
  crit: 'Сбой',
};

/** Цвет линии спарклайна и точки статуса (CSS-переменные темы). */
export const HEALTH_COLORS: Record<ServerHealth, string> = {
  ok: 'var(--ns-ok)',
  warn: 'var(--ns-warn)',
  crit: 'var(--ns-crit)',
};

export const CPU_WARN_PCT = 85;
export const MEM_WARN_PCT = 90;
export const DISK_WARN_PCT = 90;

/** Уровень, причина словами и о чём она — всё из одного правила, чтобы разделы не расходились. */
export interface ServerState {
  health: ServerHealth;
  /** Что не так — одной короткой фразой; у здорового сервера — null. */
  reason: string | null;
  /**
   * О чём причина: связь (агент и SSH), нода или нагрузка. По этому «Обзор» не показывает одно и то же
   * дважды — строкой сервера и делом.
   */
  about: 'link' | 'node' | 'load' | null;
}

type SilentAgent = Exclude<AgentStatus, 'online'>;

/** Агент не на связи — отдельной причиной, пока сервер отвечает по SSH. */
const AGENT_REASON: Record<SilentAgent, string> = {
  offline: 'Агент не на связи',
  not_installed: 'Агент не установлен',
  installing: 'Агент устанавливается',
  pending: 'Ожидает агента',
};

/**
 * То же — продолжением фразы «Недоступен: SSH не пускает, …». Короче, чем отдельной причиной, чтобы фраза
 * помещалась в колонку «Состояние» списка; не поместится — целиком она в подсказке ячейки.
 */
const AGENT_SILENT: Record<SilentAgent, string> = {
  offline: 'агент молчит',
  not_installed: 'агента нет',
  installing: 'агент устанавливается',
  pending: 'агент молчит',
};

/**
 * Нода не работает — теми же словами, что пилюля на карточке, и по тому же правилу, что детекция
 * инцидентов: «остановлена» — всегда, «не найдена» — только когда нода на сервере должна быть;
 * слежение выключено — не судим.
 */
export function nodeProblem(server: Server): string | null {
  if (server.nodeWatch === 'off') return null;
  if (server.node === 'stopped') return 'Нода остановлена';
  if (server.node === 'none' && server.nodeWatch === 'on') return 'Нода не найдена';
  return null;
}

/**
 * Состояние сервера — по тому же правилу, что детекция инцидентов (решение владельца 29.09.2026).
 * Признаков связи два: агент на связи и последняя проверка SSH. «Недоступен» — только когда не осталось
 * ни одного: SSH не пустил, а агент молчит (или его нет: тогда SSH — единственный способ узнать, что
 * сервер жив). Один признак из двух — сервер работает: это «внимание» с названной причиной. Остановленная
 * нода — тоже сбой: сервер отвечает, но клиентов не обслуживает. Про недоступный сервер ноду не называем:
 * что с ней сейчас, панель не видит.
 */
export function serverState(server: Server, metrics?: OverviewServerMetrics | null): ServerState {
  const agent = server.agentStatus;
  const sshFailed = server.sshOk === false;
  if (agent !== 'online' && sshFailed)
    return { health: 'crit', about: 'link', reason: `Недоступен: SSH не пускает, ${AGENT_SILENT[agent]}` };
  const node = nodeProblem(server);
  if (node) return { health: 'crit', about: 'node', reason: node };
  if (sshFailed) return { health: 'warn', about: 'link', reason: 'SSH не пускает' };
  if (agent !== 'online') return { health: 'warn', about: 'link', reason: AGENT_REASON[agent] };
  if (server.sshOk === null) return { health: 'warn', about: 'link', reason: 'SSH не проверен' };
  if (metrics) {
    if ((metrics.cpuPct ?? 0) >= CPU_WARN_PCT)
      return { health: 'warn', about: 'load', reason: `CPU ${formatPct(metrics.cpuPct)}%` };
    if ((metrics.memPct ?? 0) >= MEM_WARN_PCT)
      return { health: 'warn', about: 'load', reason: `Память ${formatPct(metrics.memPct)}%` };
    if ((metrics.diskPct ?? 0) >= DISK_WARN_PCT)
      return { health: 'warn', about: 'load', reason: `Диск ${formatPct(metrics.diskPct)}%` };
  }
  return { health: 'ok', about: null, reason: null };
}

/** Только уровень — для точки, фильтра и подсчётов. */
export function serverHealth(server: Server, metrics?: OverviewServerMetrics | null): ServerHealth {
  return serverState(server, metrics).health;
}
