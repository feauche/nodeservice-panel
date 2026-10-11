import { describe, expect, it } from 'vitest';
import { nodeTelemetry, remnawaveBytes } from './remnawave-client.js';

describe('node metrics from Remnawave', () => {
  it('reads memory, load, rates, versions and direct provider from the live API shape', () => {
    expect(
      nodeTelemetry({
        provider: { uuid: 'provider', name: '4vps' },
        system: {
          info: { cpus: 4, memoryTotal: 4101177344, cpuModel: 'EPYC' },
          stats: {
            memoryUsed: 1213005824,
            loadAvg: [0.2, 0.68, 0.76],
            interface: { rxBytesPerSec: 123, txBytesPerSec: 456 },
          },
        },
        versions: { node: '3.4.1', xray: '26.7.28' },
        xrayUptime: '480569',
      }),
    ).toMatchObject({
      providerUuid: 'provider',
      providerName: '4vps',
      cpuCount: 4,
      cpuPercent: null,
      memoryTotalBytes: 4101177344,
      memoryUsedBytes: 1213005824,
      rxBytesPerSec: 123,
      txBytesPerSec: 456,
      loadAverage: [0.2, 0.68, 0.76],
      uptime: '480569',
      nodeVersion: '3.4.1',
    });
  });
  it('keeps missing values unknown and accepts numeric or formatted byte counts', () => {
    expect(remnawaveBytes(null)).toBeNull();
    expect(remnawaveBytes('')).toBeNull();
    expect(remnawaveBytes(-1)).toBeNull();
    expect(remnawaveBytes('1.5 GiB')).toBe(1610612736);
    expect(remnawaveBytes('1024')).toBe(1024);
    expect(nodeTelemetry({}).memoryTotalBytes).toBeNull();
  });
});
