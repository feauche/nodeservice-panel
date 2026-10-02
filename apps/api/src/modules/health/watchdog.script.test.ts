import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { shellQuote } from '../servers/ssh.service.js';
import {
  parseWatchdogOutput,
  WATCHDOG_BUDGET_S,
  WATCHDOG_INSTALL_COMMAND,
  WATCHDOG_REMOVE_COMMAND,
  WATCHDOG_SCRIPT,
  WATCHDOG_SERVICE_UNIT,
  WATCHDOG_TEST_COMMAND,
  WATCHDOG_WAIT_MS,
  type WatchdogParams,
  watchdogEnvFile,
} from './watchdog.script.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const TOKEN2 = '987654321:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const TOKEN3 = '555555555:CCHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const PARAMS: WatchdogParams = {
  url: 'https://panel.example.com/api/health/ready',
  serverName: "Германия-1 (Hetzner's)",
  timeZone: 'Asia/Omsk',
  chats: [{ token: TOKEN, chatId: '-1002946167407', topic: 8 }],
  proxy: null,
};
const THREE_CHATS: WatchdogParams['chats'] = [
  ...PARAMS.chats,
  { token: TOKEN2, chatId: '412345678', topic: null },
  { token: TOKEN3, chatId: '512345678', topic: null },
];
/** 1 октября 2026, 01:12 по Омску. */
const T0 = Date.UTC(2026, 8, 30, 19, 12) / 1000;
const min = (m: number) => String(T0 + m * 60);
const alert = (reason: string, at = '01:12') =>
  `🔴 <b>Панель NodeService не отвечает</b>\n\nС <b>${at}</b>: ${reason}.\n\n<i>Независимый сторож: Германия-1 (Hetzner's)</i>`;
const recovered = (duration = '8 мин') =>
  `✅ <b>Панель снова отвечает</b>\n\nНе отвечала: <b>${duration}</b>.`;
const testMessage =
  "✅ <b>Сторож панели NodeService работает</b>\n\nСервер: <b>Германия-1 (Hetzner's)</b>\n\n<i>Если панель перестанет отвечать, сторож напишет сюда независимо от неё.</i>";

/**
 * Подменённый curl: адрес панели отвечает тем, что лежит в $STUB_DIR (код выхода, код ответа, тело);
 * api.telegram.org — сообщение записывается файлом sent.N (и с какими параметрами пришло). Адрес и прокси
 * приходят, как у настоящего, либо аргументами, либо настройками на входе (-K -). Каждый вызов оставляет свои
 * аргументы в argv.log, каждая попытка до Telegram — строку в tg.log (через какой прокси). Прокси, помеченный
 * «недоступен», не соединяется (код 7), как и Telegram целиком при STUB_TG_DOWN. «Пакеты теряются»
 * (STUB_TG_HANG — напрямую, STUB_PROXY_HANG — через прокси, STUB_HANG_CHAT — один чат, STUB_PANEL_HANG —
 * панель): ждём, сколько позволено (-m, для соединения — не дольше --connect-timeout), и выходим с 28.
 */
