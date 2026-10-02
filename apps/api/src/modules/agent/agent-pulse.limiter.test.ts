import { describe, expect, it } from 'vitest';

import { AgentPulseLimiter, PULSE_PER_ADDRESS_PER_MINUTE } from './agent-pulse.limiter.js';

describe('AgentPulseLimiter', () => {
  it('ограничивает один адрес и освобождает его в следующую минуту', () => {
    const limiter = new AgentPulseLimiter();
    const minute = 1_800_000_000_000;
    for (let i = 0; i < PULSE_PER_ADDRESS_PER_MINUTE; i += 1) limiter.assertAllowed('203.0.113.7', minute);
    expect(() => limiter.assertAllowed('203.0.113.7', minute)).toThrow();
    expect(() => limiter.assertAllowed('203.0.113.7', minute + 60_000)).not.toThrow();
  });

  it('IPv6-адреса одной /64 считаются вместе', () => {
    const limiter = new AgentPulseLimiter();
    for (let i = 0; i < PULSE_PER_ADDRESS_PER_MINUTE; i += 1)
      limiter.assertAllowed(`2001:db8:5:5::${i.toString(16)}`, 1_800_000_000_000);
    expect(() => limiter.assertAllowed('2001:db8:5:5::ffff', 1_800_000_000_000)).toThrow();
  });
});
