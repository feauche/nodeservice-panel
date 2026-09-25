import type { ActionKey, IncidentKind } from '@nodeservice/shared';

/** Имя контейнера ноды в переменную $N (см. NODE_FIND в исполнителе). */
export const FIND_NODE =
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

/**
 * Обёртка `sh -c '…'`. Одинарные кавычки внутри тела экранируем: без этого строка рвётся и шелл
 * получает мусор (код возврата 127 «команда не найдена»).
 */
export const SH = (body: string) => `sh -c '${body.replace(/'/g, "'\\''")}'`;

export const ACTION_SPECS: Partial<Record<ActionKey, ActionSpec>> = {
  free_disk: {
    // Только журнал, «висячие» образы и кэш сборки. НЕ `docker system prune`: он удаляет и остановленные
    // контейнеры — а остановленный контейнер ноды это ровно тот случай, когда его нужно поднять, а не стереть.
    command: SH(
      'journalctl --vacuum-size=200M 2>&1; docker image prune -f 2>&1; docker builder prune -f 2>&1; true',
    ),
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
  /** Осмотр (T0): только чтение — где лежат гигабайты. Ничего не удаляет. */
  /**
   * Чистка временных каталогов (T2, с подтверждением). Только /tmp и /var/tmp, только файлы старше
   * часа — то, что создаётся прямо сейчас, не трогаем. Сокеты и каталоги остаются на месте.
   */
  tmp_clean: {
    // awk — в одинарных кавычках, иначе внутренний sh подставит вместо $4 пустой параметр.
    command: SH(
      "before=$(df -P / | awk 'NR==2{print $4}'); " +
        // Только крупные (> 10 МБ) файлы старше часа: мелкие pid/lock/сокеты живых сервисов не трогаем,
        // места они не освобождают. Каталоги остаются на месте.
        'find /tmp /var/tmp -xdev -mindepth 1 -type f -size +10M -mmin +60 -delete 2>/dev/null; ' +
        "after=$(df -P / | awk 'NR==2{print $4}'); " +
        'echo "Освобождено: $(( (after - before) / 1024 )) МБ"; true',
    ),
    precheck: ['ssh_ok', 'no_other_action'],
    postcheck: { kind: 'metric_below', metric: 'disk', marginPct: 5, samples: 1 },
  },
  disk_inspect: {
    command: SH(
      'echo "== Самые тяжёлые каталоги =="; du -xh / --max-depth=2 2>/dev/null | sort -h | tail -20; ' +
        'echo; echo "== Файлы больше 200 МБ =="; ' +
        'timeout -k 5 60 find / -xdev -type f -size +200M -exec du -h {} + 2>/dev/null | sort -h | tail -20; ' +
        'echo; echo "== Что удалит очистка временных файлов (крупнее 10 МБ, старше часа) =="; ' +
        'timeout -k 5 30 find /tmp /var/tmp -xdev -type f -mmin +60 -size +10M -exec du -h {} + 2>/dev/null | sort -h | tail -15; ' +
        "find /tmp /var/tmp -xdev -type f -mmin +60 -size +10M -printf '%s\\n' 2>/dev/null | " +
        'awk \'{s+=$1} END {printf "Временных файлов старше часа: %.1f ГБ\\n", s/1073741824}\'; ' +
        'true',
    ),
    precheck: ['ssh_ok'],
    postcheck: { kind: 'none' },
  },
  node_up: {
    command: SH(
      `${FIND_NODE}; [ -n "$N" ] || { echo "контейнер ноды не найден"; exit 3; }; docker start "$N" 2>&1`,
    ),
    precheck: ['ssh_ok', 'no_other_action'],
    postcheck: { kind: 'node_up' },
  },
  restart_node: {
    command: SH(
      `${FIND_NODE}; [ -n "$N" ] || { echo "контейнер ноды не найден"; exit 3; }; docker restart "$N" 2>&1`,
    ),
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
