import type { ActionKey, IncidentKind } from '@nodeservice/shared';

/** Имя контейнера ноды в переменную $N (см. NODE_FIND в исполнителе). */
const FIND_NODE =
  "N=$(docker ps -a --format '{{.Names}}|{{.Image}}' 2>/dev/null | awk -F'|' 'tolower($1) ~ /remna/ || tolower($2) ~ /remnawave\\/node/ {print $1; exit}')";

/**
 * Что именно делает каждое действие реестра — ТОЛЬКО здесь (никаких shell-строк из БД).
 * `command` выполняется по SSH ключом панели; `special` — не shell, а вызов сервиса панели.
 * `precheck` — какие условия проверяются перед запуском; `postcheck` — как понимаем, что помогло.
 */
export type Precheck = 'agent_online' | 'disk_not_full' | 'ssh_ok' | 'no_other_action';
export type Postcheck =
  | { kind: 'metric_below'; metric: 'cpu' | 'mem' | 'disk'; marginPct: number; samples: number }
  | { kind: 'agent_online' }
  | { kind: 'node_up' }
  | { kind: 'none' };

export interface ActionSpec {
  command?: string;
  special?: 'agent_reinstall';
  /** Проверка контейнера после действия (docker inspect), если действие про контейнер. */
  containerCheck?: string;
  precheck: Precheck[];
  postcheck: Postcheck;
  /** Команда отката, если действие обратимо иначе как повтором. Нет — шаг «откат» пропускается. */
  rollback?: string;
}

const SH = (body: string) => `sh -c '${body}'`;

export const ACTION_SPECS: Partial<Record<ActionKey, ActionSpec>> = {
  free_disk: {
    command: SH('journalctl --vacuum-size=200M 2>&1; docker system prune -f 2>&1; true'),
    precheck: ['agent_online', 'disk_not_full', 'no_other_action'],
    postcheck: { kind: 'metric_below', metric: 'disk', marginPct: 5, samples: 1 },
  },
  apt_clean: {
    command: SH(
      'export DEBIAN_FRONTEND=noninteractive; apt-get -o DPkg::Lock::Timeout=120 clean 2>&1; apt-get -y -o DPkg::Lock::Timeout=120 autoremove --purge 2>&1; true',
    ),
    precheck: ['agent_online', 'disk_not_full', 'no_other_action'],
    postcheck: { kind: 'metric_below', metric: 'disk', marginPct: 5, samples: 1 },
  },
  node_up: {
    command: `sh -c '${FIND_NODE.replace(/'/g, "'\\''")}; [ -n "$N" ] || { echo "контейнер ноды не найден"; exit 3; }; docker start "$N" 2>&1'`,
    precheck: ['ssh_ok', 'no_other_action'],
    postcheck: { kind: 'node_up' },
  },
  node_logs: {
    // T0: только читаем; результат — в лог попытки, инцидент не меняется.
    command: `sh -c '${FIND_NODE.replace(/'/g, "'\\''")}; [ -n "$N" ] || { echo "контейнер ноды не найден"; exit 3; }; timeout -k 5 30 docker logs --tail 100 "$N" 2>&1 || true'`,
    precheck: ['ssh_ok'],
    postcheck: { kind: 'none' },
  },
  restart_node: {
    command: `sh -c '${FIND_NODE.replace(/'/g, "'\\''")}; [ -n "$N" ] || { echo "контейнер ноды не найден"; exit 3; }; docker restart "$N" 2>&1'`,
    containerCheck: `${FIND_NODE}; docker inspect -f '{{.State.Running}}' "$N" 2>/dev/null`,
    precheck: ['agent_online', 'no_other_action'],
    // Метрика выбирается по виду инцидента (cpu_high → cpu, mem_high → mem) в исполнителе.
    postcheck: { kind: 'metric_below', metric: 'cpu', marginPct: 10, samples: 3 },
  },
  agent_reinstall: {
    special: 'agent_reinstall',
    precheck: ['ssh_ok', 'no_other_action'],
    postcheck: { kind: 'agent_online' },
  },
};

/** Метрика пост-проверки по виду инцидента, когда действие подходит нескольким видам. */
export function postcheckMetricFor(kind: IncidentKind): 'cpu' | 'mem' | 'disk' {
  return kind === 'mem_high' ? 'mem' : kind === 'disk_high' ? 'disk' : 'cpu';
}
