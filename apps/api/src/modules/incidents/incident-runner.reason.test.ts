import { describe, expect, it } from 'vitest';

import { proposalReason } from './incident-runner.service.js';

describe('proposalReason', () => {
  it('«Само» при выключенной автопочинке называет настоящую причину, а не «Спросить»', () => {
    expect(proposalReason('T1', 'auto')).toBe(
      'для этого сигнала выбрано «Само», но автопочинка выключена или на паузе',
    );
  });
  it('«Спросить» остаётся «Спросить», шаги выше T1 — первый шаг цепочки', () => {
    expect(proposalReason('T1', 'ask')).toBe('для этого сигнала выбрано «Спросить»');
    expect(proposalReason('T2', 'auto')).toBe('первый шаг цепочки');
    expect(proposalReason('T2', 'ask')).toBe('первый шаг цепочки');
  });
});
