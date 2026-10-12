import { describe, expect, it } from 'vitest';
import { explainProbeError } from './probe-error';

describe('Причины результата проверки', () => {
  it('отличает отказ подключения от таймаута и неизвестной ошибки', () => {
    expect(explainProbeError('after 2000ms: ECONNREFUSED (Connection refused)')).toContain('отклонено');
    expect(explainProbeError('failed to connect after 2000ms')).toContain('время ожидания');
    expect(explainProbeError('ENOTFOUND')).toContain('определить IP');
    expect(explainProbeError('opaque error')).toContain('технические детали');
    expect(explainProbeError(null)).toBeNull();
  });
});
