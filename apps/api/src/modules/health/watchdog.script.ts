import { shellQuote } from '../servers/ssh.service.js';

/** Сторож панели на сервере парка: bash + curl и таймер systemd раз в минуту. */
export const WATCHDOG_FILES = {
  script: '/usr/local/bin/nodeservice-watchdog',
  env: '/etc/nodeservice-watchdog.env',
  service: '/etc/systemd/system/nodeservice-watchdog.service',
  timer: '/etc/systemd/system/nodeservice-watchdog.timer',
  state: '/var/lib/nodeservice-watchdog',
} as const;

export const WATCHDOG_INSTALL_LABEL = 'установка сторожа панели';
export const WATCHDOG_BUDGET_S = { run: 35, test: 35 } as const;
export const WATCHDOG_WAIT_MS = { install: 35_000, remove: 25_000, test: 50_000 } as const;

export interface WatchdogParams {
  url: string;
  serverName: string;
  timeZone: string;
  chats: Array<{ token: string; chatId: string; topic: number | null }>;
  proxy: string | null;
}

export function watchdogEnvFile(p: WatchdogParams): string {
  const chats = p.chats.map((c) => `${c.token}|${c.chatId}|${c.topic ?? ''}`).join(' ');
  const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, ' ').trim();
  return [
    '# Сторож панели NodeService: что проверять и куда писать. Только для root — здесь токены ботов Telegram.',
    `PANEL_URL=${shellQuote(p.url)}`,
    `SERVER_NAME=${shellQuote(oneLine(p.serverName))}`,
    `PANEL_TZ=${shellQuote(p.timeZone)}`,
    `DESTINATIONS=${shellQuote(chats)}`,
    `TG_PROXY=${shellQuote(p.proxy ?? '')}`,
    '',
  ].join('\n');
}

/**
 * Секреты curl получает через stdin, поэтому их нет в списке процессов. Файлы event.sent.N подтверждают
 * доставку отдельным чатам: после обрыва уже доставленное не дублируется, оставшееся отправляется снова.
 */
