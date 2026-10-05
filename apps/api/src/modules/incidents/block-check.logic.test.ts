import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BlockProbeResult,
  DEFAULT_SERVER_COUNTRY,
  isExitOnly,
  splitUpstreamAddress,
} from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import {
  blindAttempt,
  blindReason,
  buildBlockCheckCommand,
  combineVerdicts,
  countryReachLines,
  describeAnomaly,
  entrySide,
  isSafeBlockCheckTarget,
  parseBlockCheckOutput,
  pickCountryProbes,
  pickForeignProbes,
  pickRuProbes,
  probeSaw,
  settleAttempts,
  settleEntry,
  uncheckedLine,
  withForeign,
} from './block-check.logic.js';

const country = (code: string | null) => ({ ...DEFAULT_SERVER_COUNTRY, code });

/** Снять экранирование одинарных кавычек, которое добавляет SH() при обёртке в sh -c '...'. */
const unescapeSh = (s: string) => s.replace(/'\\''/g, "'");

describe('pickRuProbes', () => {
  const all = [
    { id: 'a', name: 'ru-a', sshOk: true, country: country('RU') },
    { id: 'b', name: 'ru-b', sshOk: true, country: country('RU') },
    { id: 'c', name: 'nl-c', sshOk: true, country: country('NL') },
    { id: 'd', name: 'ru-d-down', sshOk: false, country: country('RU') },
    { id: 'e', name: 'ru-e-target', sshOk: true, country: country('RU') },
  ];

  it('берёт только российские серверы с рабочим SSH, не саму проверяемую ноду, по алфавиту', () => {
    expect(pickRuProbes('e', all).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('не больше max', () => {
    expect(pickRuProbes(null, all, 1)).toHaveLength(1);
  });

  it('нет ни одного подходящего — пустой список', () => {
    expect(
      pickRuProbes(
        null,
        all.filter((s) => s.country.code !== 'RU'),
      ),
    ).toEqual([]);
  });
});

describe('buildBlockCheckCommand', () => {
  it('оборачивает IPv6 для OpenSSL и curl --resolve', () => {
    const cmd = unescapeSh(buildBlockCheckCommand('2a01:4f8:c0c:1::1', 8443, 'mask.example.com'));
    expect(cmd).toContain('tls_endpoint="[$addr]:$port"');
    expect(cmd).toContain('resolve_addr="[$addr]"');
    expect(cmd).toContain('openssl s_client -connect "$tls_endpoint"');
    expect(cmd).toContain('--resolve "$sni:$port:$resolve_addr"');
  });
  it('подставляет адрес, порт и SNI (в кавычках для оболочки); печатает один JSON на этапах tcp/tls/data', () => {
    const cmd = unescapeSh(buildBlockCheckCommand('203.0.113.7', 8443, 'www.example.com'));
    expect(cmd).toContain("addr='203.0.113.7'");
    expect(cmd).toContain('port=8443');
    expect(cmd).toContain("sni='www.example.com'");
    expect(cmd).toContain('"stage":"tcp"');
    expect(cmd).toContain('"stage":"tls"');
    expect(cmd).toContain('"stage":"data"');
    expect(cmd).toContain('BEGIN CERTIFICATE');
  });

  it('без имени маскировки — только проверка порта (этап port), без TLS и данных', () => {
    const cmd = unescapeSh(buildBlockCheckCommand('203.0.113.7', 8443, null));
    expect(cmd).toContain("sni=''");
    expect(cmd).toContain('"stage":"port"');
  });

  it('адрес или SNI с символами оболочки — отказ, а не подстановка в команду (защита от инъекции)', () => {
    expect(() => buildBlockCheckCommand('1.2.3.4; rm -rf / #', 443, 'example.com')).toThrow();
    expect(() => buildBlockCheckCommand('1.2.3.4', 443, '$(reboot)')).toThrow();
    expect(() => buildBlockCheckCommand('1.2.3.4', 443, 'example.com`whoami`')).toThrow();
    expect(() => buildBlockCheckCommand('1.2.3.4 && curl evil', 443, 'example.com')).toThrow();
  });

  it('порт вне диапазона или не целое число — тоже отказ', () => {
    expect(() => buildBlockCheckCommand('1.2.3.4', 0, 'example.com')).toThrow();
    expect(() => buildBlockCheckCommand('1.2.3.4', 65536, 'example.com')).toThrow();
    expect(() => buildBlockCheckCommand('1.2.3.4', 443.5, 'example.com')).toThrow();
  });
});

describe('isSafeBlockCheckTarget', () => {
  it('обычные IPv4, IPv6 и доменное имя — безопасны', () => {
    expect(isSafeBlockCheckTarget('203.0.113.7', 8443, 'www.example.com')).toBe(true);
    expect(isSafeBlockCheckTarget('2001:db8::1', 443, 'example.com')).toBe(true);
  });

  it('пробел, кавычка, точка с запятой, обратные кавычки, подстановка команд — небезопасны', () => {
    expect(isSafeBlockCheckTarget('1.2.3.4 rm', 443, 'example.com')).toBe(false);
    expect(isSafeBlockCheckTarget('1.2.3.4', 443, "example.com'; rm -rf ~ #")).toBe(false);
    expect(isSafeBlockCheckTarget('1.2.3.4', 443, 'example.com`id`')).toBe(false);
    expect(isSafeBlockCheckTarget('1.2.3.4', 443, '$(id)')).toBe(false);
  });
});

describe('parseBlockCheckOutput', () => {
  it('tcp недоступен — unreachable', () => {
    const r = parseBlockCheckOutput('ru-a', '{"stage":"tcp","ok":false,"stalledAtKb":null}');
    expect(r).toMatchObject({ from: 'ru-a', verdict: 'unreachable' });
  });

  it('проверка только порта по замыслу (встречная из-за рубежа, вход) — просто «порт отвечает», без оговорки про имя маскировки', () => {
    const r = parseBlockCheckOutput('de-fra-01', '{"stage":"port","ok":true,"stalledAtKb":null}', true);
    expect(r.verdict).toBe('ok');
    expect(r.detail).toBe('Порт отвечает.');
  });
  it('порт отвечает, имени маскировки нет — ok, с честной пометкой, что блокировку не проверить', () => {
    const r = parseBlockCheckOutput('ru-a', '{"stage":"port","ok":true,"stalledAtKb":null}');
    expect(r).toMatchObject({ from: 'ru-a', verdict: 'ok' });
    expect(r.detail).toContain('Порт отвечает');
  });

  it('обычный TLS тихо обрывается — этого недостаточно для вывода о REALITY или ТСПУ', () => {
    const r = parseBlockCheckOutput('ru-a', '{"stage":"tls","ok":false,"stalledAtKb":null}');
    expect(r.verdict).toBe('indeterminate');
  });

  it('обычная передача обрывается в диапазоне 12–40 КБ — это ещё не пользовательский VPN-трафик', () => {
    const r = parseBlockCheckOutput('ru-a', '{"stage":"data","ok":false,"stalledAtKb":16}');
    expect(r).toMatchObject({ verdict: 'indeterminate', stalledAtKb: 16 });
  });

  it('обычная передача обрывается до 12 КБ — результат тоже остаётся неопределённым', () => {
    const r = parseBlockCheckOutput('ru-a', '{"stage":"data","ok":false,"stalledAtKb":4}');
    expect(r.verdict).toBe('indeterminate');
  });

  it('data прошла целиком — ok', () => {
    const r = parseBlockCheckOutput('ru-a', '{"stage":"data","ok":true,"stalledAtKb":null}');
    expect(r.verdict).toBe('ok');
  });

  it('мусор вместо JSON — unreachable с пометкой ошибки', () => {
    const r = parseBlockCheckOutput('ru-a', 'permission denied\n');
    expect(r.verdict).toBe('unreachable');
    expect(r.error).toBeTruthy();
  });

  it('пустой вывод (проверяющий не ответил) — unreachable', () => {
    const r = parseBlockCheckOutput('ru-a', '');
    expect(r.verdict).toBe('unreachable');
  });
});

describe('combineVerdicts', () => {
  it('нет проб — unreachable', () => {
    expect(combineVerdicts([])).toBe('unreachable');
  });

  it('хоть одна проба нашла block_16_20 — это и есть итог, даже если другие ok', () => {
    const probes = [
      { from: 'a', verdict: 'ok' as const, detail: '', stalledAtKb: null, error: null },
      { from: 'b', verdict: 'block_16_20' as const, detail: '', stalledAtKb: 20, error: null },
    ];
    expect(combineVerdicts(probes)).toBe('block_16_20');
  });

  const mk = (verdict: 'ok' | 'tspu' | 'unreachable' | 'block_16_20') => ({
    from: 'x',
    verdict,
    detail: '',
    stalledAtKb: null,
    error: null,
  });

  it('block_16_20 важнее tspu, tspu важнее «не отвечает»; все ответили — в норме, никто — недоступен', () => {
    expect(combineVerdicts([mk('tspu'), mk('block_16_20')])).toBe('block_16_20');
    expect(combineVerdicts([mk('tspu'), mk('unreachable')])).toBe('tspu');
    expect(combineVerdicts([mk('ok'), mk('ok')])).toBe('ok');
    expect(combineVerdicts([mk('unreachable'), mk('unreachable')])).toBe('unreachable');
  });

  it('один молчащий проверяющий не перевешивает ответивших: «порт отвечает с перебоями», а не «недоступен»', () => {
    expect(combineVerdicts([mk('unreachable'), mk('ok')])).toBe('partial');
    expect(combineVerdicts([mk('ok'), mk('ok'), mk('unreachable')])).toBe('partial');
    // Проверяющий, который сам подключался не каждый раз, — и ответивший, и молчавший: один такой — уже «с перебоями».
    const flaky = { ...mk('ok'), verdict: 'partial' as const };
    expect(combineVerdicts([flaky])).toBe('partial');
    expect(combineVerdicts([flaky, mk('unreachable')])).toBe('partial');
    expect(combineVerdicts([flaky, mk('ok')])).toBe('partial');
    expect(combineVerdicts([flaky, { ...mk('ok'), verdict: 'tspu' as const }])).toBe('tspu');
    // Частичная картина — не «из России порт молчит»: зарубежная проверка её в блокировку IP не превращает.
    expect(withForeign('partial', [mk('ok')])).toBe('partial');
  });
});

describe('встречная проверка из-за рубежа', () => {
  const mk = (verdict: BlockProbeResult['verdict']): BlockProbeResult => ({
    from: 'x',
    verdict,
    detail: '',
    stalledAtKb: null,
    error: null,
  });
  it('из России молчит, из-за рубежа отвечает — блокировка IP; молчит везде — недоступен', () => {
    expect(withForeign('unreachable', [mk('ok')])).toBe('ip_block');
    expect(withForeign('unreachable', [mk('unreachable')])).toBe('unreachable');
    expect(withForeign('unreachable', [])).toBe('unreachable');
    expect(withForeign('tspu', [mk('ok')])).toBe('tspu');
  });
  it('зарубежные — только с рабочим SSH, известной страной не RU и не сама нода', () => {
    const s = (id: string, code: string | null, sshOk: boolean | null = true) => ({
      id,
      name: id,
      sshOk,
      country: { code } as never,
    });
    expect(
      pickForeignProbes('self', [
        s('self', 'DE'),
        s('ru', 'RU'),
        s('none', null),
        s('dead', 'NL', false),
        s('de', 'DE'),
      ]).map((x) => x.id),
    ).toEqual(['de']);
  });
});

describe('вход сервера-выхода', () => {
  const probe = (verdict: 'ok' | 'unreachable', from = 'Мост') => ({
    from,
    verdict,
    detail: verdict === 'ok' ? 'Порт отвечает.' : 'Порт не отвечает совсем.',
    stalledAtKb: null,
    error: null,
  });
  const base = {
    nodeName: 'guardora',
    address: '1.2.3.4',
    sniUsed: null,
    probes: [probe('unreachable')],
    foreign: [],
    verdict: 'unreachable' as const,
  };
  const entry = (v: 'ok' | 'unreachable') => ({
    label: 'Вход арендодателя',
    address: 'entry.example.com:443',
    owner: 'Иван',
    rented: true,
    probes: [probe(v)],
    verdict: v,
  });
  /** Свой мост вместо входа арендодателя: его выключает не арендодатель. */
  const bridge = (v: 'ok' | 'unreachable') => ({
    ...entry(v),
    label: 'Мост «Мост»',
    owner: null,
    rented: false,
  });
  /** Выход отвечает: проверка TLS и данных с именем маскировки прошла. */
  const alive = {
    ...base,
    sniUsed: 'site.ru',
    probes: [probe('ok')],
    verdict: 'ok' as const,
  };
  /** Сервер не отвечает ни из России, ни из-за рубежа. */
  const down = { ...base, foreign: [probe('unreachable', 'Германия - 1')] };
  const SOON = 'Аренда «Guardora»: 2 500 ₽, оплачено до 30 сентября, 16:00 (UTC+6)';
  const LATE = 'Аренда «Guardora»: 2 500 ₽, оплачено до 29 сентября, 00:00 (UTC+6)';
  const HOSTING = 'Сервер «DE-1» у Hetzner: €4.51, оплачено до 30 сентября, 22:56 (UTC+6)';
  const soon = { overdue: [], dueSoon: [{ kind: 'rent' as const, text: SOON }], paying: 1 };
  const late = { overdue: [{ kind: 'rent' as const, text: LATE }], dueSoon: [], paying: 1 };
  const hosting = { overdue: [], dueSoon: [{ kind: 'server' as const, text: HOSTING }], paying: 2 };
  type Input = Parameters<typeof describeAnomaly>[0];
  const drop = (result: Input['result'], over: Partial<Input> = {}) =>
    describeAnomaly({
      nodeName: 'guardora (Аренда)',
      before: 211,
      after: 0,
      windowMin: 5,
      result,
      portKnown: true,
      ...over,
    });

  it('чья сторона сломалась', () => {
    expect(entrySide({ ...down, entry: entry('ok') })).toBe(
      'Вход отвечает, не отвечает выход — дело в этом сервере или его хостере.',
    );
    expect(entrySide({ ...alive, entry: entry('unreachable') })).toBe(
      'Выход отвечает, а вход — нет: похоже, лёг вход — пишите арендодателю (Иван).',
    );
    // Свой мост — чинить самим, арендодателя нет.
    expect(entrySide({ ...alive, entry: bridge('unreachable') })).toBe(
      'Выход отвечает, а вход — нет: похоже, лёг вход — проверьте сам мост.',
    );
    // Следом идёт вывод об оплате аренды — «пишите арендодателю» спорил бы с «проверьте оплату».
    expect(entrySide({ ...alive, entry: entry('unreachable') }, { bare: true })).toBe(
      'Выход отвечает, а вход — нет.',
    );
    expect(entrySide({ ...alive, entry: entry('ok') })).toBeNull();
    expect(entrySide({ ...base, entry: null })).toBeNull();
    // Вход проверить не удалось (ни один проверяющий не дошёл) — о входе ничего не говорим.
    expect(entrySide({ ...alive, entry: { ...entry('unreachable'), probes: [] } })).toBeNull();
    // Оба молчат: начинать с выхода; к кому идти за входом — зависит от того, чей он.
    expect(entrySide({ ...down, entry: entry('unreachable') })).toContain('пишите арендодателю (Иван)');
    const own = entrySide({ ...down, entry: bridge('unreachable') });
    expect(own).toContain('проверьте сам мост');
    expect(own).not.toContain('арендодател');
  });

  it('из-за рубежа не проверяли — причину не называем: блокировку IP из России от сбоя на сервере не отличить', () => {
    expect(entrySide({ ...base, entry: entry('ok') })).toBe(
      'Вход отвечает, а выход из России — нет; из-за рубежа порт не проверен: это либо блокировка IP выхода из России, либо выход недоступен целиком.',
    );
    expect(entrySide({ ...base, entry: entry('ok') }, { serverAlive: true })).toBe(
      'Вход отвечает, а порт ноды на выходе из России — нет; из-за рубежа порт не проверен: это либо блокировка IP выхода из России, либо нода не слушает порт.',
    );
    const both = entrySide({ ...base, entry: entry('unreachable') });
    expect(both).toContain('из-за рубежа порт не проверен');
    expect(both).toContain('не закрыт ли его IP из России');
    expect(both).toContain('пишите арендодателю (Иван)');
    expect(both).not.toContain('лежит выход');
    const bothAlive = entrySide({ ...base, entry: bridge('unreachable') }, { serverAlive: true });
    expect(bothAlive).toContain('либо блокировка IP выхода из России, либо нода не слушает порт');
    expect(bothAlive).toContain('проверьте сам мост');
  });

  it('порт выхода отвечает с перебоями — «дело в сервере или хостере» не пишем', () => {
    const mixed = {
      ...alive,
      probes: [probe('ok'), probe('unreachable', 'Россия - 1')],
      verdict: 'partial' as const,
    };
    expect(entrySide({ ...mixed, entry: entry('ok') })).toBeNull();
    const t = entrySide({ ...mixed, entry: entry('unreachable') });
    expect(t).toContain('выход отвечает с перебоями');
    expect(t).toContain('начните с выхода');
    expect(t).not.toContain('хостер');
  });

  it('блокировка выхода — это не «дело в сервере или хостере»', () => {
    for (const verdict of ['ip_block', 'tspu', 'block_16_20'] as const) {
      const t = entrySide({ ...alive, verdict, entry: entry('ok') });
      expect(t, verdict).toBe(
        'Вход отвечает, а выход из России режет блокировка — дело не в сервере и не в хостере: помогает смена IP или маскировки выхода.',
      );
      expect(entrySide({ ...alive, verdict, entry: entry('unreachable') }), verdict).toBe(
        'Выход из России режет блокировка, и вход не отвечает. Начните с выхода: смена IP или маскировки; если вход после этого не ответит — пишите арендодателю (Иван).',
      );
    }
  });

  it('агент на связи, порт закрыт и из-за рубежа — сервер работает: «дело в ноде», а не «в сервере или хостере»', () => {
    expect(entrySide({ ...down, entry: entry('ok') }, { serverAlive: true })).toBe(
      'Вход отвечает, а порт ноды на выходе — нет: сервер работает, дело в самой ноде — она не слушает порт или его закрыл файрвол.',
    );
    const both = entrySide({ ...down, entry: entry('unreachable') }, { serverAlive: true });
    expect(both).toContain('начните с ноды на этом сервере');
    expect(both).not.toContain('хостер');
  });

  it('итог проверки входа: проверяющий, на который панель не зашла, не считается; один ответивший — вход открыт', () => {
    const ssh = { ...probe('unreachable', 'Россия - 2'), error: 'ssh' };
    // Панель не зашла на «Россия - 2», а с «Моста» вход отвечает — вход открыт.
    expect(settleEntry([probe('ok'), ssh])).toEqual({ probes: [probe('ok')], verdict: 'ok' });
    // С одного проверяющего отвечает, с другого нет — порт открыт: отключённый вход не ответил бы никому.
    expect(settleEntry([probe('ok'), probe('unreachable', 'Россия - 1')]).verdict).toBe('ok');
    // Не ответил никому из дошедших — молчит.
    expect(settleEntry([probe('unreachable'), ssh])).toEqual({
      probes: [probe('unreachable')],
      verdict: 'unreachable',
    });
    // Никто не дошёл — проверить не удалось: проб нет.
    expect(settleEntry([ssh]).probes).toEqual([]);
  });

  it('не отвечает ни из России, ни из-за рубежа — «Сервер недоступен», а не блокировка; просрочка из биллинга — фактом', () => {
    const plain = drop(
      { ...down, entry: entry('unreachable') },
      { nodeName: 'guardora', payment: { overdue: [], dueSoon: [], paying: 2 } },
    );
    expect(plain.kind).toBe('server_down');
    expect(plain.title).toBe('Сервер недоступен · guardora');
    const paid = drop({ ...down, entry: entry('unreachable') }, { payment: late });
    expect(paid.title).toBe('Сервер недоступен — просрочена оплата · guardora (Аренда)');
    expect(paid.detail).toContain(`💳 Просрочена оплата: ${LATE}.`);
    expect(paid.detail).toContain('Вероятнее всего: отключили за неоплату');
    expect(paid.detail).not.toContain('Сервер арендован');
  });

  it('случай владельца: выход работает, вход арендодателя молчит, срок оплаты через несколько минут — «проверьте оплату»', () => {
    const r = drop({ ...alive, entry: entry('unreachable') }, { payment: soon });
    expect(r.title).toBe('Резко упал онлайн — проверьте оплату · guardora (Аренда)');
    // Блокировка не подтверждена — дело остаётся предупреждением того же вида.
    expect(r.kind).toBe('node_blocked');
    expect(r.confirmed).toBe(false);
    expect(r.detail.split('\n').slice(-5)).toEqual([
      'Вывод: блокировка не подтвердилась.',
      // Совет «пишите арендодателю» здесь не даём: следом — вывод об оплате аренды.
      'Выход отвечает, а вход — нет.',
      '',
      `💳 Срок оплаты близко: ${SOON}.`,
      'Вероятнее всего: оплата закончилась чуть раньше срока, и вход отключили — при неоплаченной аренде вход выключают, а выход продолжает работать. Проверьте оплату у арендодателя, после оплаты отметьте продление в «Биллинге».',
    ]);
    // Текст дела хранится: относительного срока («через час») в нём нет — он бы устарел.
    expect(r.detail).not.toMatch(/через|просрочено на/);
    // Уже просрочено — то же, но «за неоплату».
    const over = drop({ ...alive, entry: entry('unreachable') }, { payment: late });
    expect(over.title).toBe('Резко упал онлайн — проверьте оплату · guardora (Аренда)');
    expect(over.detail).toContain(`💳 Просрочена оплата: ${LATE}.`);
    expect(over.detail).toContain('Вероятнее всего: вход отключили за неоплату');
  });

  it('вход молчит, а в окне только оплата хостинга работающего выхода — она ни при чём: об оплате не пишем', () => {
    const r = drop({ ...alive, entry: entry('unreachable') }, { payment: hosting });
    expect(r.title).toBe('Резко упал онлайн, блокировка не подтвердилась · guardora (Аренда)');
    expect(r.detail).toContain('похоже, лёг вход');
    expect(r.detail).not.toContain('💳');
    expect(r.detail).not.toContain('Вероятнее всего');
    // И без входа: сервер отвечает — хостер его не отключал.
    const noEntry = drop({ ...alive, entry: null }, { payment: hosting });
    expect(noEntry.title).toBe('Резко упал онлайн, блокировка не подтвердилась · guardora (Аренда)');
    expect(noEntry.detail).not.toContain('💳');
    // Сервер не отвечает — оплата хостинга объясняет.
    expect(drop(down, { payment: hosting }).title).toBe(
      'Сервер недоступен — проверьте оплату · guardora (Аренда)',
    );
  });

  it('сервер отвечает, входа в профиле нет, аренда близко — другой причины не нашли: вероятнее всего оплата', () => {
    const r = drop({ ...alive, entry: null }, { payment: soon });
    expect(r.title).toBe('Резко упал онлайн — проверьте оплату · guardora (Аренда)');
    expect(r.detail).toContain('Вывод: блокировка не подтвердилась.\n');
    // Две догадки подряд не пишем: раз оплата в окне, «сбой у провайдеров пользователей» не предлагаем.
    expect(r.detail).not.toContain('сбой у провайдеров пользователей');
    expect(r.detail).toContain(
      'Вероятнее всего: оплата закончилась чуть раньше срока — другой причины панель не нашла.',
    );
    // Вход отвечает — арендодатель мог закрыть доступ, не выключая общий порт: вывод тот же.
    const both = drop({ ...alive, entry: entry('ok') }, { payment: soon });
    expect(both.title).toContain('проверьте оплату');
    expect(both.detail).toContain('другой причины панель не нашла');
  });

  it('вход проверить не удалось — названа настоящая причина, «вход отключили» не пишем', () => {
    const unchecked = (reason: 'no_probers' | 'bad_address' | 'ssh', e = entry('unreachable')) => ({
      ...e,
      probes: [],
      unchecked: reason,
    });
    // Панель не зашла ни на один проверяющий для входа — так и сказано.
    const r = drop({ ...alive, entry: unchecked('ssh') }, { payment: soon });
    expect(r.detail).toContain(
      'Вход арендодателя (entry.example.com:443): проверить не удалось — панель не зашла ни на один российский проверяющий сервер.',
    );
    expect(r.detail).not.toContain('лёг вход');
    expect(r.detail).not.toContain('вход отключили');
    // Вход арендодателя не проверен — возможная причина не проверена: «вероятнее всего» и «другой причины
    // панель не нашла» сказать нельзя (находка четвёртой проверки), только просьба проверить оплату.
    expect(r.title).toBe('Резко упал онлайн — проверьте оплату · guardora (Аренда)');
    expect(r.detail).toContain(
      'Вывод: у выхода блокировка не подтвердилась, а вход проверить не удалось — причина может быть в нём.',
    );
    expect(r.detail).toContain(
      'Проверьте оплату: вход арендодателя проверить не удалось, а срок оплаты аренды близко — возможно, оплата закончилась чуть раньше срока.',
    );
    for (const s of ['Вероятнее всего', 'другой причины панель не нашла', 'сбой у провайдеров пользователей'])
      expect(r.detail, s).not.toContain(s);
    // Единственный российский сервер парка — сам мост: на него панель зашла, проверять мост просто не с чего.
    const lone = drop({ ...alive, entry: unchecked('no_probers', bridge('unreachable')) }, { payment: soon });
    expect(lone.detail).toContain(
      'Мост «Мост» (entry.example.com:443): проверить не с чего — других российских серверов парка с рабочим SSH нет.',
    );
    expect(lone.detail).not.toContain('не зашла');
    // Свой мост не проверен — начинать надо с него: арендодатель свой мост не выключит, а сам сервер отвечает.
    // Оплата аренды тут не первая причина: в заголовок не идёт, в тексте — «заодно».
    expect(lone.title).toBe('Резко упал онлайн, вход проверить не удалось · guardora (Аренда)');
    expect(lone.detail).toContain(
      'Заодно проверьте оплату: срок аренды близко. Сервер отвечает, а свой мост проверить не удалось — начните с моста: арендодатель его выключить не может.',
    );
    for (const s of ['Вероятнее всего', 'Проверьте оплату:', 'другой причины панель не нашла'])
      expect(lone.detail, s).not.toContain(s);
    // Мост указан в профиле, а порт входа узнать негде (у моста нет ноды в Remnawave): раньше о входе в деле
    // не было ни слова, а вывод был «другой причины панель не нашла».
    const blind = drop(
      {
        ...alive,
        entry: { ...unchecked('no_probers', bridge('unreachable')), address: '', unchecked: 'no_port' },
      },
      { payment: soon },
    );
    expect(blind.detail).toContain(
      'Мост «Мост»: проверить нечем — у моста не найдена нода в Remnawave, и порт входа панель не знает.',
    );
    expect(blind.detail).not.toContain('другой причины панель не нашла');
    // Мост удалён из панели; Remnawave не ответила на запрос порта.
    const gone = { ...unchecked('no_probers', bridge('unreachable')), label: 'Мост', address: '' };
    expect(drop({ ...alive, entry: { ...gone, unchecked: 'gone' } }).detail).toContain(
      'Мост: проверить нечем — мост, указанный в профиле как вход, удалён из панели.',
    );
    expect(drop({ ...alive, entry: { ...gone, unchecked: 'remnawave' } }).detail).toContain(
      'проверить не удалось — Remnawave не ответила на запрос порта входа.',
    );
    // Адрес входа записан не как адрес.
    expect(drop({ ...alive, entry: unchecked('bad_address') }).detail).toContain(
      'проверить нельзя — адрес входа в профиле сервера записан не как домен или IP-адрес с портом.',
    );
  });

  it('оплаты в окне нет — текст и заголовок прежние', () => {
    const r = drop({ ...alive, entry: null });
    expect(r.title).toBe('Резко упал онлайн, блокировка не подтвердилась · guardora (Аренда)');
    expect(r.detail).toContain(
      'Вывод: блокировка не подтвердилась — возможно, сбой у провайдеров пользователей.',
    );
    expect(r.detail).not.toContain('💳');
    expect(drop({ ...alive, entry: null }, { payment: { overdue: [], dueSoon: [], paying: 3 } }).title).toBe(
      r.title,
    );
  });

  it('вход молчит при живом выходе — «сбой у провайдеров пользователей» не предлагаем: причина уже названа', () => {
    const r = drop({ ...alive, entry: entry('unreachable') });
    expect(r.title).toBe('Резко упал онлайн, блокировка не подтвердилась · guardora (Аренда)');
    expect(r.detail).toContain('Вывод: блокировка не подтвердилась.\nВыход отвечает, а вход — нет');
    expect(r.detail).not.toContain('сбой у провайдеров пользователей');
  });

  it('молчит свой мост — это не неоплата этого сервера: об оплате не пишем', () => {
    const r = drop(
      { ...alive, entry: bridge('unreachable') },
      { payment: { overdue: late.overdue, dueSoon: soon.dueSoon, paying: 2 } },
    );
    expect(r.title).toBe('Резко упал онлайн, блокировка не подтвердилась · guardora (Аренда)');
    expect(r.detail).toContain('похоже, лёг вход');
    expect(r.detail).not.toContain('💳');
    expect(r.detail).not.toContain('Вероятнее всего');
  });

  it('блокировка подтверждена — причина найдена, оплату не предлагаем', () => {
    for (const verdict of ['ip_block', 'tspu', 'block_16_20'] as const) {
      const r = drop(
        { ...alive, verdict, probes: [{ ...probe('unreachable'), verdict }], foreign: [probe('ok')] },
        { payment: { overdue: late.overdue, dueSoon: soon.dueSoon, paying: 2 } },
      );
      expect(r.confirmed, verdict).toBe(true);
      expect(r.title, verdict).not.toContain('оплат');
      expect(r.detail, verdict).not.toContain('💳');
    }
  });

  it('настоящая VPN-проба остаётся доказательством, даже если обычную SSH-проверку порта выполнить не удалось', () => {
    const failed = (from: string, country: string) => ({
      from,
      country,
      ok: false,
      stage: 'connect',
      detail: 'Повторная проба не прошла.',
      latencyMs: 10,
      bytes: 0,
    });
    const passed = (from: string, country: string) => ({
      from,
      country,
      ok: true,
      stage: 'done',
      detail: 'Маршрут работает.',
      latencyMs: 20,
      bytes: 65536,
    });
    const result = drop({
      ...base,
      probes: [],
      foreign: [],
      verdict: 'tspu',
      unchecked: null,
      entry: null,
      vpnVerdict: 'regional_block',
      vpnUnchecked: null,
      vpnProbes: [failed('Россия - 1', 'RU'), failed('Россия - 2', 'RU')],
      vpnForeign: [passed('Германия - 1', 'DE'), passed('Нидерланды - 1', 'NL')],
    });
    expect(result.confirmed).toBe(true);
    expect(result.title).toContain('Похоже на блокировку ТСПУ');
    expect(result.detail).toContain('настоящий VLESS/REALITY повторно не проходит');
    expect(result.detail).not.toContain('проверить не удалось');
  });

  it('сервер недоступен целиком, срок оплаты близко — «проверьте оплату», без догадки по названию', () => {
    const r = drop(down, { payment: soon });
    expect(r.kind).toBe('server_down');
    expect(r.title).toBe('Сервер недоступен — проверьте оплату · guardora (Аренда)');
    expect(r.detail).toContain(`💳 Срок оплаты близко: ${SOON}.`);
    expect(r.detail).toContain('Вероятнее всего: оплата закончилась чуть раньше срока, и сервер отключили');
    expect(r.detail).not.toContain('Сервер арендован');
  });

  it('догадка «сервер арендован» — только то, что панель знает о «Биллинге»', () => {
    // «Биллинг» не спрашивали: ноды нет среди серверов панели.
    const unknown = drop(down);
    expect(unknown.title).toBe('Сервер недоступен · guardora (Аренда)');
    expect(unknown.detail).toContain(
      'Сервер арендован: если он недоступен целиком, возможно, не оплачена аренда (оплату в «Биллинге» панель проверить не смогла).',
    );
    // Оплата самого сервера не заведена (сертификат или домен, привязанный к серверу, не в счёт).
    expect(drop(down, { payment: { overdue: [], dueSoon: [], paying: 0 } }).detail).toContain(
      '(оплата этого сервера в «Биллинге» не заведена — срока панель не знает).',
    );
    // Оплата заведена, срок не близко — неоплату не предлагаем вовсе.
    expect(drop(down, { payment: { overdue: [], dueSoon: [], paying: 1 } }).detail).not.toContain(
      'арендован',
    );
    // Имя не похоже на аренду — догадки нет.
    expect(drop(down, { nodeName: 'de-fra-01' }).detail).not.toContain('арендован');
  });

  it('агент на связи, а порт ноды закрыт отовсюду: сервер работает — ни «Сервер недоступен», ни оплаты', () => {
    const r = drop(down, {
      payment: { overdue: late.overdue, dueSoon: hosting.dueSoon, paying: 2 },
      serverAlive: true,
    });
    expect(r.title).toBe('Резко упал онлайн, порт ноды не отвечает · guardora (Аренда)');
    expect(r.kind).toBe('node_blocked');
    expect(r.confirmed).toBe(true);
    expect(r.detail).toContain(
      'Похоже: сервер работает (агент на связи), а порт ноды не отвечает ни из России, ни из-за рубежа — нода не слушает порт или его закрыл файрвол.',
    );
    for (const s of ['💳', 'Вероятнее всего', 'отключён хостером', 'арендован'])
      expect(r.detail, s).not.toContain(s);
    // Зарубежных проверяющих нет — про это сказано, вывод тот же: сервер работает.
    const ruOnly = drop(base, { payment: soon, serverAlive: true });
    expect(ruOnly.title).toBe('Резко упал онлайн, порт ноды не отвечает · guardora (Аренда)');
    expect(ruOnly.detail).toContain('проверить из-за рубежа нечем');
    expect(ruOnly.detail).not.toContain('💳');
  });

  it('первичное дело и Telegram называют пользовательский порт и не выдают его за SSH или пинг', () => {
    const r = drop(down, { nodePort: 443, serverAlive: true });
    expect(r.detail).toContain(
      'Проверяется пользовательский порт ноды 443; настоящий VPN-трафик отмечен отдельно от TCP и обычного TLS.',
    );
    expect(r.detail).toContain('Из России:');
    expect(r.detail).toContain('Из-за рубежа:');
  });

  it('из России порт молчит, из-за рубежа проверить нечем: сервер «недоступным» не называем, вывод без «вероятнее всего»', () => {
    const r = drop(base, { payment: soon });
    expect(r.kind).toBe('node_blocked');
    // Это может быть и блокировка IP из России: «Сервер недоступен» в заголовке было бы утверждением без проверки.
    expect(r.title).toBe('Резко упал онлайн — проверьте оплату · guardora (Аренда)');
    expect(r.detail).toContain(
      'Похоже: из России порт не отвечает; проверить из-за рубежа нечем — нет зарубежных серверов парка с рабочим SSH.',
    );
    expect(r.detail).toContain(
      'Проверьте оплату: из-за рубежа порт не проверен, а срок оплаты близко — возможно, сервер отключили чуть раньше срока.',
    );
    expect(r.detail).not.toContain('Вероятнее всего');
    expect(drop(base, { nodeName: 'de-fra-01' }).title).toBe(
      'Резко упал онлайн, порт из России не отвечает · de-fra-01',
    );
    // Зарубежные серверы в парке есть, но проверка с них не получилась — «нет зарубежных серверов» было бы неправдой.
    expect(drop({ ...base, foreignUnchecked: 'ssh' as const }).detail).toContain(
      'Похоже: из России порт не отвечает; проверить из-за рубежа не удалось — панель не зашла ни на один зарубежный сервер парка.',
    );
    expect(drop({ ...base, foreignUnchecked: 'no_answer' as const }, { serverAlive: true }).detail).toContain(
      'а порт ноды из России не отвечает; проверить из-за рубежа не удалось — команда проверки на зарубежных серверах парка не вернула результата.',
    );
  });

  it('порт отвечает с перебоями: сервер работает — ни «Сервер недоступен», ни «вероятнее всего оплата»', () => {
    const mixed = {
      ...alive,
      probes: [probe('ok'), probe('unreachable', 'Россия - 1'), probe('unreachable', 'Россия - 2')],
      verdict: 'partial' as const,
    };
    const r = drop(
      { ...mixed, entry: null },
      { payment: { ...soon, dueSoon: [...soon.dueSoon, ...hosting.dueSoon] } },
    );
    expect(r.kind).toBe('node_blocked');
    expect(r.title).toBe('Резко упал онлайн, порт отвечает с перебоями · guardora (Аренда)');
    // Панель называет, что видела: с кого порт отвечает, а с кого нет, — без «или не каждый раз», которого в
    // данных нет (замечание «панели оценки»: «ничего не перебивается, картина одна и та же»).
    expect(r.detail).toContain(
      'Похоже: порт ноды отвечает не со всех российских проверяющих серверов: отвечает с Мост, не отвечает с Россия - 1, Россия - 2. Сервер работает, но из части сетей до него не достучаться',
    );
    // Один и тот же проверяющий подключается через раз — сказано именно это.
    const flaky = drop({
      ...alive,
      probes: [
        {
          ...probe('ok'),
          verdict: 'partial' as const,
          detail: 'Порт отвечает не каждый раз: подключение прошло в 1 из 3 попыток.',
        },
      ],
      verdict: 'partial' as const,
      entry: null,
    });
    expect(flaky.detail).toContain('Похоже: порт ноды отвечает не каждый раз: Мост подключается через раз.');
    expect(flaky.detail).not.toContain('не со всех');
    for (const s of [
      'Вероятнее всего',
      'сервер выключен',
      'отключён хостером',
      'блокировка IP на стороне России',
    ])
      expect(r.detail, s).not.toContain(s);
    // Аренду просим проверить «заодно», оплата хостинга работающего сервера в дело не идёт.
    expect(r.detail).toContain(`💳 Срок оплаты близко: ${SOON}.`);
    expect(r.detail).not.toContain(HOSTING);
    expect(r.detail).toContain('Заодно проверьте оплату: срок аренды близко. Порт отвечает с перебоями');
    // Без оплаты в окне — ни строки об оплате.
    expect(drop({ ...mixed, entry: null }).detail).not.toContain('оплат');
  });

  it('вход арендодателя не отвечает и аренда просрочена — это важнее перебоев самого выхода', () => {
    const r = drop(
      {
        ...alive,
        probes: [probe('ok'), probe('unreachable', 'Россия - 1')],
        verdict: 'partial',
        entry: entry('unreachable'),
      },
      { payment: late },
    );
    expect(r.title).toBe('Резко упал онлайн — проверьте оплату · guardora (Аренда)');
    expect(r.detail).toContain('вход арендодателя проверен и не отвечает, а аренда находится в окне оплаты');
    expect(r.detail).toContain(`💳 Просрочена оплата: ${LATE}.`);
    expect(r.detail).toContain('Вероятнее всего: вход отключили за неоплату');
    expect(r.detail).toContain('Перебои выхода могут быть отдельной проблемой');
    expect(r.detail).not.toContain('Заодно проверьте оплату');
    expect(r.detail).not.toContain('начните с выхода');
  });

  it('недоступны сразу несколько нод — общая причина: «вероятнее всего… сервер отключили» не пишем и оплату в заголовок не ставим', () => {
    const r = drop(down, { payment: soon, othersDown: 2 });
    expect(r.kind).toBe('server_down');
    expect(r.title).toBe('Сервер недоступен · guardora (Аренда)');
    expect(r.detail).toContain(`💳 Срок оплаты близко: ${SOON}.`);
    expect(r.detail).toContain(
      'Заодно проверьте оплату: срок оплаты этого сервера близко. Онлайн упал сразу у нескольких нод — это больше похоже на общую причину; если они у одного хостера, ею может быть и оплата.',
    );
    expect(r.detail).not.toContain('Вероятнее всего');
    // Один — как раньше.
    expect(drop(down, { payment: soon }).detail).toContain('Вероятнее всего');
  });

  it('проверить не удалось, а оплата в окне — просим проверить оплату, без «вероятнее всего»', () => {
    const r = drop({ ...base, probes: [], verdict: 'unreachable' }, { payment: soon });
    expect(r.title).toBe('Резко упал онлайн — проверьте оплату · guardora (Аренда)');
    expect(r.confirmed).toBe(false);
    expect(r.detail).toContain('Проверить не удалось');
    expect(r.detail).toContain(`💳 Срок оплаты близко: ${SOON}.`);
    expect(r.detail).toContain('Проверьте оплату: встречная проверка не удалась, а срок оплаты близко');
    expect(r.detail).not.toContain('Вероятнее всего');
    expect(drop({ ...base, probes: [], verdict: 'unreachable' }).title).toBe(
      'Резко упал онлайн, проверить не удалось · guardora (Аренда)',
    );
  });

  it('проверить не удалось, а агент на связи: сервер работает — оплату хостинга проверить не просим, аренду — просим', () => {
    const unchecked = { ...base, probes: [], verdict: 'unreachable' as const };
    const r = drop(unchecked, { payment: hosting, serverAlive: true });
    expect(r.title).toBe('Резко упал онлайн, проверить не удалось · guardora (Аренда)');
    expect(r.detail).not.toContain('💳');
    expect(r.detail).not.toContain('оплат');
    // Агент молчит — хостер мог и отключить.
    expect(drop(unchecked, { payment: hosting }).title).toBe(
      'Резко упал онлайн — проверьте оплату · guardora (Аренда)',
    );
    const rent = drop(unchecked, { payment: soon, serverAlive: true });
    expect(rent.title).toBe('Резко упал онлайн — проверьте оплату · guardora (Аренда)');
    expect(rent.detail).toContain('встречная проверка не удалась, а срок оплаты аренды близко');
  });

  it('почему проверка не состоялась — настоящая причина, а не одна на все случаи', () => {
    expect(uncheckedLine({ unchecked: 'no_port' })).toBe(
      'Проверить не удалось: в Remnawave не нашёлся порт подключения этой ноды.',
    );
    expect(uncheckedLine({ unchecked: 'bad_address' })).toContain(
      'записаны в Remnawave с недопустимыми знаками',
    );
    expect(uncheckedLine({ unchecked: 'no_probers' })).toBe(
      'Проверить не удалось: нет ни одного российского сервера парка с рабочим SSH для встречной проверки.',
    );
    expect(uncheckedLine({ unchecked: 'ssh' })).toBe(
      'Проверить не удалось: панель не зашла по SSH ни на один российский проверяющий сервер.',
    );
    // Панель зашла, но сама проверка на проверяющем не отработала — это не «не зашла» и не «порт закрыт».
    expect(uncheckedLine({ unchecked: 'no_answer' })).toBe(
      'Проверить не удалось: команда проверки на российских проверяющих серверах не вернула результата.',
    );
    // Причина не записана (старый результат) — по тому, нашёлся ли порт.
    expect(uncheckedLine({ unchecked: null }, false)).toContain('не нашёлся порт');
    expect(uncheckedLine({ unchecked: null }, true)).toContain('нет ни одного российского сервера');
    expect(
      drop({ ...base, probes: [], verdict: 'unreachable' as const, unchecked: 'ssh' as const }).detail,
    ).toContain('панель не зашла по SSH ни на один российский проверяющий сервер');
  });

  it('имя маскировки неизвестно: порт отвечает, но блокировку не проверить — оплату просим проверить без «другой причины не нашли»', () => {
    const r = drop({ ...alive, sniUsed: null, entry: null }, { payment: soon });
    expect(r.title).toBe('Резко упал онлайн — проверьте оплату · guardora (Аренда)');
    expect(r.detail).toContain('Вывод: порт отвечает. Блокировку ТСПУ и «16–20 КБ» проверить нельзя');
    expect(r.detail).toContain(
      'Проверьте оплату: порт отвечает, но блокировку панель проверить не может, а срок оплаты близко',
    );
    expect(r.detail).not.toContain('другой причины панель не нашла');
    expect(r.detail).not.toContain('Вероятнее всего');
  });

  it('онлайн упал сразу у нескольких нод — общая причина: заголовок прежний, оплата — строкой «заодно»', () => {
    const r = drop({ ...alive, entry: null }, { payment: soon, othersDown: 4 });
    expect(r.title).toBe('Резко упал онлайн, блокировка не подтвердилась · guardora (Аренда)');
    expect(r.detail).toContain(`💳 Срок оплаты близко: ${SOON}.`);
    expect(r.detail).toContain(
      'Заодно проверьте оплату: срок аренды близко. Онлайн упал сразу у нескольких нод — это больше похоже на общую причину.',
    );
    expect(r.detail).not.toContain('Вероятнее всего');
    // Арендованный вход молчит — это своё, отдельное свидетельство: оно важнее общей картины.
    expect(drop({ ...alive, entry: entry('unreachable') }, { payment: soon, othersDown: 4 }).title).toBe(
      'Резко упал онлайн — проверьте оплату · guardora (Аренда)',
    );
  });

  it('в то же время пропала связь с другими серверами, а онлайн у них не падал — так и сказано', () => {
    const r = drop({ ...alive, entry: null }, { payment: soon, othersLost: 1 });
    expect(r.title).toBe('Резко упал онлайн, блокировка не подтвердилась · guardora (Аренда)');
    expect(r.detail).toContain(
      'Заодно проверьте оплату: срок аренды близко. В это же время пропала связь с другими серверами — это больше похоже на общую причину.',
    );
    expect(r.detail).not.toContain('Онлайн упал сразу у нескольких нод');
    expect(r.detail).not.toContain('Вероятнее всего');
    // И онлайн упал у другой ноды, и связь пропала с сервером — называем онлайн: это то же, что случилось здесь.
    expect(drop({ ...alive, entry: null }, { payment: soon, othersDown: 1, othersLost: 2 }).detail).toContain(
      'Онлайн упал сразу у нескольких нод',
    );
  });

  it('итог «в норме», но соединение обрывается на небольшом объёме — «другой причины панель не нашла» не пишем', () => {
    const cut = {
      ...probe('ok', 'Россия - 1'),
      detail: 'Соединение тихо обрывается на объёме около 8 КБ без явного отказа.',
      stalledAtKb: 8,
    };
    const r = drop({ ...alive, probes: [probe('ok'), cut], entry: null }, { payment: late });
    // Обрыв — находка: заголовок «блокировка не подтвердилась» её прятал.
    expect(r.title).toBe('Резко упал онлайн, соединение с нодой обрывается · guardora (Аренда)');
    expect(r.detail).toContain(
      'Вывод: признаков блокировки ТСПУ и «16–20 КБ» нет, но соединение с нодой обрывается на небольшом объёме данных — возможны помехи на пути.',
    );
    expect(r.detail).toContain(
      'Заодно проверьте оплату: аренда просрочена. Соединение с нодой обрывается на небольшом объёме данных',
    );
    for (const s of ['Вероятнее всего', 'другой причины панель не нашла', 'сбой у провайдеров пользователей'])
      expect(r.detail, s).not.toContain(s);
    // Без обрыва — как раньше.
    expect(drop({ ...alive, entry: null }, { payment: late }).detail).toContain(
      'другой причины панель не нашла',
    );
  });

  it('адрес входа: порт по умолчанию 443', () => {
    expect(splitUpstreamAddress('entry.example.com')).toEqual({ host: 'entry.example.com', port: 443 });
    expect(splitUpstreamAddress('1.2.3.4:8443')).toEqual({ host: '1.2.3.4', port: 8443 });
    expect(isExitOnly(['exit'])).toBe(true);
    expect(isExitOnly(['entry', 'exit'])).toBe(false);
  });
});

describe('проверка «из каждой страны»', () => {
  const all = [
    { id: 'de1', name: 'Германия-1', sshOk: true, country: country('DE') },
    { id: 'de2', name: 'Германия-2', sshOk: true, country: country('DE') },
    { id: 'nl', name: 'Нидерланды', sshOk: true, country: country('NL') },
    { id: 'ru', name: 'Мост', sshOk: true, country: country('RU') },
    { id: 'pl', name: 'Польша', sshOk: false, country: country('PL') },
    { id: 'x', name: 'Без страны', sshOk: true, country: country(null) },
    { id: 'kz', name: 'Казахстан', sshOk: true, country: country('KZ') },
  ];

  it('Россия первой, дальше по одному серверу на страну, без цели, без упавших и без страны', () => {
    expect(pickCountryProbes('kz', all).map((s) => s.id)).toEqual(['ru', 'de1', 'nl']);
  });

  it('не больше max', () => {
    expect(pickCountryProbes('kz', all, 2).map((s) => s.id)).toEqual(['ru', 'de1']);
  });

  it('из-за рубежа — по одному на страну, Россию не берёт', () => {
    expect(pickForeignProbes('kz', all).map((s) => s.id)).toEqual(['de1', 'nl', 'de2']);
  });

  it('строки дела: по серверу на строку и сервер панели', () => {
    expect(
      countryReachLines(
        [
          { from: 'Мост', country: 'RU', open: false },
          { from: 'Германия-1', country: 'DE', open: true },
        ],
        false,
      ),
    ).toEqual([
      '• Мост — порт не отвечает',
      '• Германия-1 — порт открыт',
      '• Сервер панели — порт не отвечает',
    ]);
    expect(countryReachLines([], null)).toEqual([]);
  });
});

describe('команда проверки на самом деле доходит до адреса', () => {
  // Регрессия «Казахстан-1»: адрес уходил во вложенный bash как «\$addr», где переменной нет, — порт
  // «не отвечал» отовсюду. Гоняем настоящую команду против открытого и закрытого порта на этой машине.
  const run = (port: number): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ns-bc-'));
    // На macOS нет timeout — подставляем простую замену, на Linux берётся настоящий.
    const shim = join(dir, 'timeout');
    writeFileSync(shim, '#!/bin/sh\nshift\nexec "$@"\n');
    chmodSync(shim, 0o755);
    const cmd = buildBlockCheckCommand('127.0.0.1', port, null);
    return execFileSync('sh', ['-c', cmd], {
      env: { ...process.env, PATH: `${process.env.PATH}:${dir}` },
      encoding: 'utf8',
    });
  };

  /** Настоящая команда с урезанным набором программ: в PATH только то, что перечислено. */
  const runWith = (tools: string[], port: number, sni: string | null): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ns-bc-tools-'));
    for (const t of tools) {
      const file = join(dir, t);
      if (t === 'timeout') writeFileSync(file, '#!/bin/sh\nshift\nexec "$@"\n');
      else
        writeFileSync(
          file,
          `#!/bin/sh\nexec ${execFileSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim()} "$@"\n`,
        );
      chmodSync(file, 0o755);
    }
    return execFileSync('/bin/sh', ['-c', buildBlockCheckCommand('127.0.0.1', port, sni)], {
      env: { PATH: dir },
      encoding: 'utf8',
    });
  };

  it('на проверяющем нет нужной программы — команда так и говорит, а не «порт закрыт» и не «ТСПУ»', async () => {
    const srv = createServer((s) => s.end());
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    try {
      // Нет timeout: раньше для ОТКРЫТОГО порта выходило «порт не отвечает совсем».
      const noTimeout = parseBlockCheckOutput('тест', runWith(['sh', 'bash'], port, null));
      expect(noTimeout.error).toBe('tools');
      expect(noTimeout.detail).toContain('нет нужной программы (timeout)');
      // Нет openssl: раньше выходило «похоже на блокировку ТСПУ».
      const noOpenssl = parseBlockCheckOutput(
        'тест',
        runWith(['sh', 'bash', 'timeout'], port, 'www.example.com'),
      );
      expect(noOpenssl).toMatchObject({ verdict: 'ok', error: null });
      expect(noOpenssl.detail).toContain('нет нужной программы (openssl)');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('открытый порт — «порт отвечает», закрытый — «не отвечает»', async () => {
    const srv = createServer((s) => s.end());
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    try {
      expect(parseBlockCheckOutput('тест', run(port)).verdict).toBe('ok');
    } finally {
      await new Promise((r) => srv.close(r));
    }
    expect(parseBlockCheckOutput('тест', run(port)).verdict).toBe('unreachable');
  });
});

describe('итог попыток с одного сервера — без ложных выводов', () => {
  const at = (verdict: BlockProbeResult['verdict'], error: string | null = null): BlockProbeResult => ({
    from: 'Мост',
    verdict,
    detail: verdict,
    stalledAtKb: null,
    error,
  });
  it('только порт: одно удачное подключение — порт открыт', () => {
    expect(settleAttempts([at('unreachable'), at('ok'), at('unreachable')], true)?.verdict).toBe('ok');
  });
  it('полная проверка: большинство, ничья — по приоритету', () => {
    expect(settleAttempts([at('tspu'), at('ok'), at('ok')], false)?.verdict).toBe('ok');
    expect(settleAttempts([at('tspu'), at('tspu'), at('ok')], false)?.verdict).toBe('tspu');
    expect(settleAttempts([at('tspu'), at('ok')], false)?.verdict).toBe('tspu');
  });
  it('полная проверка: одна попытка прошла, остальные нет — «отвечает не каждый раз», а не «порт не отвечает совсем»', () => {
    // Этот же проверяющий только что подключился: назвать порт закрытым (и вывести «блокировка IP») нельзя.
    expect(settleAttempts([at('ok'), at('unreachable'), at('unreachable')], false)).toEqual({
      from: 'Мост',
      verdict: 'partial',
      detail: 'Порт отвечает не каждый раз: подключение прошло в 1 из 3 попыток.',
      stalledAtKb: null,
      error: null,
    });
    // Ничья после сбоя входа на проверяющий — то же.
    expect(settleAttempts([at('ok'), at('unreachable'), at('unreachable', 'ssh')], false)?.detail).toBe(
      'Порт отвечает не каждый раз: подключение прошло в 1 из 2 попыток.',
    );
    // Большинство удачных — в норме; ни одной удачной — не отвечает.
    expect(settleAttempts([at('ok'), at('ok'), at('unreachable')], false)?.verdict).toBe('ok');
    expect(settleAttempts([at('unreachable'), at('unreachable'), at('unreachable')], false)?.verdict).toBe(
      'unreachable',
    );
  });
  it('порт открылся, а оборвался TLS или поток данных — порт всё равно ответил: это не «порт не отвечает совсем»', () => {
    // Находка четвёртой проверки: [TLS оборвался, закрыт, закрыт] давало «порт не отвечает совсем», а с
    // открытым из-за рубежа портом — «блокировку IP из России».
    const tls = parseBlockCheckOutput('Мост', '{"stage":"tls","ok":false,"stalledAtKb":null}');
    const stall16 = parseBlockCheckOutput('Мост', '{"stage":"data","ok":false,"stalledAtKb":16}');
    const dead = parseBlockCheckOutput('Мост', '{"stage":"tcp","ok":false,"stalledAtKb":null}');
    for (const first of [tls, stall16])
      expect(settleAttempts([first, dead, dead], false)).toMatchObject({
        verdict: 'partial',
        detail: 'Порт отвечает не каждый раз: подключение прошло в 1 из 3 попыток.',
      });
    // Даже повторный обрыв обычного TLS не выдаём за доказательство блокировки REALITY.
    expect(settleAttempts([tls, tls, dead], false)?.verdict).toBe('indeterminate');
  });
  it('обрыв на небольшом объёме не прячется за чистой первой попыткой — и не раздувается из одной', () => {
    const clean = parseBlockCheckOutput('Мост', '{"stage":"data","ok":true,"stalledAtKb":null}');
    const stall8 = parseBlockCheckOutput('Мост', '{"stage":"data","ok":false,"stalledAtKb":8}');
    expect(stall8.verdict).toBe('indeterminate');
    // Раньше итогом бралась первая попытка «в норме» — порядок попыток менял вывод.
    expect(settleAttempts([clean, stall8, stall8], false)).toMatchObject({
      verdict: 'indeterminate',
      stalledAtKb: 8,
    });
    expect(settleAttempts([stall8, stall8, clean], false)).toMatchObject({
      verdict: 'indeterminate',
      stalledAtKb: 8,
    });
    expect(settleAttempts([stall8, clean, clean], false)).toMatchObject({ verdict: 'ok', stalledAtKb: null });
    expect(settleAttempts([clean, clean, stall8], false)).toMatchObject({ verdict: 'ok', stalledAtKb: null });
    // Поровну — находку не прячем.
    expect(settleAttempts([clean, stall8], false)).toMatchObject({ stalledAtKb: 8 });
  });
  it('на проверяющем нет нужной программы — это не результат проверки цели', () => {
    // Без timeout или bash порт не проверить вовсе: проба о цели ничего не говорит.
    const none = parseBlockCheckOutput(
      'Мост',
      '{"stage":"tools","ok":false,"stalledAtKb":null,"missing":"timeout"}',
    );
    expect(probeSaw(none)).toBe(false);
    expect(none.detail).toBe(
      'Проверка не состоялась: на проверяющем сервере нет нужной программы (timeout).',
    );
    expect(settleAttempts([none, none, none], false)).toBeNull();
    // Порт ответил, а TLS проверить нечем: «порт отвечает», а не «обрыв TLS» и не ТСПУ.
    const noTls = parseBlockCheckOutput(
      'Мост',
      '{"stage":"port","ok":true,"stalledAtKb":null,"missing":"openssl"}',
    );
    expect(noTls).toMatchObject({
      verdict: 'ok',
      error: null,
      detail:
        'Порт отвечает. Блокировку ТСПУ и «16–20 КБ» проверить не удалось: на проверяющем сервере нет нужной программы (openssl).',
    });
    // TLS прошёл, а передачу данных проверить нечем: «прошло без обрывов» сказать нельзя.
    const noData = parseBlockCheckOutput(
      'Мост',
      '{"stage":"tls","ok":true,"stalledAtKb":null,"missing":"curl"}',
    );
    expect(noData.verdict).toBe('ok');
    expect(noData.detail).toContain('Блок «16–20 КБ» проверить не удалось');
    expect(noData.detail).not.toContain('без обрывов');
    // Мусор в названии программы в текст не попадает.
    expect(
      parseBlockCheckOutput('Мост', '{"stage":"tools","ok":false,"stalledAtKb":null,"missing":"x; rm -rf /"}')
        .error,
    ).toBe('Пустой или неразобранный ответ.');
  });
  it('панель хоть раз зашла на проверяющий — причина «команда не вернула результата», а не «панель не зашла»', () => {
    const empty = parseBlockCheckOutput('Мост', '');
    const ssh = at('unreachable', 'ssh');
    expect(blindAttempt([ssh, empty, empty]).error).not.toBe('ssh');
    expect(blindReason([blindAttempt([ssh, empty, empty])])).toBe('no_answer');
    expect(blindReason([blindAttempt([ssh, ssh, ssh])])).toBe('ssh');
  });
  it('не зашли на проверяющий сервер — попытка не считается; ни одной — «проверить не удалось»', () => {
    expect(settleAttempts([at('unreachable', 'ssh'), at('ok')], false)?.verdict).toBe('ok');
    expect(settleAttempts([at('unreachable', 'ssh'), at('unreachable', 'ssh')], true)).toBeNull();
  });
  it('ответ проверяющего не удалось разобрать — о цели он ничего не говорит: попытка не считается', () => {
    // Команда на проверяющем не отработала (пустой вывод): раньше это записывалось как «порт не отвечает».
    const garbled = parseBlockCheckOutput('Мост', 'bash: timeout: command not found');
    expect(garbled.error).not.toBeNull();
    expect(probeSaw(garbled)).toBe(false);
    expect(settleAttempts([garbled, at('ok'), garbled], false)?.verdict).toBe('ok');
    expect(settleAttempts([garbled, garbled, garbled], false)).toBeNull();
    // В итог проверки входа такая проба тоже не идёт.
    expect(settleEntry([garbled]).probes).toEqual([]);
    expect(blindReason([garbled, at('unreachable', 'ssh')])).toBe('no_answer');
    expect(blindReason([at('unreachable', 'ssh')])).toBe('ssh');
  });
});