const FAKE_CURL = [
  '#!/bin/sh',
  'printf "%s\\n" "$*" >> "$STUB_DIR/argv.log"',
  'out=""; url=""; text=""; rich=""; chat=""; topic=""; proxy=""; m=15; ct=""; cfg=""',
  'while [ $# -gt 0 ]; do',
  '  case "$1" in',
  '    -o) out="$2"; shift 2 ;;',
  '    -w) shift 2 ;;',
  '    -m) m="$2"; shift 2 ;;',
  '    --connect-timeout) ct="$2"; shift 2 ;;',
  '    -K) cfg="$2"; shift 2 ;;',
  '    --proxy) proxy="$2"; shift 2 ;;',
  '    --data-urlencode)',
  `      case "$2" in text=*) text="\${2#text=}" ;; rich_message=*) rich="\${2#rich_message=}" ;; chat_id=*) chat="\${2#chat_id=}" ;; message_thread_id=*) topic="\${2#message_thread_id=}" ;; esac`,
  '      shift 2 ;;',
  '    -*) shift ;;',
  '    *) url="$1"; shift ;;',
  '  esac',
  'done',
  'if [ "$cfg" = - ]; then',
  '  while IFS= read -r line; do',
  '    case "$line" in',
  `      "url = "*) url="\${line#url = }" ;;`,
  `      "proxy = "*) proxy="\${line#proxy = }" ;;`,
  '    esac',
  '  done',
  'fi',
  'hang() { s=$m; [ -n "$ct" ] && [ "$ct" -lt "$s" ] && s=$ct; sleep "$s"; printf 000; exit 28; }',
  'case "$url" in',
  '  https://api.telegram.org/*)',
  '    case "$url" in */sendRichMessage)',
  '      if [ -z "$STUB_RICH_OK" ]; then printf "%s" \'{"ok":false,"description":"method not found"}\' > "$out"; printf 404; exit 0; fi',
  '      text="$rich" ;;',
  '    esac',
  '    echo "proxy=$proxy" >> "$STUB_DIR/tg.log"',
  '    [ -n "$STUB_TG_DOWN" ] && { printf 000; exit 7; }',
  '    [ -n "$proxy" ] && [ "$proxy" = "$STUB_PROXY_DOWN" ] && { printf 000; exit 7; }',
  '    [ -n "$proxy" ] && [ "$proxy" = "$STUB_PROXY_HANG" ] && hang',
  '    [ -z "$proxy" ] && [ -n "$STUB_TG_HANG" ] && hang',
  '    [ -n "$STUB_HANG_CHAT" ] && [ "$chat" = "$STUB_HANG_CHAT" ] && hang',
  '    n=$(ls "$STUB_DIR" | grep -c "^sent\\.")',
  '    printf "%s" "$text" > "$STUB_DIR/sent.$n"',
  '    printf "chat=%s topic=%s proxy=%s url=%s" "$chat" "$topic" "$proxy" "$url" > "$STUB_DIR/meta.$n"',
  '    printf "%s" \'{"ok":true,"result":{"message_id":1}}\' > "$out"',
  '    printf 200 ;;',
  '  *)',
  '    echo "$url" > "$STUB_DIR/asked"',
  '    [ -n "$STUB_PANEL_HANG" ] && { sleep "$STUB_PANEL_HANG"; printf 000; exit 28; }',
  '    rc=$(cat "$STUB_DIR/panel.rc")',
  '    [ "$rc" = 0 ] || { printf 000; exit "$rc"; }',
  '    cat "$STUB_DIR/panel.body" > "$out"',
  '    cat "$STUB_DIR/panel.code" ;;',
  'esac',
].join('\n');

