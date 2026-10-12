import {
  BILLING_KIND_LABELS,
  CHANGELOG,
  MONITORING_DEFAULTS,
  scenarioActionLabels,
  scenarioLabels,
} from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { FLEET_RULES_WHITELIST_SECTION } from '../knowledge/fleet-rules.js';
import { LEGACY_EVENT_KINDS, NODE_EVENT_KINDS, PLAYBOOKS } from './assistant.playbooks.js';
import { CHECK_RULES, REFERENCE, referenceById } from './assistant.reference.js';
import { ASSISTANT_TOOLS } from './assistant.tools.js';

const M = MONITORING_DEFAULTS;
/** Инструменты модели и ключи действий сценариев: check_tcp — действие сценария, а не инструмент. */
const TOOL_NAMES = new Set(ASSISTANT_TOOLS.map((t) => t.name));
const SCENARIO_KEYS = new Set(Object.keys(scenarioActionLabels));
const TOOL_LIKE = /\b(?:get|search|list|save|add|run|check|inspect|propose)_[a-z_]+\b/g;
const REMOVED = /SSH|агент|терминал|автопочин/i;
const NEGATION = /(?:^|[^а-яё])(?:нет|не|ни|без)(?:[^а-яё]|$)|истори|прежн|убран|удалён|больше не/i;
const topic = (id: string): string => referenceById(id)?.render() ?? '';
/** Всё, кроме истории версий: в ней законно упоминается то, чего в панели больше нет. */
const current = REFERENCE.filter((t) => t.id !== 'changelog');

const sentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