export const WATCHDOG_SCRIPT = `${[
  '#!/bin/bash',
  '# Сторож панели NodeService. Ставит и убирает его панель: «Настройки → Уведомления → Сторож панели».',
  'set -u',
  `ENV_FILE="\${NS_WATCHDOG_ENV:-${WATCHDOG_FILES.env}}"`,
  `STATE="\${NS_WATCHDOG_STATE:-${WATCHDOG_FILES.state}}"`,
  'PANEL_URL=""; SERVER_NAME=""; PANEL_TZ="UTC"; DESTINATIONS=""; TG_PROXY=""',
  '. "$ENV_FILE" || exit 1',
  'mkdir -p "$STATE" || exit 1',
  `RUN_BUDGET="\${NS_WATCHDOG_BUDGET:-${WATCHDOG_BUDGET_S.run}}"`,
  `if [ "\${1:-}" = test ]; then RUN_BUDGET="\${NS_WATCHDOG_BUDGET:-${WATCHDOG_BUDGET_S.test}}"; fi`,
  'STARTED=$(date +%s)',
  '',
  `now() { echo "\${NS_WATCHDOG_NOW:-$(date +%s)}"; }`,
  'left() { n=$(( STARTED + RUN_BUDGET - $(date +%s) )); [ "$n" -gt 0 ] || n=0; echo "$n"; }',
  'hhmm() { TZ="$PANEL_TZ" date -d "@$1" +%H:%M 2>/dev/null || TZ="$PANEL_TZ" date -r "$1" +%H:%M; }',
  'lasted() {',
  '  m=$(( ($1 + 30) / 60 ))',
  '  if [ "$m" -lt 1 ]; then echo "меньше минуты"',
  '  elif [ "$m" -lt 60 ]; then echo "$m мин"',
  '  elif [ $((m % 60)) -eq 0 ]; then echo "$((m / 60)) ч"',
  '  else echo "$((m / 60)) ч $((m % 60)) мин"; fi',
  '}',
  '',
  '# 0 — Telegram принял; 1 — ответил отказом; 2 — соединения нет или общий предел исчерпан.',
  'tg_one() {',
  '  remain=$(left); [ "$remain" -gt 0 ] || return 2',
  '  wait=15; [ "$remain" -lt "$wait" ] && wait="$remain"',
  '  cfg="url = https://api.telegram.org/bot$1/sendRichMessage"',
  '  [ -n "$5" ] && cfg="$cfg',
  'proxy = $5"',
  '  rich_message=$(rich_from_html "$4")',
  '  args=(-sS -m "$wait" --connect-timeout "$wait" -o "$STATE/tg.out" -w "%{http_code}" -K - --data-urlencode "chat_id=$2" --data-urlencode "rich_message=$rich_message")',
  '  [ -n "$3" ] && args+=(--data-urlencode "message_thread_id=$3")',
  '  code=$(printf "%s\\n" "$cfg" | curl "$' + '{args[@]}" 2>/dev/null) || return 2',
  '  [ "$code" = 200 ] && grep -q \'"ok":true\' "$STATE/tg.out" && return 0',
  '  # Bot API ещё не знает rich messages или отверг схему: тревога всё равно должна дойти.',
  '  case "$code" in 400|404) ;; *) return 1 ;; esac',
  '  cfg="url = https://api.telegram.org/bot$1/sendMessage"',
  '  [ -n "$5" ] && cfg="$cfg',
  'proxy = $5"',
  '  args=(-sS -m "$wait" --connect-timeout "$wait" -o "$STATE/tg.out" -w "%{http_code}" -K - --data-urlencode "chat_id=$2" --data-urlencode "text=$4" --data-urlencode "parse_mode=HTML")',
  '  [ -n "$3" ] && args+=(--data-urlencode "message_thread_id=$3")',
  '  code=$(printf "%s\\n" "$cfg" | curl "$' + '{args[@]}" 2>/dev/null) || return 2',
  '  [ "$code" = 200 ] && grep -q \'"ok":true\' "$STATE/tg.out" && return 0',
  '  return 1',
  '}',
  'html() { printf "%s" "$1" | sed "s/&/\\&amp;/g; s/</\\&lt;/g; s/>/\\&gt;/g"; }',
  String.raw`json() { printf "%s" "$1" | awk 'BEGIN { ORS="" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); if (NR > 1) printf "\\n"; printf "%s", $0 }'; }`,
  'rich_from_html() {',
  '  plain=$(printf "%s" "$1" | sed -e "s/<[^>]*>//g" -e "s/&amp;/\\&/g" -e "s/&lt;/</g" -e "s/&gt;/>/g")',
  '  title=$(printf "%s" "$plain" | sed -n "1p"); body=$(printf "%s" "$plain" | sed "1d"); [ -n "$body" ] || body="NodeService"',
  '  printf \'{"blocks":[{"type":"heading","size":3,"text":"%s"},{"type":"paragraph","text":"%s"}],"skip_entity_detection":true}\' "$(json "$title")" "$(json "$body")"',
  '}',
  '',
  'send() {',
  '  kind="$1"; text="$2"; i=0; all=0; proxy_down=0; direct_down=0',
  '  for chat in $DESTINATIONS; do',
  '    i=$((i + 1)); ack="$STATE/$kind.sent.$i"',
  '    [ -e "$ack" ] && continue',
  `    token="\${chat%%|*}"; rest="\${chat#*|}"; id="\${rest%%|*}"; topic="\${rest#*|}"`,
  '    r=2',
  '    if [ -n "$TG_PROXY" ] && [ "$proxy_down" -eq 0 ]; then',
  '      tg_one "$token" "$id" "$topic" "$text" "$TG_PROXY"; r=$?',
  '      [ "$r" -eq 2 ] && proxy_down=1',
  '    fi',
  '    if [ "$r" -eq 2 ] && [ "$direct_down" -eq 0 ]; then',
  '      tg_one "$token" "$id" "$topic" "$text" ""; r=$?',
  '      [ "$r" -eq 2 ] && direct_down=1',
  '    fi',
  '    if [ "$r" -eq 0 ]; then : > "$ack"; else all=1; fi',
  '  done',
  '  [ "$all" -eq 0 ] || return 1',
  '  rm -f "$STATE/$kind.sent."*',
  '  return 0',
  '}',
  '',
  'probe() {',
  '  SEEN=""',
  '  code=$(curl -sS -m 10 -o "$STATE/body" -w "%{http_code}" "$PANEL_URL" 2>/dev/null)',
  '  rc=$?',
  '  [ "$rc" -eq 0 ] && [ "$code" = 200 ] && return 0',
  '  case "$rc" in',
  '    0)',
  '      case "$code" in',
  '        503)',
  '          d=$(sed -n \'s/.*"detail":"\\([^"]*\\)".*/\\1/p\' "$STATE/body" 2>/dev/null | head -n 1)',
  `          SEEN="ошибка 503\${d:+: $d}" ;;`,
  '        502|504) SEEN="ошибка $code: сервер панели отвечает, а сама панель — нет" ;;',
  '        *) SEEN="ошибка $code" ;;',
  '      esac ;;',
  '    6) SEEN="нет ответа: адрес панели не находится" ;;',
  '    7) SEEN="нет ответа: не удаётся подключиться" ;;',
  '    28) SEEN="нет ответа за 10 с" ;;',
  '    35|51|58|60) SEEN="нет ответа: не устанавливается защищённое соединение" ;;',
  '    *) SEEN="нет ответа" ;;',
  '  esac',
  '  return 1',
  '}',
  '',
  `if [ "\${1:-}" = test ]; then`,
  '  if probe; then echo "@@panel=ok"; else echo "@@panel=$SEEN"; fi',
  '  if send test "✅ <b>Сторож панели NodeService работает</b>',
  '',
  'Сервер: <b>$(html "$SERVER_NAME")</b>',
  '',
  '<i>Если панель перестанет отвечать, сторож напишет сюда независимо от неё.</i>"; then echo "@@sent=1"; else echo "@@sent=0"; fi',
  '  exit 0',
  'fi',
  '',
  'fails=$(cat "$STATE/fails" 2>/dev/null)',
  'case "$fails" in ""|*[!0-9]*) fails=0 ;; esac',
  'if probe; then',
  '  if [ -e "$STATE/alerted" ]; then',
  '    [ -e "$STATE/recovered" ] || now > "$STATE/recovered"',
  '    if [ ! -e "$STATE/alert.done" ]; then',
  '      alert=$(cat "$STATE/alert.message" 2>/dev/null)',
  '      [ -n "$alert" ] && send alert "$alert" && : > "$STATE/alert.done"',
  '    fi',
  '    if [ -e "$STATE/alert.done" ]; then',
  '      since=$(cat "$STATE/since" 2>/dev/null); recovered=$(cat "$STATE/recovered" 2>/dev/null)',
  '      case "$since" in ""|*[!0-9]*) since="$recovered" ;; esac',
  '      case "$recovered" in ""|*[!0-9]*) recovered=$(now) ;; esac',
  '      if send recovery "✅ <b>Панель снова отвечает</b>',
  '',
  'Не отвечала: <b>$(lasted $(( recovered - since )))</b>."; then',
  '        rm -f "$STATE/fails" "$STATE/since" "$STATE/alerted" "$STATE/alert.done" "$STATE/alert.message" "$STATE/recovered"',
  '      fi',
  '    fi',
  '  else',
  '    rm -f "$STATE/fails" "$STATE/since"',
  '  fi',
  '  exit 0',
  'fi',
  'fails=$((fails + 1))',
  'echo "$fails" > "$STATE/fails"',
  '[ "$fails" -eq 1 ] && now > "$STATE/since"',
  'if [ "$fails" -ge 3 ]; then',
  '  since=$(cat "$STATE/since" 2>/dev/null)',
  '  case "$since" in ""|*[!0-9]*) since=$(now) ;; esac',
  '  if [ ! -e "$STATE/alerted" ]; then',
  '    printf "%s" "🔴 <b>Панель NodeService не отвечает</b>',
  '',
  'С <b>$(hhmm "$since")</b>: $(html "$SEEN").',
  '',
  '<i>Независимый сторож: $(html "$SERVER_NAME")</i>" > "$STATE/alert.message"',
  '    : > "$STATE/alerted"',
  '  fi',
  '  if [ ! -e "$STATE/alert.done" ]; then',
  '    alert=$(cat "$STATE/alert.message" 2>/dev/null)',
  '    [ -n "$alert" ] && send alert "$alert" && : > "$STATE/alert.done"',
  '  fi',
  'fi',
  'exit 0',
].join('\n')}\n`;

