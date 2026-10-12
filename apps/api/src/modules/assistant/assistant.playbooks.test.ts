import { INCIDENT_KINDS } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { FLEET_RULES_WHITELIST_SECTION } from '../knowledge/fleet-rules.js';
import {
  LEGACY_EVENT_KINDS,
  NODE_EVENT_KINDS,
  PLAYBOOKS,
  playbookById,
  playbookForKind,
  renderPlaybook,
} from './assistant.playbooks.js';
import { ASSISTANT_TOOLS } from './assistant.tools.js';

const tools = new Set(ASSISTANT_TOOLS.map((t) => t.name));
const playbookIds = new Set(PLAYBOOKS.map((p) => p.id));
const kinds = new Set<string>(INCIDENT_KINDS);
const textOf = (id: string): string => renderPlaybook(playbookById(id) as never);
const all = PLAYBOOKS.map(renderPlaybook).join('\n\n');

/**
 * Латиница, которая допустима в плейбуках: названия сервисов и протоколов, которые владелец видит в интерфейсе,
 * и поля данных, которые модель читает в ответах инструментов. Остальное пишется по-русски.
 */
const LATIN_OK = new Set([
  'DPI',
  'Checker',
  'BS',
  'Check-Host',
  'Remnawave',
  'TCP',
  'DNS',
  'IP',
  'VLESS',
  'VPN',
  'CPU',
  'RAM',
  'SNI',
  'load',
  'average',
  'isConnected',
  'false',
  'isConnecting',
  'isDisabled',
  'lastStatusMessage',
  'checkedAt',
  'fresh',
  'cert',
  'expired',
  'warn',
  'usersOnline',
  'cpuCount',
  'loadAverage',
  'nodeUuid',
]);

