import type { MaintenanceCheck, MaintenanceKind } from '@nodeservice/shared';

/**
 * Скрипты обслуживания: выполняются по SSH от root на Debian/Ubuntu через login-shell (sh/bash),
 * всё неинтерактивно (DEBIAN_FRONTEND, confold — конфиги не трогаем), без dist-upgrade и без
 * удаления пакетов. Маркер `# ns-maint:<kind>[:<step>]` в первой строке — по нему тестовый sshd
 * и логи узнают команду. Длинные apt-команды обёрнуты в серверный `timeout`: если панель
 * оборвёт SSH по своему (чуть большему) таймауту, apt/dpkg уже получат сигнал и закроют
 * транзакцию, а не останутся сиротами.
 */

const ENV = 'export DEBIAN_FRONTEND=noninteractive LC_ALL=C LANG=C';
/** Ждём чужую блокировку apt (unattended-upgrades, apt-daily) до 3 минут, а не падаем сразу. */
const APT_LOCK = '-o DPkg::Lock::Timeout=180';
const APT_OPTS = `${APT_LOCK} -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold`;

/** Серверные таймауты шагов (секунды): чуть меньше панельных, чтобы команда завершилась сама. */
const T_UPDATE = 5 * 60;
const T_UPGRADE = 22 * 60;
const T_CLEANUP = 8 * 60;
const T_INSTALL = 4 * 60;

/** Панельные таймауты по видам (мс): apt upgrade может идти долго, проверка — нет. */
export const MAINTENANCE_TIMEOUT_MS: Record<MaintenanceKind, number> = {
  check: 4 * 60_000,
  apt_upgrade: 25 * 60_000,
  agent_update: 3 * 60_000,
  cleanup: 10 * 60_000,
  unattended_enable: 6 * 60_000,
};

/** `timeout -k 30 N cmd…`: по истечении — TERM, через 30 с — KILL. */
const withTimeout = (sec: number, cmd: string) => `timeout -k 30 ${sec} ${cmd}`;

/**
 * Проверка (T0): ничего не меняет, кроме `apt-get update` (обновляет только индекс пакетов).
 * Печатает строки `@@ключ=значение`, разбирает parseCheckOutput().
 */
export function checkScript(): string {
  return [
    '# ns-maint:check',
    ENV,
    'if command -v apt-get >/dev/null 2>&1; then',
    '  echo "@@apt=1"',
    `  if ${withTimeout(T_UPDATE, `apt-get ${APT_LOCK} update -qq`)} >/dev/null 2>&1; then echo "@@apt_update=ok"; else echo "@@apt_update=failed"; fi`,
    '  SIM="$(apt-get -s --with-new-pkgs upgrade 2>/dev/null | grep "^Inst ")"',
    '  echo "@@updates=$(printf "%s\\n" "$SIM" | grep -c "^Inst ")"',
    '  echo "@@security=$(printf "%s\\n" "$SIM" | grep -c -- "-security")"',
    '  echo "@@dpkg_broken=$(dpkg --audit 2>/dev/null | grep -c "^ ")"',
    '  if dpkg -s unattended-upgrades >/dev/null 2>&1 && apt-config dump 2>/dev/null | grep -q \'APT::Periodic::Unattended-Upgrade "1"\'; then echo "@@unattended=1"; else echo "@@unattended=0"; fi',
    'else',
    '  echo "@@apt=0"',
    'fi',
    'if [ -f /var/run/reboot-required ]; then echo "@@reboot=1"; else echo "@@reboot=0"; fi',
    'echo "@@kernel_running=$(uname -r 2>/dev/null)"',
    'echo "@@kernel_installed=$(ls -1 /boot/vmlinuz-* 2>/dev/null | sed "s#.*/vmlinuz-##" | sort -V | tail -n 1)"',
    'echo "@@agent_version=$(/usr/local/bin/nodeservice-agent version 2>/dev/null | head -n 1)"',
    'echo "@@agent_service=$(systemctl is-active nodeservice-agent 2>/dev/null)"',
    'df -Pk / 2>/dev/null | awk \'NR==2{gsub("%","",$5); print "@@disk_pct=" $5; print "@@disk_free_mb=" int($4/1024)}\'',
    'echo "@@done=1"',
  ].join('\n');
}

/** Разбор `@@ключ=значение`; `latest` (версия агента на GitHub) подставляет сервис. */
export function parseCheckOutput(out: string, latestAgent: string | null): MaintenanceCheck {
  const get = (name: string): string | null => {
    const m = out.match(new RegExp(`^@@${name}=(.*)$`, 'm'));
    const v = m?.[1]?.trim();
    return v ? v : null;
  };
  // Нет строки — null, а не 0: «не узнали» и «ноль» для чек-листа разные вещи.
  const num = (name: string): number | null => {
    const raw = get(name);
    if (raw === null) return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  };
  const warnings: string[] = [];
  const supported = get('apt') === '1';
  if (!supported) warnings.push('Обновления через apt недоступны: система не Debian/Ubuntu.');
  if (supported && get('apt_update') === 'failed')
    warnings.push('apt-get update не удался: список обновлений может быть неполным.');
  const broken = num('dpkg_broken');
  if (broken !== null && broken > 0)
    warnings.push(`Есть недонастроенные пакеты (${broken}): выполните dpkg --configure -a в терминале.`);
  const updatesTotal = num('updates');
  const security = num('security');
  const rebootRaw = get('reboot');
  const service = get('agent_service');
  return {
    checkedAt: new Date().toISOString(),
    supported,
    updates: supported && updatesTotal !== null ? { total: updatesTotal, security: security ?? 0 } : null,
    rebootRequired: rebootRaw === null ? null : rebootRaw === '1',
    kernel: { running: get('kernel_running'), installed: get('kernel_installed') },
    unattended: supported ? get('unattended') === '1' : null,
    agent: { installed: get('agent_version'), latest: latestAgent, service: service ?? 'missing' },
    disk: { usedPct: num('disk_pct'), freeMb: num('disk_free_mb') },
    warnings,
  };
}

