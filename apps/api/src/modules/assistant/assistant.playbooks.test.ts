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
  it('T3-команды идут текстом, а не как шаги автопочинки', () => {
    for (const p of PLAYBOOKS)
      for (const a of p.actions)
        if (/reboot|sysctl|systemctl|docker logs/.test(a))
          expect(a, `${p.id}: ${a}`).toMatch(/T3|текст|вручную/i);
  });
});