describe('плейбуки по нодам', () => {
  it('id не повторяются; у каждого нынешнего вида события есть плейбук, у старых видов — нет', () => {
    expect(playbookIds.size).toBe(PLAYBOOKS.length);
    expect([...playbookIds].sort()).toEqual(
      [
        'domain_blocked',
        'high_load',
        'node_offline',
        'online_drop',
        'server_unreachable',
        'whitelist_server',
      ].sort(),
    );
    for (const { kind } of NODE_EVENT_KINDS) expect(playbookForKind(kind), kind).toBeDefined();
    for (const kind of LEGACY_EVENT_KINDS)
      expect(
        PLAYBOOKS.some((p) => (p.kinds as string[]).includes(kind)),
        kind,
      ).toBe(false);
  });

  it('каждый вид события из общих контрактов — либо нынешний, либо старый (история)', () => {
    const known = new Set<string>([...NODE_EVENT_KINDS.map((k) => k.kind), ...LEGACY_EVENT_KINDS]);
    for (const kind of kinds) expect(known.has(kind), `вид ${kind} не описан`).toBe(true);
  });

  it('называются только существующие инструменты чтения и записи и id плейбуков', () => {
    for (const p of PLAYBOOKS) {
      const text = [...p.steps, ...p.reading, ...p.recommend, ...p.limits, p.when].join(' ');
      for (const token of text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])
        expect(tools.has(token) || playbookIds.has(token) || kinds.has(token), `${p.id}: «${token}»`).toBe(
          true,
        );
      // Шаги — это данные панели: хотя бы один шаг зовёт инструмент.
      expect(
        p.steps.some((s) => [...tools].some((t) => s.includes(t))),
        p.id,
      ).toBe(true);
    }
  });

  it('нет SSH, терминала, агента, автопочинки, команд Linux и уровней действий', () => {
    for (const bad of [
      'SSH',
      'терминал',
      'агент',
      'автопочин',
      'docker',
      'systemctl',
      'journalctl',
      'sysctl',
      'dmesg',
      'apt ',
      'reboot',
      'перезагруз',
      'propose_',
      'inspect_',
      'run_server_check',
      'check_reachability',
      'get_server',
      'get_fleet',
      'get_metrics_history',
      'get_maintenance',
      'get_node_tcp_checks',
      'recommend_check',
    ])
      expect(all, bad).not.toContain(bad);
    expect(all).not.toMatch(/\bT[0-3]\b/);
  });

  it('пишутся по-русски: латиница только в названиях сервисов, протоколов и полях данных', () => {
    // «Check-Host» — одно слово; у «TCP-порт» берётся только «TCP».
    const latin = new Set(all.match(/[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/g) ?? []);
    const extra = [...latin].filter((w) => !LATIN_OK.has(w) && !tools.has(w) && !playbookIds.has(w));
    // Имена инструментов и id разбиваются по «_»: их части здесь не считаются.
    const parts = new Set([...tools, ...playbookIds].flatMap((n) => n.split('_')));
    expect(extra.filter((w) => !parts.has(w))).toEqual([]);
  });

  it('каждый плейбук рекомендует и честно говорит, чего панель не видит; запускает владелец', () => {
    for (const p of PLAYBOOKS) {
      expect(p.recommend.length, p.id).toBeGreaterThan(0);
      expect(p.limits.length, p.id).toBeGreaterThan(0);
      const text = renderPlaybook(p);
      expect(text).toContain(`ПЛЕЙБУК «${p.title}» (${p.id})`);
      expect(text).toContain('вы ничего не запускаете и не меняете');
      expect(text).toContain('не больше двух рекомендаций');
    }
  });

  it('проверки — рекомендацией с путём по интерфейсу; DPI и BS не советуются при закрытом порте', () => {
    expect(textOf('node_offline')).toContain('«Ноды» → окно ноды → «Подключение» → «Проверить порт»');
    const drop = textOf('online_drop');
    expect(drop).toContain('«DPI Checker» → «Новая проверка»');
    expect(drop).toContain('«IP — доступность адреса»');
    expect(drop).toContain('«VLESS — подключение к VPN»');
    expect(drop).toContain('не доказывает, что VPN проходит ТСПУ');
    expect(textOf('server_unreachable')).toContain('DPI Checker и BS Checker не советуйте');
    const bs = textOf('whitelist_server');
    expect(bs).toContain(`«${FLEET_RULES_WHITELIST_SECTION}»`);
    expect(bs).toContain('По названию ноды не угадывайте');
    expect(bs).toContain('«БС активен»');
    expect(bs).toContain('«Без БС»');
    expect(bs).toContain('«Рассчитать стоимость» (бесплатно)');
    expect(bs).toContain('«Арендованные точки входа»');
    expect(textOf('high_load')).toContain('«Обзор» → «Ёмкость»');
    expect(textOf('domain_blocked')).toContain('«DNS интеграции» → «Все DNS-записи»');
  });

  it('окно оплаты: вид оплаты важен, неполная проверка — без «вероятнее всего», ограничение важнее оплаты', () => {
    for (const id of ['node_offline', 'server_unreachable']) {
      const text = textOf(id);
      expect(text, id).toContain('в окне оплаты');
      expect(text, id).toContain('«Сертификат», «Домен» и «Другое»');
    }
    expect(textOf('node_offline')).toContain('настоящий баланс у хостера или арендодателя ей не виден');
    const drop = textOf('online_drop');
    expect(drop).toContain('арендодатель выключает вход, а выход (нода) продолжает работать');
    expect(drop).toContain(
      '«Вероятнее всего» — только при полной проверке; проверка неполная — «проверьте оплату»',
    );
    expect(drop).toContain('Ограничение из России подтверждено — оплату причиной не называйте');
    expect(textOf('server_unreachable')).toContain(
      'Сбой сразу у нескольких нод одного провайдера: первой назовите провайдера',
    );
  });

  it('падение онлайна: сначала — вернулся ли онлайн; вердикты Check-Host называются как в интерфейсе', () => {
    const drop = textOf('online_drop');
    expect(drop).toContain('Сначала сравните текущий онлайн с онлайном до падения');
    for (const verdict of ['«Недоступен из РФ»', '«Доступен»', '«Неполный результат»'])
      expect(drop).toContain(verdict);
    expect(textOf('server_unreachable')).toContain('ни из России, ни из других стран');
  });
});
