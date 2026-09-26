import { describe, expect, it } from 'vitest';

import { mergeTerms, termKeys } from './glossary-merge.js';

const E = (term: string, explain = 'Простое объяснение термина') => ({ term, explain });

describe('termKeys', () => {
  it('основное название и названия из скобок, без регистра и «ё»', () => {
    expect(termKeys('Рукопожатие (handshake)')).toEqual(['рукопожатие', 'handshake']);
    expect(termKeys('Fingerprint (отпечаток, fp)')).toEqual(['fingerprint', 'отпечаток', 'fp']);
    expect(termKeys('Ёлка')).toEqual(['елка']);
    expect(termKeys('raw / TCP')).toEqual(['raw / tcp']);
  });
});

describe('mergeTerms', () => {
  it('новые термины добавляются, список остаётся отсортированным', () => {
    const r = mergeTerms([E('SSH')], [E('CPU'), E('Аплинк')]);
    expect(r.added).toEqual(['CPU', 'Аплинк']);
    expect(r.entries.map((e) => e.term)).toEqual(['Аплинк', 'CPU', 'SSH']);
  });
  it('повтор не добавляется, пояснение существующего не меняется', () => {
    const r = mergeTerms([E('SSH', 'Прежнее пояснение')], [E('ssh', 'Другое пояснение')]);
    expect(r.added).toEqual([]);
    expect(r.skipped).toEqual(['SSH']);
    expect(r.entries).toEqual([E('SSH', 'Прежнее пояснение')]);
  });
  it('тот же термин под другим названием (перевод в скобках) тоже повтор', () => {
    const r = mergeTerms(
      [E('Рукопожатие (handshake)'), E('SNI')],
      [E('Handshake'), E('SNI (Server Name Indication)'), E('Хост (host)')],
    );
    expect(r.skipped).toEqual(['Рукопожатие (handshake)', 'SNI']);
    expect(r.added).toEqual(['Хост (host)']);
  });
  it('повтор внутри самой пачки не добавляется дважды', () => {
    const r = mergeTerms([], [E('QUIC'), E('quic'), E('QUIC (HTTP/3)')]);
    expect(r.added).toEqual(['QUIC']);
    expect(r.skipped).toEqual(['QUIC']);
  });
  it('пояснение существующего меняется только с update и только если оно отличается', () => {
    const base = [E('OOM', 'Кончилась память')];
    const noUpdate = mergeTerms(base, [E('OOM', 'Система убивает процесс из-за нехватки памяти')]);
    expect(noUpdate.updated).toEqual([]);
    expect(noUpdate.entries[0]?.explain).toBe('Кончилась память');

    const upd = mergeTerms(base, [
      { ...E('OOM', 'Система убивает процесс из-за нехватки памяти'), update: true },
    ]);
    expect(upd.updated).toEqual(['OOM']);
    expect(upd.entries[0]?.explain).toBe('Система убивает процесс из-за нехватки памяти');

    const same = mergeTerms(base, [{ ...E('oom', 'кончилась  память'), update: true }]);
    expect(same.updated).toEqual([]);
    expect(same.skipped).toEqual(['OOM']);
  });
  it('вертикальная черта в названии и пояснении не ломает таблицу', () => {
    const r = mergeTerms([], [E('A | B', 'первое | второе')]);
    expect(r.entries[0]).toEqual({ term: 'A/B', explain: 'первое/второе' });
  });
});