export const WATCHDOG_SERVICE_UNIT = `${[
  '[Unit]',
  'Description=Сторож панели NodeService',
  'After=network-online.target',
  'Wants=network-online.target',
  '',
  '[Service]',
  'Type=oneshot',
  `ExecStart=${WATCHDOG_FILES.script}`,
  `TimeoutStartSec=${WATCHDOG_BUDGET_S.run + 5}`,
].join('\n')}\n`;

const TIMER_UNIT = `${[
  '[Unit]',
  'Description=Сторож панели NodeService: проверка раз в минуту',
  '',
  '[Timer]',
  'OnBootSec=1min',
  'OnUnitActiveSec=1min',
  'AccuracySec=5s',
  '',
  '[Install]',
  'WantedBy=timers.target',
].join('\n')}\n`;

const fail = (why: string, code: number) => `{ echo "@@error=${why}"; exit ${code}; }`;
const writeNew = (content: string, path: string, mode: string) =>
  `printf '%s' ${shellQuote(content)} > "$R${path}.new" && chmod ${mode} "$R${path}.new" || write_failed`;

/** Токены приходят по stdin; все четыре файла полностью записываются до замены работающей версии. */
export const WATCHDOG_INSTALL_COMMAND = [
  '# ns-watchdog:install',
  `R="\${NS_WATCHDOG_ROOT:-}"`,
  `command -v systemctl >/dev/null 2>&1 || ${fail('Сервер не поддерживает службы по расписанию — сторожа на нём не поставить. Выберите другой сервер.', 3)}`,
  `command -v curl >/dev/null 2>&1 || ${fail('На сервере нет программы для сетевых проверок. Установите её или выберите другой сервер.', 3)}`,
  `command -v bash >/dev/null 2>&1 || ${fail('На сервере нет нужной командной оболочки. Установите её или выберите другой сервер.', 3)}`,
  'umask 077',
  `mkdir -p "$R/etc/systemd/system" "$R/usr/local/bin" "$R${WATCHDOG_FILES.state}" || ${fail('Не удалось создать папки сторожа на сервере.', 4)}`,
  `cleanup_new() { rm -f "$R${WATCHDOG_FILES.env}.new" "$R${WATCHDOG_FILES.script}.new" "$R${WATCHDOG_FILES.service}.new" "$R${WATCHDOG_FILES.timer}.new"; }`,
  `write_failed() { cleanup_new; ${fail('Не удалось записать файлы сторожа на сервер. Проверьте, что на диске есть место.', 4)}; }`,
  `cat > "$R${WATCHDOG_FILES.env}.new" && chmod 600 "$R${WATCHDOG_FILES.env}.new" || write_failed`,
  writeNew(WATCHDOG_SCRIPT, WATCHDOG_FILES.script, '755'),
  writeNew(WATCHDOG_SERVICE_UNIT, WATCHDOG_FILES.service, '644'),
  writeNew(TIMER_UNIT, WATCHDOG_FILES.timer, '644'),
  `mv "$R${WATCHDOG_FILES.script}.new" "$R${WATCHDOG_FILES.script}" && mv "$R${WATCHDOG_FILES.service}.new" "$R${WATCHDOG_FILES.service}" && mv "$R${WATCHDOG_FILES.timer}.new" "$R${WATCHDOG_FILES.timer}" && mv "$R${WATCHDOG_FILES.env}.new" "$R${WATCHDOG_FILES.env}" || write_failed`,
  'if ! systemctl daemon-reload >/dev/null 2>&1 || ! systemctl enable --now nodeservice-watchdog.timer >/dev/null 2>&1; then',
  '  systemctl disable --now nodeservice-watchdog.timer >/dev/null 2>&1',
  `  rm -f "$R${WATCHDOG_FILES.timer}" "$R${WATCHDOG_FILES.service}" "$R${WATCHDOG_FILES.script}" "$R${WATCHDOG_FILES.env}"`,
  `  rm -rf "$R${WATCHDOG_FILES.state}"`,
  '  systemctl daemon-reload >/dev/null 2>&1',
  '  echo "@@removed=1"',
  `  ${fail('Таймер сторожа не запустился. Всё, что успело записаться, с сервера убрано.', 5)}`,
  'fi',
  'echo "@@installed=1"',
].join('\n');

