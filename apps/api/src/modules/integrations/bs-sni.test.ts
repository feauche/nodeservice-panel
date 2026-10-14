import { describe, expect, it } from 'vitest';

import { sniOutcome, sniShape } from './bs-sni.js';

describe('итог SNI из ответа BS Checker', () => {
  it('логическое поле успеха — под любым привычным именем', () => {
    expect(sniOutcome([{ host: 'a.ru', ok: true }])).toBe(true);
    expect(sniOutcome([{ host: 'a.ru', handshake_ok: false }])).toBe(false);
    expect(sniOutcome({ success: true })).toBe(true);
  });

  it('слово-итог: прошёл или нет', () => {
    expect(sniOutcome([{ verdict: 'passed' }])).toBe(true);
    expect(sniOutcome([{ status: 'Blocked' }])).toBe(false);
  });

  it('несколько имён: хоть одно не прошло — false; не по всем понятно — null', () => {
    expect(sniOutcome([{ ok: true }, { ok: true }])).toBe(true);
    expect(sniOutcome([{ ok: true }, { ok: false }])).toBe(false);
    expect(sniOutcome([{ ok: true }, { latency_ms: 40 }])).toBeNull();
  });

  it('нет данных или незнакомая форма — null, а не выдуманный итог', () => {
    expect(sniOutcome(null)).toBeNull();
    expect(sniOutcome([])).toBeNull();
    expect(sniOutcome([{ latency_ms: 12, note: 'x' }])).toBeNull();
    expect(sniOutcome('ok')).toBeNull();
  });

  it('форма — только имена полей, без значений', () => {
    expect(sniShape([{ host: 'secret.example', ok: true, latency_ms: 5 }])).toEqual([
      'host',
      'ok',
      'latency_ms',
    ]);
    expect(sniShape(null)).toEqual([]);
  });
});