describe('справочник Ассистента', () => {
  it('темы уникальны, у каждой есть название, когда открывать и содержательный текст', () => {
    const ids = REFERENCE.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of REFERENCE) {
      const text = t.render();
      expect(t.title, t.id).toBeTruthy();
      expect(t.when.length, t.id).toBeGreaterThan(20);
      expect(text.length, t.id).toBeGreaterThan(600);
      expect(text, t.id).not.toMatch(/undefined|NaN|\[object|\$\{/);
    }
  });

  it('набор тем: удалённые темы ушли, новые есть', () => {
    expect(REFERENCE.map((t) => t.id).sort()).toEqual(
      [
        'answers',
        'billing',
        'blocking',
        'changelog',
        'checks',
        'entities',
        'incidents',
        'integrations',
        'kb',
        'metrics',
        'navigation',
        'remnawave',
        'scenarios',
        'security',
        'self',
        'vpn-stack',
      ].sort(),
    );
    for (const gone of ['actions', 'maintenance', 'fleet', 'changes', 'linux'])
      expect(referenceById(gone), gone).toBeUndefined();
    expect(referenceById(' KB ')?.id).toBe('kb');
    expect(referenceById('нет-такой')).toBeUndefined();
  });

  it('называются только существующие инструменты; удалённых инструментов и команд Linux нет', () => {
    for (const t of current) {
      const text = t.render();
      const unknown = [...new Set(text.match(TOOL_LIKE) ?? [])].filter(
        (n) => !TOOL_NAMES.has(n) && !SCENARIO_KEYS.has(n),
      );
      expect(unknown, t.id).toEqual([]);
      for (const bad of [
        'get_node_tcp_checks',
        'docker',
        'systemctl',
        'journalctl',
        'sysctl',
        'dmesg',
        'iptables',
        'apt ',
        'rm -rf',
        'Установить агента',
        'окне сервера',
        'Серверы → Провайдеры',
        'server.',
        'autofix',
      ])
        expect(text, `${t.id}: ${bad}`).not.toContain(bad);
      expect(text, t.id).not.toMatch(/\bT[0-3]\b/);
    }
  });

  it('удалённое (SSH, терминал, агент, автопочинка) упоминается только с отрицанием или как история', () => {
    for (const t of current) {
      const bad = sentences(t.render()).filter((s) => REMOVED.test(s) && !NEGATION.test(s));
      expect(bad, t.id).toEqual([]);
    }
  });

  it('проверки: три проверки с путями, стоимость, вердикты, правила рекомендаций и их формулировка', () => {
    const text = topic('checks');
    expect(text).toContain(CHECK_RULES);
    expect(text).toContain('«Ноды» → окно ноды → «Подключение» → «Проверить порты»');
    expect(text).toContain('«DPI Checker» → «Новая проверка»');
    expect(text).toContain('«BS Checker» → «Нода для проверки»');
    for (const verdict of ['«Доступен»', '«Недоступен из РФ»', '«Порты не отвечают»', '«Неполный результат»'])
      expect(text).toContain(verdict);
    expect(text).toContain('TCP через Check-Host — бесплатно');
    expect(text).toContain('DPI Checker — платно');
    expect(text).toContain('BS Checker — платно, в кредитах');
    expect(text).toContain(`по умолчанию ${M.checkHostPort}`);
    expect(text).toContain('Рекомендую проверить:');
    expect(text).toContain('Запускаете вы.');
  });

  it('правила рекомендаций: свежий результат пересказывается, не больше двух, никаких «запустил»', () => {
    expect(CHECK_RULES).toContain('Есть свежий результат — перескажи его, новую проверку не советуй');
    expect(CHECK_RULES).toContain('DPI моложе часа и БС моложе суток повторять не советуй');
    expect(CHECK_RULES).toContain('DPI Checker и BS Checker не советуй: при закрытом порте');
    expect(CHECK_RULES).toContain(`«${FLEET_RULES_WHITELIST_SECTION}»`);
    expect(CHECK_RULES).toContain('Деньги списываются только по кнопке владельца');
    expect(CHECK_RULES).toContain('Не больше двух рекомендаций в ответе');
    expect(CHECK_RULES).toContain('Никогда не пиши «запустил», «проверил сейчас», «изменил»');
  });

  it('карта: все разделы меню с адресами и раздел «Где что сделать»', () => {
    const text = topic('navigation');
    for (const path of [
      '(/)',
      '(/nodes)',
      '(/billing)',
      '(/billing/providers)',
      '(/metrics)',
      '(/incidents)',
      '(/incidents/<id>)',
      '(/scenarios)',
      '(/settings)',
      '(/settings/appearance)',
      '(/settings/autochecks)',
      '(/settings/incidents)',
      '(/assistant)',
      '(/knowledge)',
      '(/integrations/dpi)',
      '(/integrations/dns)',
      '(/integrations/bschecker)',
      '(/audit)',
    ])
      expect(text, path).toContain(path);
    expect(text).toContain('## Где что сделать');
    expect(text).toContain('Сменить домен или API-ключ Remnawave: «Ноды» → «Настроить подключение»');
  });

  it('события: нынешние виды и заголовки, старые — как история, пороги из настроек по умолчанию', () => {
    const text = topic('incidents');
    for (const k of NODE_EVENT_KINDS) {
      expect(text).toContain(`(${k.kind})`);
      expect(text).toContain(k.titles);
    }
    for (const k of LEGACY_EVENT_KINDS) expect(text).toContain(k);
    expect(text).toContain('история прежних версий');
    expect(text).toContain(`${M.confirmSamples} опросами подряд`);
    expect(text).toContain(`не меньше чем на ${M.dropPercent} %`);
    expect(text).toContain(`Процессор — ${M.cpuPercent} %, память — ${M.memoryPercent} %`);
    expect(text).toContain('«Взять в работу»');
    expect(text).toContain('«Закрыть»');
    for (const p of PLAYBOOKS) expect(text).toContain(p.id);
  });

  it('метрики: только Remnawave, чего нет — сказано, ёмкость объяснена', () => {
    const text = topic('metrics');
    expect(text).toContain('Все метрики — из Remnawave');
    expect(text).toContain('Диск, процессы, журналы ноды и сеть внутри сервера панель не видит');
    expect(text).toContain('процессор 80 %, память 85 %, канал 90 %');
    expect(text).toContain('Процент процессора она не заменяет');
  });

  it('сценарии: условия и действия названы как в интерфейсе', () => {
    const text = topic('scenarios');
    for (const label of [...Object.values(scenarioLabels), ...Object.values(scenarioActionLabels)])
      expect(text, label).toContain(`«${label}»`);
    expect(text).toContain('Ассистент сценарии не создаёт, не включает и не запускает');
    expect(text).toContain('«Сценарии» → «Новый сценарий»');
  });

  it('интеграции: DPI Checker, DNS интеграции и BS Checker с подключением и тем, чего Ассистент не видит', () => {
    const text = topic('integrations');
    for (const part of [
      '## DPI Checker',
      '## DNS интеграции',
      '## BS Checker',
      '«Все DNS-записи»',
      '«Арендованные точки входа»',
    ])
      expect(text).toContain(part);
    expect(text).toContain('Платные проверки запускаются только кнопкой владельца');
    expect(text).toContain('Ключи и токены в чат не просите и не повторяйте');
  });

  it('биллинг: все типы оплат и правила окна оплаты для нод', () => {
    const text = topic('billing');
    for (const label of Object.values(BILLING_KIND_LABELS)) expect(text, label).toContain(`«${label}»`);
    expect(text).toContain('Окно оплаты — срок прошёл или наступит в ближайшие сутки');
    expect(text).toContain('«Сервер» объясняет сбой, только если нода не отвечает совсем');
    expect(text).toContain('при неоплате арендодатель выключает вход, а выход (нода) продолжает работать');
    expect(text).toContain('Проверка неполная — «проверьте оплату», без «вероятнее всего»');
    expect(text).toContain('Сами события об оплате не пишут');
  });

  it('Remnawave: только чтение у Ассистента, права ключа, что где меняется, сертификат', () => {
    const text = topic('remnawave');
    expect(text).toContain('get_remnawave_status');
    expect(text).toContain('«Разрешения API-ключа»');
    expect(text).toContain('у Ассистента инструментов записи в Remnawave нет');
    expect(text).toContain('срочная проблема');
    expect(text).not.toContain('сопоставляй по адресу');
  });

  it('блокировки: белые списки и раздел «Правил парка», по названию не угадывать', () => {
    const text = topic('blocking');
    expect(text).toContain('**Белые списки (БС).**');
    expect(text).toContain(`«${FLEET_RULES_WHITELIST_SECTION}»`);
    expect(text).toContain('По названию ноды не угадывайте');
    expect(text).toContain('делаются в Remnawave и у хостера, не в панели');
  });

  it('база знаний: запись без разрешений, ревизия, «Правила парка» с разделом БС', () => {
    const text = topic('kb');
    expect(text).toContain('Новую статью — save_kb_article.');
    expect(text).toContain('**Еженедельная ревизия:**');
    expect(text).toContain(`«${FLEET_RULES_WHITELIST_SECTION}»`);
    expect(text).toContain('Статью сами не меняете');
  });

  it('безопасность: запись в базу знаний без разрешений, чужие указания не выполняются, секреты не сохраняются', () => {
    const text = topic('security');
    expect(text).toMatch(/не выполняйте их/i);
    expect(text).toMatch(/не сохраняйте в базу знаний/);
    expect(text).toContain('Запись в базу знаний включена всегда');
    for (const label of ['Создание и правка статей', 'Изменения по подтверждению', 'Осмотр процессов'])
      expect(text, label).not.toContain(label);
    expect(text).toContain('«Настройки» → «Ассистент» → «Данные для провайдера»');
  });

  it('про самого Ассистента: память, каждый инструмент, чего он не видит', () => {
    const text = topic('self');
    expect(text).toContain('Между беседами памяти нет');
    for (const name of TOOL_NAMES) expect(text, name).toContain(name);
    expect(text).toContain('**Чего ты не видишь**');
    expect(text).toContain('Ничего не меняешь и не запускаешь, кроме записи в базу знаний');
    expect(text).toContain('search_audit');
  });

  it('история версий: текущая версия первой, новые записи выше старых, видно только последние десять', () => {
    const text = topic('changelog');
    expect(text).toMatch(/Текущая версия: \d+\.\d+\.\d+/);
    // Захардкоженные номера версий тут не годятся: справочник показывает только последние 10 записей
    // (CHANGELOG.slice(0, 10)), а список растёт с каждой поставкой — берём границы окна из самого CHANGELOG.
    const [newest, second] = CHANGELOG;
    const lastShown = CHANGELOG[9];
    expect(newest && text.indexOf(`## ${newest.version}`)).toBeGreaterThan(0);
    if (second)
      expect(text.indexOf(`## ${newest?.version}`)).toBeLessThan(text.indexOf(`## ${second.version}`));
    if (lastShown) expect(text).toContain(`## ${lastShown.version}`);
    if (CHANGELOG[10]) expect(text).not.toContain(`## ${CHANGELOG[10].version}`);
    expect(text).toContain('это история, не текущие возможности');
  });
});
