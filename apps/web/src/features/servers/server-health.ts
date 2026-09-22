import type { OverviewServerMetrics, Server } from '@nodeservice/shared';

/** Одно слово о сервере для точки статуса, фильтра и цвета спарклайна. */
export type ServerHealth = 'ok' | 'warn' | 'crit';

export const HEALTH_LABELS: Record<ServerHealth, string> = {
  ok: 'В норме',
  warn: 'Требует внимания',
  crit: 'Офлайн',
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

/**
 * Офлайн — SSH не отвечает или агент пропал со связи.
 * Внимание — агент ещё не поставлен/не подключился, SSH не проверяли, либо ресурсы на пределе.
 * Иначе — в норме.
 */
export function serverHealth(server: Server, metrics?: OverviewServerMetrics | null): ServerHealth {
  if (server.sshOk === false || server.agentStatus === 'offline') return 'crit';
  if (server.agentStatus !== 'online' || server.sshOk === null) return 'warn';
  if (metrics) {
    if ((metrics.cpuPct ?? 0) >= CPU_WARN_PCT) return 'warn';
    if ((metrics.memPct ?? 0) >= MEM_WARN_PCT) return 'warn';
    if ((metrics.diskPct ?? 0) >= DISK_WARN_PCT) return 'warn';
  }
  return 'ok';
}