export interface StepSpec {
  key: string;
  label: string;
  command: string;
}

/**
 * Шаги действий: каждый — отдельная SSH-команда, при ненулевом коде дальше не идём.
 * Шаг «Проверка после» добавляет сервис (общий для всех действий).
 */
export function actionSteps(kind: Exclude<MaintenanceKind, 'check'>, agentRepo: string): StepSpec[] {
  switch (kind) {
    case 'apt_upgrade':
      return [
        {
          key: 'update',
          label: 'Список пакетов',
          command: `# ns-maint:apt_upgrade:update\n${ENV}\n${withTimeout(T_UPDATE, `apt-get ${APT_LOCK} update`)}`,
        },
        {
          key: 'upgrade',
          label: 'Установка обновлений',
          command: `# ns-maint:apt_upgrade:upgrade\n${ENV}\n${withTimeout(T_UPGRADE, `apt-get -y --with-new-pkgs ${APT_OPTS} upgrade`)}`,
        },
      ];
    case 'cleanup':
      return [
        {
          key: 'autoremove',
          label: 'Ненужные пакеты и старые ядра',
          command: `# ns-maint:cleanup:autoremove\n${ENV}\n${withTimeout(T_CLEANUP, `apt-get -y ${APT_OPTS} autoremove --purge`)}`,
        },
        {
          key: 'clean',
          label: 'Кеш пакетов',
          command: `# ns-maint:cleanup:clean\n${ENV}\n${withTimeout(60, `apt-get ${APT_LOCK} clean`)}`,
        },
        {
          key: 'journal',
          label: 'Системный журнал до 200 МБ',
          command: '# ns-maint:cleanup:journal\njournalctl --vacuum-size=200M 2>&1 || true',
        },
      ];
    case 'unattended_enable':
      return [
        {
          key: 'install',
          label: 'Пакет unattended-upgrades',
          command: `# ns-maint:unattended_enable:install\n${ENV}\n${withTimeout(T_UPDATE, `apt-get ${APT_LOCK} update -qq`)} >/dev/null 2>&1 || true\n${withTimeout(T_INSTALL, `apt-get -y ${APT_OPTS} install unattended-upgrades`)}`,
        },
        {
          key: 'configure',
          label: 'Ежедневные обновления безопасности',
          command: [
            '# ns-maint:unattended_enable:configure',
            "cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'",
            'APT::Periodic::Update-Package-Lists "1";',
            'APT::Periodic::Unattended-Upgrade "1";',
            'EOF',
            'systemctl enable --now apt-daily.timer apt-daily-upgrade.timer 2>&1 || true',
            'echo "включено: по умолчанию ставятся только обновления безопасности, без автоперезагрузки"',
          ].join('\n'),
        },
      ];
    case 'agent_update':
      return [
        {
          key: 'download',
          label: 'Скачивание релиза и проверка суммы',
          command: [
            '# ns-maint:agent_update:download',
            'set -e',
            'case "$(uname -m)" in x86_64|amd64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo "архитектура $(uname -m) не поддерживается"; exit 1 ;; esac',
            `BASE="https://github.com/${agentRepo}/releases/latest/download"`,
            'FILE="nodeservice-agent_linux_$ARCH"',
            // NS_TMP/NS_BIN переопределяются только в тестах (реальный шелл, временная папка).
            'DIR="${NS_TMP:-/tmp}/ns-agent-update"',
            'rm -rf "$DIR" && mkdir -p "$DIR" && cd "$DIR"',
            'curl -fsSL --max-time 120 -o "$FILE" "$BASE/$FILE"',
            'curl -fsSL --max-time 60 -o checksums.txt "$BASE/checksums.txt"',
            'grep " $FILE$" checksums.txt | sha256sum -c -',
            'chmod 0755 "$FILE"',
            // Бинарь должен хотя бы запускаться: иначе службу не трогаем.
            'echo "новая версия: $("./$FILE" version)"',
          ].join('\n'),
        },
        {
          key: 'install',
          label: 'Замена бинаря и перезапуск',
          command: [
            '# ns-maint:agent_update:install',
            'set -e',
            'case "$(uname -m)" in x86_64|amd64) ARCH=amd64 ;; *) ARCH=arm64 ;; esac',
            'DIR="${NS_TMP:-/tmp}/ns-agent-update"',
            'NEW="$DIR/nodeservice-agent_linux_$ARCH"',
            'BIN="${NS_BIN:-/usr/local/bin/nodeservice-agent}"',
            '[ -x "$NEW" ] || { echo "нет скачанного бинаря $NEW"; exit 1; }',
            // Старый агент работает до самого rename: копия рядом, потом атомарная замена.
            'cp "$NEW" "$BIN.new" && chmod 0755 "$BIN.new" && mv -f "$BIN.new" "$BIN"',
            'rm -rf "$DIR"',
            'systemctl restart nodeservice-agent',
            'sleep 2',
            'systemctl is-active nodeservice-agent >/dev/null',
            'echo "агент: $("$BIN" version) · $(systemctl is-active nodeservice-agent)"',
          ].join('\n'),
        },
      ];
  }
}
