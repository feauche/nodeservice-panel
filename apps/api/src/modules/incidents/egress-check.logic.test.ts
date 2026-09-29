import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SERVER_COUNTRY } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import {
  buildEgressCommand,
  type EgressResult,
  type EgressTarget,
  egressTargets,
  egressText,
  egressVerdict,
  parseEgress,
  pickJump,
} from './egress-check.logic.js';

const country = (code: string | null) => ({ ...DEFAULT_SERVER_COUNTRY, code });
const t = (label: string, group: EgressTarget['group']): EgressTarget => ({
  label,
  host: label,
  port: 443,
  group,
});
const r = (target: EgressTarget, open: boolean): EgressResult => ({ target, open, ms: open ? 20 : null });

describe('цели проверки выхода', () => {
  it('панель, российские серверы парка (не сам), сайты; опасные адреса отброшены', () => {
    const all = [
      { id: 'me', name: 'Казахстан', host: '206.223.246.150', port: 5492, country: country('KZ') },
      { id: 'b', name: 'Мост', host: '5.5.5.5', port: 22, country: country('RU') },
      { id: 'x', name: 'Плохой', host: 'a;rm -rf', port: 22, country: country('RU') },
    ];
    const list = egressTargets('nodeservice-panl.lumaxvds.org', { id: 'me' }, all);
    expect(list[0]).toEqual({
      label: 'Панель NodeService',
      host: 'nodeservice-panl.lumaxvds.org',
      port: 443,
      group: 'panel',
    });
    expect(list.map((x) => x.label)).toContain('Мост');
    expect(list.map((x) => x.label)).not.toContain('Плохой');
    expect(list.map((x) => x.label)).not.toContain('Казахстан');
    expect(list.filter((x) => x.group === 'foreign').length).toBeGreaterThan(0);
  });
});

describe('вывод словами', () => {
  const panel = t('Панель NodeService', 'panel');
  const ya = t('ya.ru', 'ru');
  const g = t('google.com', 'foreign');
  it('случай «Казахстан-1»: зарубеж открыт, Россия и панель нет, пинг панели проходит — фильтрация', () => {
    const rep = { via: 'Германия-1', results: [r(panel, false), r(ya, false), r(g, true)], panelPing: true };
    expect(egressVerdict(rep)).toBe('ru_and_panel_cut');
    const text = egressText(rep);
    expect(text).toMatch(/через «Германия-1»/);
    expect(text).toMatch(/• ya.ru — не подключается/);
    expect(text).toMatch(/• google.com — открыто \(20 мс\)/);
    expect(text).toMatch(/переустановка агента не поможет/i);
    expect(text).toMatch(/Пинг до панели при этом проходит/);
  });
  it('остальные итоги', () => {
    expect(egressVerdict({ results: [r(panel, true), r(ya, true), r(g, true)] })).toBe('ok');
    expect(egressVerdict({ results: [r(panel, false), r(ya, false), r(g, false)] })).toBe('no_internet');
    expect(egressVerdict({ results: [r(panel, true), r(ya, false), r(g, true)] })).toBe('ru_cut');
    expect(egressVerdict({ results: [r(panel, false), r(ya, true), r(g, true)] })).toBe('panel_cut');
    expect(egressVerdict({ results: [] })).toBe('unknown');
  });
});

describe('ступенька', () => {
  const all = [
    { name: 'Мост', country: country('RU') },
    { name: 'Германия-1', country: country('DE') },
  ];
  it('откуда порт открыт, не Россия; иначе хоть кто-то; никого — null', () => {
    expect(pickJump(['Мост', 'Германия-1'], all)?.name).toBe('Германия-1');
    expect(pickJump(['Мост'], all)?.name).toBe('Мост');
    expect(pickJump([], all)).toBeNull();
  });
});

describe('команда на самом деле подключается', () => {
  it('открытый порт — open с временем, закрытый — closed; разбор по номерам', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ns-eg-'));
    for (const [name, body] of [
      ['timeout', '#!/bin/sh\nshift\nexec "$@"\n'],
      // На macOS date не знает %N — подставляем замену; ping не нужен.
      ['date', '#!/bin/sh\necho 1000000000\n'],
      ['ping', '#!/bin/sh\nexit 0\n'],
    ] as const) {
      writeFileSync(join(dir, name), body);
      chmodSync(join(dir, name), 0o755);
    }
    const srv = createServer((s) => s.end());
    await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res));
    const port = (srv.address() as { port: number }).port;
    const targets: EgressTarget[] = [
      { label: 'открытый', host: '127.0.0.1', port, group: 'foreign' },
      { label: 'закрытый', host: '127.0.0.1', port: 1, group: 'panel' },
    ];
    try {
      const out = execFileSync('sh', ['-c', buildEgressCommand(targets, '127.0.0.1')], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        encoding: 'utf8',
      });
      const parsed = parseEgress(out, targets);
      expect(parsed.results.map((x) => [x.target.label, x.open])).toEqual([
        ['открытый', true],
        ['закрытый', false],
      ]);
      expect(parsed.panelPing).toBe(true);
    } finally {
      await new Promise((res) => srv.close(res));
    }
  });
});
