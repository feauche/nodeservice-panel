import { INCIDENT_ACTIONS, INCIDENT_KINDS } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { PLAYBOOKS, playbookById, playbookForKind, renderPlaybook } from './assistant.playbooks.js';
import { READ_TOOL_DEFS } from './assistant.read-tools.js';

const tools = new Set(READ_TOOL_DEFS.map((t) => t.name));
const actions = new Set<string>(INCIDENT_ACTIONS.map((a) => a.key));
const playbookIds = new Set(PLAYBOOKS.map((p) => p.id));

describe('плейбуки', () => {
  it('у каждого вида инцидента есть плейбук, id не повторяются', () => {
    for (const kind of INCIDENT_KINDS) expect(playbookForKind(kind), kind).toBeDefined();
    const ids = PLAYBOOKS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('в шагах называются только существующие инструменты чтения, в действиях только ключи реестра', () => {
    for (const p of PLAYBOOKS) {
      const text = [...p.steps, ...p.reading, ...p.actions].join(' ');
      for (const token of text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []) {
        // технические токены вроде nf_conntrack_max — не инструменты и не действия панели
        if (
          /^(nf_conntrack|net_netfilter)/.test(token) ||
          ['nf_conntrack_max', 'nf_conntrack_count'].includes(token)
        )
          continue;
        expect(tools.has(token) || actions.has(token) || playbookIds.has(token), `${p.id}: «${token}»`).toBe(
          true,
        );
      }
    }
  });
  it('ключи действий из плейбука подходят к видам инцидента, для которых он подставляется', () => {
    for (const p of PLAYBOOKS)
      for (const key of p.actions.join(' ').match(/\b[a-z]+_[a-z]+\b/g) ?? []) {
        const a = INCIDENT_ACTIONS.find((x) => x.key === key);
        if (a && p.kinds.length > 0)
          expect(
            p.kinds.some((k) => (a.kinds as readonly string[]).includes(k)),
            `${p.id}: ${key}`,
          ).toBe(true);
      }
  });
  it('каждый плейбук называет, чего панель не видит, и не советует опасное', () => {
    for (const p of PLAYBOOKS) {
      expect(p.limits.length, p.id).toBeGreaterThan(0);
      const text = renderPlaybook(p);
      expect(text).not.toMatch(/docker system prune -/);
    }
    expect(renderPlaybook(playbookById('disk_full') as never)).toContain(
      'Никогда не предлагайте docker system prune',
    );
  });
  it('окно оплаты: плейбуки связи знают про «Биллинг» и близкий срок, устаревшего «учёта оплат пока нет» не осталось', () => {
    for (const p of PLAYBOOKS) {
      const text = renderPlaybook(p);
      expect(text, p.id).not.toContain('которого в панели пока нет');
      expect(text, p.id).not.toContain('в панели пока нет');
    }
    for (const id of ['server_unreachable', 'tspu_degradation']) {
      const text = renderPlaybook(playbookById(id) as never);
      expect(text, id).toContain('в окне оплаты (срок прошёл или наступит в ближайшие сутки)');
      expect(text, id).toContain('настоящий баланс у хостера или арендодателя');
    }
    // Случай «guardora (Аренда)»: блокировка не подтвердилась, выход жив, вход арендодателя молчит.
    const blocked = renderPlaybook(playbookById('tspu_degradation') as never);
    expect(blocked).toContain('вероятнее всего, закончилась оплата аренды');
    expect(blocked).toContain('при неоплаченной аренде выключают вход, а выход продолжает работать');
    // Вид оплаты важен, как и в правилах окна оплаты: хостинг работающего сервера сбой не объясняет.
    expect(blocked).toContain(
      'а в окне оплаты (срок прошёл или наступит в ближайшие сутки) — аренда этого сервера',
    );
    // «Вероятнее всего» — только после полной проверки; неполная — «проверьте оплату» и что не проверено.
    expect(blocked).toContain(
      'Проверка прошла полностью (порт отвечает со всех проверяющих, блокировка не подтвердилась)',
    );
    expect(blocked).toContain('Проверка неполная (что-то проверить не удалось) — без «вероятнее всего»');
    // Выход отвечает, вход молчит, аренды в окне нет — причина во входе.
    expect(blocked).toContain(
      'Выход отвечает, а вход (мост или вход арендодателя) не отвечает: причина во входе',
    );
    expect(blocked).toContain(
      'Оплата хостинга («Сервер») объясняет сбой, только если сервер не отвечает совсем; сертификат, домен и «Другое» причиной не называйте',
    );
    // «Виноваты провайдеры пользователей» — только когда подходящей оплаты в окне нет: иначе две причины спорят.
    expect(blocked).toContain('порт открыт со всех проверяющих, подходящей оплаты в окне оплаты нет');
    // Догадка «по названию аренда» — только если оплата самого сервера не заведена; заведена и не близко — не предлагаем.
    expect(blocked).toContain(
      'оплата самого сервера (хостинг или аренда) в «Биллинге» не заведена, а в названии',
    );
    expect(blocked).not.toContain('оплаты в окне оплаты нет, а в названии');
    // Новый вердикт: порт отвечает с перебоями — это не «блокировка IP из России».
    expect(blocked).toContain('вердикт «Порт отвечает с перебоями»');
    expect(blocked).toContain('«блокировкой IP из России» и «сервер недоступен» это не называйте');
    // Недоступный сервер: хостинг и аренда объясняют, сертификат и домен — нет; сбой у нескольких — общая причина.
    const down = renderPlaybook(playbookById('server_unreachable') as never);
    expect(down).toContain('Оплата хостинга («Сервер») или аренды этого сервера в «Биллинге» в окне оплаты');
    expect(down).toContain('Сертификат и домен сервер не выключают');
    expect(down).toContain('Связь пропала сразу с несколькими серверами — первой назовите общую причину');
  });
  it('плейбуки не отрицают того, что панель уже умеет: регион и геоблок IP, проверка из России', () => {
    const region = renderPlaybook(playbookById('gemini_ru') as never);
    expect(region).not.toContain('пока нет');
    expect(region).not.toContain('панель не определяет');
    expect(region).toContain('«Регион IP»');
    expect(region).toContain('«Геоблок»');
    expect(region).toContain('run_server_check');
    const domain = renderPlaybook(playbookById('domain_blocked') as never);
    expect(domain).not.toContain('пока недоступны');
    expect(domain).toContain('из России');
    // Проверяющих не больше пяти: российского среди них может не быть — тогда вывода о России нет.
    expect(domain).toContain('до пяти серверов парка, по одному на страну, российский — первым');
    expect(domain).toContain(
      'Российского сервера среди проверяющих нет — о видимости из России вывода не делайте',
    );
  });
  it('T3-команды идут текстом, а не как шаги автопочинки', () => {
    for (const p of PLAYBOOKS)
      for (const a of p.actions)
        if (/reboot|sysctl|systemctl|docker logs/.test(a))
          expect(a, `${p.id}: ${a}`).toMatch(/T3|текст|вручную/i);
  });
});