/** Совместимость со старым вызовом: секретов в команде больше нет. */
export function watchdogInstallCommand(_p: WatchdogParams): string {
  return WATCHDOG_INSTALL_COMMAND;
}

export const WATCHDOG_REMOVE_COMMAND = [
  '# ns-watchdog:remove',
  `R="\${NS_WATCHDOG_ROOT:-}"`,
  'systemctl disable --now nodeservice-watchdog.timer >/dev/null 2>&1',
  `rm -f "$R${WATCHDOG_FILES.timer}" "$R${WATCHDOG_FILES.service}" "$R${WATCHDOG_FILES.script}" "$R${WATCHDOG_FILES.env}"`,
  `rm -rf "$R${WATCHDOG_FILES.state}"`,
  'systemctl daemon-reload >/dev/null 2>&1',
  'echo "@@removed=1"',
].join('\n');

export const WATCHDOG_TEST_COMMAND = [
  '# ns-watchdog:test',
  `R="\${NS_WATCHDOG_ROOT:-}"`,
  `[ -x "$R${WATCHDOG_FILES.script}" ] || { echo "@@missing=1"; exit 3; }`,
  'systemctl is-active --quiet nodeservice-watchdog.timer >/dev/null 2>&1 || { echo "@@timer=0"; exit 4; }',
  `"$R${WATCHDOG_FILES.script}" test`,
].join('\n');

export function parseWatchdogOutput(out: string): Record<string, string> {
  const res: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const m = /^@@([a-z]+)=(.*)$/.exec(line.trim());
    if (m?.[1]) res[m[1]] = m[2] ?? '';
  }
  return res;
}