describe('сторож панели: скрипт на сервере парка (настоящий bash, подменённый curl)', {
  timeout: 30_000,
}, () => {
  let dir: string;
  let bin: string;
  let stub: string;
  let state: string;
  let envFile: string;
  let script: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ns-watchdog-'));
    bin = join(dir, 'bin');
    stub = join(dir, 'stub');
    state = join(dir, 'state');
    mkdirSync(bin);
    mkdirSync(stub);
    writeFileSync(join(bin, 'curl'), FAKE_CURL);
    chmodSync(join(bin, 'curl'), 0o755);
    envFile = join(dir, 'watchdog.env');
    writeFileSync(envFile, watchdogEnvFile(PARAMS));
    script = join(dir, 'nodeservice-watchdog');
    writeFileSync(script, WATCHDOG_SCRIPT);
    chmodSync(script, 0o755);
    panel('ok');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Что панель «ответит» сторожу. */
  function panel(kind: 'ok' | 'timeout' | 'refused' | '502' | { code: number; body: string }) {
    const set = (rc: number, code: string, body: string) => {
      writeFileSync(join(stub, 'panel.rc'), String(rc));
      writeFileSync(join(stub, 'panel.code'), code);
      writeFileSync(join(stub, 'panel.body'), body);
    };
    if (kind === 'ok') set(0, '200', '{"status":"ok"}');
    else if (kind === 'timeout') set(28, '000', '');
    else if (kind === 'refused') set(7, '000', '');
    else if (kind === '502') set(0, '502', '');
    else set(0, String(kind.code), kind.body);
  }

  const envOf = (at: string, env: Record<string, string>) => ({
    PATH: `${bin}:${process.env.PATH}`,
    NS_WATCHDOG_ENV: envFile,
    NS_WATCHDOG_STATE: state,
    NS_WATCHDOG_NOW: at,
    STUB_DIR: stub,
    ...env,
  });

  /** Один запуск таймера в момент `at` (секунды). */
  const run = (at: string, args: string[] = [], env: Record<string, string> = {}, path = script) =>
    spawnSync('/bin/bash', [path, ...args], { encoding: 'utf8', timeout: 20_000, env: envOf(at, env) });

  /**
   * Запуск, который обрывают через `ms` — как systemd по TimeoutStartSec: вся группа процессов (и bash, и
   * его curl) получает SIGTERM.
   */
  const runKilled = (at: string, ms: number, env: Record<string, string> = {}) =>
    new Promise<void>((resolve) => {
      const child = spawn('/bin/bash', [script], { detached: true, stdio: 'ignore', env: envOf(at, env) });
      const timer = setTimeout(() => {
        try {
          process.kill(-(child.pid ?? 0), 'SIGTERM');
        } catch {
          // уже завершился
        }
      }, ms);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });

  const sent = () =>
    readdirSync(stub)
      .filter((f) => f.startsWith('sent.'))
      .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
      .map((f) => readFileSync(join(stub, f), 'utf8'));
  const meta = (n: number) => readFileSync(join(stub, `meta.${n}`), 'utf8');
  /** Попытки достучаться до Telegram: «proxy=…» (пусто — напрямую). */
  const attempts = () =>
    existsSync(join(stub, 'tg.log')) ? readFileSync(join(stub, 'tg.log'), 'utf8').trim().split('\n') : [];
  const chats = (list: WatchdogParams['chats'], proxy: string | null = null) =>
    writeFileSync(envFile, watchdogEnvFile({ ...PARAMS, chats: list, proxy }));
  /** Состояние, как после двух неудач подряд с 01:12: следующий запуск — третья неудача. */
  const twoFails = () => {
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'fails'), '2');
    writeFileSync(join(state, 'since'), min(0));
  };

  it('панель отвечает — тихо; спрашивает ровно адрес готовности панели', () => {
    const res = run(min(0));
    expect(res.status).toBe(0);
    expect(sent()).toEqual([]);
    expect(readFileSync(join(stub, 'asked'), 'utf8').trim()).toBe(PARAMS.url);
  });

  it('3 неудачи подряд — одно сообщение: с какого времени и что увидел; повторные неудачи не шлют повтор', () => {
    panel('timeout');
    run(min(0));
    run(min(1));
    expect(sent()).toEqual([]);
    run(min(2));
    expect(sent()).toEqual([alert('нет ответа за 10 с')]);
    // Токен, чат и тема — из файла настроек.
    expect(meta(0)).toBe(
      `chat=-1002946167407 topic=8 proxy= url=https://api.telegram.org/bot${TOKEN}/sendMessage`,
    );
    for (let m = 3; m < 30; m += 1) run(min(m));
    expect(sent()).toHaveLength(1);
  });

  it('сторож сначала шлёт Rich Message с заголовком; обычный HTML остаётся запасным', () => {
    panel('timeout');
    twoFails();
    run(min(2), [], { STUB_RICH_OK: '1' });
    const payload = JSON.parse(sent()[0] ?? '{}') as {
      blocks?: Array<{ type?: string; text?: string }>;
      skip_entity_detection?: boolean;
    };
    expect(payload.skip_entity_detection).toBe(true);
    expect(payload.blocks?.[0]).toMatchObject({
      type: 'heading',
      text: '🔴 Панель NodeService не отвечает',
    });
    expect(payload.blocks?.[1]?.text).toContain('Независимый сторож');
    expect(meta(0)).toContain('/sendRichMessage');
  });

  it('восстановление — одно сообщение, сколько не отвечала; дальше тихо', () => {
    panel('refused');
    for (let m = 0; m < 3; m += 1) run(min(m));
    panel('ok');
    run(min(8));
    run(min(9));
    expect(sent()).toEqual([alert('нет ответа: не удаётся подключиться'), recovered()]);
    // Новый сбой — снова с чистого листа.
    panel('timeout');
    for (let m = 60; m < 63; m += 1) run(min(m));
    expect(sent()).toHaveLength(3);
    expect(sent()[2]).toContain('С <b>02:12</b>');
  });

  it('неудачи вперемешку с ответами — не «подряд»: сообщения нет', () => {
    for (let m = 0; m < 12; m += 3) {
      panel('timeout');
      run(min(m));
      run(min(m + 1));
      panel('ok');
      run(min(m + 2));
    }
    expect(sent()).toEqual([]);
  });

  it('панель отвечает 503 — сторож пересказывает, что не так; 502 — что панель за сервером не отвечает', () => {
    panel({
      code: 503,
      body: '{"problems":["база данных не отвечает"],"type":"urn:nodeservice:problem:not-ready","title":"Ошибка","status":503,"detail":"база данных не отвечает; поиск инцидентов не отрабатывал 5 мин","instance":"/api/health/ready"}',
    });
    for (let m = 0; m < 3; m += 1) run(min(m));
    panel('502');
    for (let m = 3; m < 6; m += 1) run(min(m));
    expect(sent()).toEqual([
      alert('ошибка 503: база данных не отвечает; поиск инцидентов не отрабатывал 5 мин'),
    ]);
    panel('ok');
    run(min(10));
    panel('502');
    for (let m = 20; m < 23; m += 1) run(min(m));
    expect(sent()[2]).toMatch(/С <b>01:32<\/b>: ошибка 502: сервер панели отвечает, а сама панель — нет\./);
  });

  it('Telegram недоступен — сообщение не потеряно: сторож пробует каждую минуту, пока не дойдёт, и только одно', () => {
    panel('timeout');
    for (let m = 0; m < 5; m += 1) run(min(m), [], { STUB_TG_DOWN: '1' });
    expect(sent()).toEqual([]);
    run(min(5));
    run(min(6));
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain('С <b>01:12</b>');
  });

  it('Telegram недоступен, когда панель поднялась, — «снова отвечает» не теряется: уходит, когда дойдёт, и одно', () => {
    panel('timeout');
    for (let m = 0; m < 3; m += 1) run(min(m));
    expect(sent()).toHaveLength(1);
    panel('ok');
    run(min(8), [], { STUB_TG_DOWN: '1' });
    run(min(9), [], { STUB_TG_DOWN: '1' });
    expect(sent()).toHaveLength(1);
    run(min(15));
    run(min(16));
    // Сколько не отвечала — до минуты, когда панель снова ответила, а не до доставки.
    expect(sent()).toEqual([expect.stringMatching(/^🔴 /), recovered()]);
  });

  it('прокси из «Уведомлений»: через него; не соединяется — напрямую, и сообщение одно', () => {
    const proxy = 'socks5://user:p@ss$word@10.0.0.5:1080';
    writeFileSync(envFile, watchdogEnvFile({ ...PARAMS, proxy }));
    panel('timeout');
    for (let m = 0; m < 3; m += 1) run(min(m));
    expect(sent()).toHaveLength(1);
    expect(meta(0)).toContain(`proxy=${proxy} `);
    // Прокси на сервере парка недоступен (например, он слушал только на сервере панели).
    panel('ok');
    run(min(4), [], { STUB_PROXY_DOWN: proxy });
    expect(sent()).toHaveLength(2);
    expect(meta(1)).toContain('proxy= ');
  });

  it('несколько чатов — сообщение в каждый; чат без темы — без номера темы', () => {
    chats(THREE_CHATS.slice(0, 2));
    panel('timeout');
    for (let m = 0; m < 3; m += 1) run(min(m));
    expect(sent()).toHaveLength(2);
    expect(meta(1)).toMatch(/^chat=412345678 topic= proxy= url=https:\/\/api\.telegram\.org\/bot987654321:/);
  });

  it('токен бота и пароль прокси не попадают в командную строку curl: её видит любой пользователь сервера', () => {
    const proxy = 'socks5://user:Sekr3tPass@10.0.0.5:1080';
    chats(THREE_CHATS.slice(0, 2), proxy);
    panel('timeout');
    for (let m = 0; m < 3; m += 1) run(min(m));
    run(min(3), ['test']);
    expect(sent()).toHaveLength(4);
    expect(meta(0)).toContain(`url=https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const argv = readFileSync(join(stub, 'argv.log'), 'utf8');
    for (const secret of [TOKEN, TOKEN2, 'Sekr3tPass']) expect(argv).not.toContain(secret);
  });

  describe('время: запуск укладывается в свой предел, повторов нет', () => {
    it('путь, по которому в этом запуске не достучались, дальше не пробуем: прокси — один раз, потом напрямую', () => {
      const proxy = 'socks5://10.0.0.5:1080';
      chats(THREE_CHATS, proxy);
      twoFails();
      panel('timeout');
      run(min(2), [], { STUB_PROXY_DOWN: proxy });
      expect(sent()).toHaveLength(3);
      expect(attempts()).toEqual([`proxy=${proxy}`, 'proxy=', 'proxy=', 'proxy=']);
    });

    it('Telegram с сервера недоступен совсем — одна попытка через прокси и одна напрямую, а не по две на каждый чат', () => {
      const proxy = 'socks5://10.0.0.5:1080';
      chats(THREE_CHATS, proxy);
      twoFails();
      panel('timeout');
      run(min(2), [], { STUB_TG_DOWN: '1' });
      expect(sent()).toHaveLength(0);
      expect(attempts()).toEqual([`proxy=${proxy}`, 'proxy=']);
      // Событие уже сохранено как ожидающее доставки, но ни один чат ещё не подтверждён.
      expect(existsSync(join(state, 'alerted'))).toBe(true);
      expect(existsSync(join(state, 'alert.done'))).toBe(false);
    });

    it('«Проверить сторожа» при недоступном Telegram (пакеты теряются) и нескольких чатах — не дольше своего предела', () => {
      const proxy = 'socks5://10.0.0.5:1080';
      chats(THREE_CHATS, proxy);
      const started = performance.now();
      const res = run(min(0), ['test'], {
        NS_WATCHDOG_BUDGET: '3',
        STUB_TG_HANG: '1',
        STUB_PROXY_HANG: proxy,
      });
      const took = performance.now() - started;
      expect(res.status).toBe(0);
      expect(parseWatchdogOutput(res.stdout)).toEqual({ panel: 'ok', sent: '0' });
      expect(took).toBeLessThan(5_000);
    });

    it('пределы согласованы: панель ждёт проверку дольше, чем сторож может её вести; systemd не обрывает запуск', () => {
      expect(WATCHDOG_WAIT_MS.test - WATCHDOG_BUDGET_S.test * 1000).toBeGreaterThanOrEqual(10_000);
      const timeout = Number(/TimeoutStartSec=(\d+)/.exec(WATCHDOG_SERVICE_UNIT)?.[1]);
      expect(timeout - WATCHDOG_BUDGET_S.run).toBeGreaterThanOrEqual(5);
      // Опрос панели (-m 10) и хотя бы одна попытка до Telegram укладываются в предел запуска.
      expect(WATCHDOG_BUDGET_S.run).toBeGreaterThanOrEqual(25);
      expect(WATCHDOG_BUDGET_S.test).toBeGreaterThanOrEqual(25);
    });

    it('рассылку «не отвечает» оборвали посередине — доставленные чаты не получают дубль, остальные не теряются', async () => {
      chats(THREE_CHATS);
      twoFails();
      panel('timeout');
      await runKilled(min(2), 1_500, { STUB_HANG_CHAT: '412345678' });
      expect(sent()).toHaveLength(1);
      expect(existsSync(join(state, 'alerted'))).toBe(true);
      run(min(3));
      run(min(4));
      expect(sent()).toHaveLength(3);
      expect(sent().every((message) => message.startsWith('🔴'))).toBe(true);
    });

    it('рассылку «снова отвечает» оборвали посередине — она продолжается без дублей и потерь', async () => {
      chats(THREE_CHATS);
      twoFails();
      panel('timeout');
      run(min(2));
      expect(sent()).toHaveLength(3);
      panel('ok');
      await runKilled(min(8), 1_500, { STUB_HANG_CHAT: '412345678' });
      expect(sent()).toHaveLength(4);
      expect(sent()[3]).toBe(recovered());
      run(min(9));
      run(min(10));
      expect(sent()).toHaveLength(6);
      expect(sent().filter((message) => message.startsWith('✅'))).toEqual([
        recovered(),
        recovered(),
        recovered(),
      ]);
    });
  });

  it('«Проверить сторожа»: тестовое сообщение и что сторож видит сейчас; счёт неудач не трогает', () => {
    const ok = run(min(0), ['test']);
    expect(ok.status).toBe(0);
    expect(parseWatchdogOutput(ok.stdout)).toEqual({ panel: 'ok', sent: '1' });
    expect(sent()).toEqual([testMessage]);
    panel('timeout');
    const bad = run(min(1), ['test'], { STUB_TG_DOWN: '1' });
    expect(parseWatchdogOutput(bad.stdout)).toEqual({ panel: 'нет ответа за 10 с', sent: '0' });
    expect(existsSync(join(state, 'fails'))).toBe(false);
  });

  describe('установка и снятие (корень файловой системы — временная папка, systemctl подменён)', () => {
    let root: string;
    /** Как ведёт себя подменённый systemctl: `enable` отказывает; таймер не запущен (is-active). */
    let systemd: { enableFails: boolean; timerInactive: boolean };
    beforeEach(() => {
      root = join(dir, 'root');
      mkdirSync(root);
      systemd = { enableFails: false, timerInactive: false };
      writeSystemctl();
    });
    const writeSystemctl = () => {
      writeFileSync(
        join(bin, 'systemctl'),
        [
          '#!/bin/sh',
          `echo "$@" >> "${join(dir, 'systemctl.log')}"`,
          systemd.enableFails ? 'case "$1" in enable) exit 1 ;; esac' : '',
          systemd.timerInactive ? 'case "$1" in is-active) exit 3 ;; esac' : '',
          'exit 0',
        ].join('\n'),
      );
      chmodSync(join(bin, 'systemctl'), 0o755);
    };
    const installed = (f: keyof typeof FILES) => join(root, FILES[f]);
    const FILES = {
      env: 'etc/nodeservice-watchdog.env',
      script: 'usr/local/bin/nodeservice-watchdog',
      service: 'etc/systemd/system/nodeservice-watchdog.service',
      timer: 'etc/systemd/system/nodeservice-watchdog.timer',
      state: 'var/lib/nodeservice-watchdog',
    } as const;
    /** Как панель: `sh -c` (для не-root — внутри `sudo -n sh -c`); файл настроек — на вход команды. */
    const sh = (cmd: string, input = '', shell = '/bin/sh', path = `${bin}:${process.env.PATH}`) =>
      spawnSync(shell, ['-c', `${shell} -c ${shellQuote(cmd)}`], {
        encoding: 'utf8',
        input,
        env: { PATH: path, NS_WATCHDOG_ROOT: root, STUB_DIR: stub },
      });
    const install = (p: WatchdogParams = PARAMS, shell?: string) =>
      sh(WATCHDOG_INSTALL_COMMAND, watchdogEnvFile(p), shell);
    /** Что осталось от сторожа на «сервере» (без состояния). */
    const leftovers = () =>
      ['etc', 'etc/systemd/system', 'usr/local/bin'].flatMap((d) =>
        existsSync(join(root, d))
          ? readdirSync(join(root, d))
              .filter((f) => f.includes('nodeservice-watchdog'))
              .map((f) => `${d}/${f}`)
          : [],
      );

    it('ставит скрипт, файл настроек только для root (0600), службу и таймер раз в минуту; снятие убирает всё', () => {
      const res = install();
      expect(res.stderr).toBe('');
      expect(parseWatchdogOutput(res.stdout)).toEqual({ installed: '1' });
      const env = installed('env');
      expect(statSync(env).mode & 0o777).toBe(0o600);
      expect(readFileSync(env, 'utf8')).toBe(watchdogEnvFile(PARAMS));
      expect(readFileSync(installed('script'), 'utf8')).toBe(WATCHDOG_SCRIPT);
      expect(statSync(installed('script')).mode & 0o111).not.toBe(0);
      expect(readFileSync(installed('timer'), 'utf8')).toMatch(/OnUnitActiveSec=1min/);
      expect(readFileSync(installed('service'), 'utf8')).toMatch(
        /ExecStart=\/usr\/local\/bin\/nodeservice-watchdog/,
      );
      expect(readFileSync(join(dir, 'systemctl.log'), 'utf8')).toContain(
        'enable --now nodeservice-watchdog.timer',
      );
      expect(leftovers().filter((f) => f.endsWith('.new'))).toEqual([]);
      // Поставленный скрипт читает поставленный файл настроек: имя сервера с кавычкой не ломает его.
      panel('timeout');
      for (let m = 0; m < 3; m += 1) run(min(m), [], { NS_WATCHDOG_ENV: env }, installed('script'));
      expect(sent()[0]).toContain("Германия-1 (Hetzner's)");

      const off = sh(WATCHDOG_REMOVE_COMMAND);
      expect(parseWatchdogOutput(off.stdout)).toEqual({ removed: '1' });
      expect(leftovers()).toEqual([]);
      expect(existsSync(join(root, FILES.state))).toBe(false);
      expect(readFileSync(join(dir, 'systemctl.log'), 'utf8')).toContain(
        'disable --now nodeservice-watchdog.timer',
      );
    });

    it('токенов нет в самой команде установки: файл настроек приходит на её вход', () => {
      expect(WATCHDOG_INSTALL_COMMAND).not.toContain(TOKEN);
      expect(WATCHDOG_INSTALL_COMMAND).not.toContain('TG_CHATS');
    });

    it('в оболочке как на Debian и Ubuntu (dash) — так же', () => {
      if (!existsSync('/bin/dash')) return;
      const res = install(PARAMS, '/bin/dash');
      expect(res.stderr).toBe('');
      expect(parseWatchdogOutput(res.stdout)).toEqual({ installed: '1' });
      expect(readFileSync(installed('script'), 'utf8')).toBe(WATCHDOG_SCRIPT);
      expect(readFileSync(installed('env'), 'utf8')).toBe(watchdogEnvFile(PARAMS));
    });

    it('поставить заново, пока сторож работает: файлы подменяются целиком, запущенный сторож дорабатывает свою версию', async () => {
      expect(parseWatchdogOutput(install().stdout)).toEqual({ installed: '1' });
      const inode = statSync(installed('script')).ino;
      // Сторож запущен таймером: уже две неудачи, панель «висит» секунду — это третья, она пришлёт сообщение.
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, 'fails'), '2');
      writeFileSync(join(state, 'since'), min(0));
      const running = new Promise<number | null>((resolve) => {
        const child = spawn('/bin/bash', [installed('script')], {
          stdio: 'ignore',
          env: envOf(min(2), { NS_WATCHDOG_ENV: installed('env'), STUB_PANEL_HANG: '1' }),
        });
        child.on('exit', (code) => resolve(code));
      });
      await new Promise((r) => setTimeout(r, 300));
      // Новая версия сторожа (другая версия панели): одна строка комментария в начале сдвигает весь текст.
      const v2 = WATCHDOG_SCRIPT.replace('\n', '\n# Новая версия: здесь могла появиться любая строка.\n');
      const res = sh(
        WATCHDOG_INSTALL_COMMAND.replace(shellQuote(WATCHDOG_SCRIPT), shellQuote(v2)),
        watchdogEnvFile(PARAMS),
      );
      expect(parseWatchdogOutput(res.stdout)).toEqual({ installed: '1' });
      expect(await running).toBe(0);
      expect(sent()).toHaveLength(1);
      expect(existsSync(join(state, 'alerted'))).toBe(true);
      expect(readFileSync(installed('script'), 'utf8')).toBe(v2);
      expect(statSync(installed('script')).ino).not.toBe(inode);
    });

    it('таймер не запустился — всё записанное убрано (и токены тоже), причина — по-русски и честно', () => {
      systemd.enableFails = true;
      writeSystemctl();
      const res = install();
      expect(res.status).not.toBe(0);
      const out = parseWatchdogOutput(res.stdout);
      expect(out.removed).toBe('1');
      expect(out.error).toMatch(/Всё, что успело записаться, с сервера убрано/);
      expect(leftovers()).toEqual([]);
      expect(existsSync(join(root, FILES.state))).toBe(false);
    });

    it('новые файлы не записались — прежний сторож не тронут, недописанных файлов не остаётся', () => {
      expect(parseWatchdogOutput(install().stdout)).toEqual({ installed: '1' });
      const before = readFileSync(installed('env'), 'utf8');
      // Скрипт не записать (вместо файла — папка): так же ведёт себя кончившееся место.
      mkdirSync(`${installed('script')}.new`);
      const res = install({ ...PARAMS, chats: THREE_CHATS });
      rmSync(`${installed('script')}.new`, { recursive: true });
      expect(res.status).toBe(4);
      const out = parseWatchdogOutput(res.stdout);
      expect(out.removed).toBeUndefined();
      expect(out.error).toBe(
        'Не удалось записать файлы сторожа на сервер. Проверьте, что на диске есть место.',
      );
      expect(readFileSync(installed('env'), 'utf8')).toBe(before);
      expect(leftovers().filter((f) => f.endsWith('.new'))).toEqual([]);
    });

    it('программ для распаковки файлов не нужно: ставится и без base64', () => {
      const only = join(dir, 'only');
      mkdirSync(only);
      for (const p of ['mkdir', 'chmod', 'cat', 'rm', 'mv']) symlinkSync(`/bin/${p}`, join(only, p));
      symlinkSync('/bin/bash', join(only, 'bash'));
      symlinkSync(join(bin, 'curl'), join(only, 'curl'));
      symlinkSync(join(bin, 'systemctl'), join(only, 'systemctl'));
      const res = sh(WATCHDOG_INSTALL_COMMAND, watchdogEnvFile(PARAMS), '/bin/sh', only);
      expect(parseWatchdogOutput(res.stdout)).toEqual({ installed: '1' });
      expect(readFileSync(installed('script'), 'utf8')).toBe(WATCHDOG_SCRIPT);
    });

    it('без systemd — понятная причина, ничего не поставлено', () => {
      rmSync(join(bin, 'systemctl'));
      const res = spawnSync('/bin/sh', ['-c', WATCHDOG_INSTALL_COMMAND], {
        encoding: 'utf8',
        input: watchdogEnvFile(PARAMS),
        // В PATH только подменённые программы: systemctl среди них нет.
        env: { PATH: bin, NS_WATCHDOG_ROOT: root },
      });
      expect(res.status).not.toBe(0);
      expect(parseWatchdogOutput(res.stdout).error).toBe(
        'Сервер не поддерживает службы по расписанию — сторожа на нём не поставить. Выберите другой сервер.',
      );
      expect(existsSync(installed('env'))).toBe(false);
    });

    it('причины отказа — по-русски, без названий программ', () => {
      const reasons = [...WATCHDOG_INSTALL_COMMAND.matchAll(/@@error=([^"]*)"/g)].map((m) => m[1] ?? '');
      expect(reasons.length).toBeGreaterThanOrEqual(5);
      for (const r of reasons) expect(r).not.toMatch(/[A-Za-z]/);
    });

    it('проверка: сторожа нет на сервере — так и сказано', () => {
      const res = sh(WATCHDOG_TEST_COMMAND);
      expect(parseWatchdogOutput(res.stdout)).toEqual({ missing: '1' });
    });

    it('проверка: сторож есть, но таймер не запущен — так и сказано, тестового «на месте» нет', () => {
      expect(parseWatchdogOutput(install().stdout)).toEqual({ installed: '1' });
      systemd.timerInactive = true;
      writeSystemctl();
      const res = sh(WATCHDOG_TEST_COMMAND);
      expect(parseWatchdogOutput(res.stdout)).toEqual({ timer: '0' });
      expect(sent()).toEqual([]);
    });
  });
});
