import { describe, expect, it } from 'vitest';

import {
  type CapacitySeries,
  computeCapacity,
  daysUntilFull,
  effectiveLink,
  fitLine,
  parseLinkProbe,
  parseSpeedTest,
  weeklyGrowthPct,
} from './capacity.logic.js';

const STEP = 600;
const link = (patch: Partial<Parameters<typeof effectiveLink>[0] & object> = {}) =>
  effectiveLink({
    nicName: 'eth0',
    nicMbit: null,
    nicVirtual: true,
    conntrackMax: 262_144,
    probedAt: null,
    measuredDownMbit: null,
    measuredUpMbit: null,
    measuredAt: null,
    manualMbit: null,
    ...patch,
  });

/** Сутки за сутками: онлайн ходит волной от ночного минимума к вечернему пику; нагрузка = фон + k × онлайн. */
function series(
  days: number,
  peak: number,
  per: { cpu: number; mem: number; tx: number; conn: number },
  base = { cpu: 5, mem: 20 },
): CapacitySeries {
  const t: number[] = [];
  const online: number[] = [];
  const n = (days * 86_400) / STEP;
  for (let i = 0; i < n; i += 1) {
    t.push(1_790_000_000 + i * STEP);
    const phase = ((i * STEP) % 86_400) / 86_400;
    online.push(Math.round(peak * (0.2 + 0.8 * Math.max(0, Math.sin(Math.PI * phase)))));
  }
  return {
    t,
    online,
    cpu: online.map((o) => base.cpu + per.cpu * o),
    mem: online.map((o) => base.mem + per.mem * o),
    rx: online.map((o) => 0.3 * per.tx * o),
    tx: online.map((o) => per.tx * o),
    conn: online.map((o) => 200 + per.conn * o),
  };
}

describe('канал', () => {
  it('сетевая карта: виртуальную распознаём по драйверу, её скорости не верим', () => {
    const probe = parseLinkProbe(
      '@@dev=eth0\n@@speed=10000\n@@driver=virtio_net\n@@virt=kvm\n@@ctmax=262144\n',
    );
    expect(probe).toEqual({ nicName: 'eth0', nicMbit: 10_000, nicVirtual: true, conntrackMax: 262_144 });
    expect(link({ nicMbit: 10_000, nicVirtual: true }).source).toBe('none');
    expect(link({ nicMbit: 1000, nicVirtual: false })).toMatchObject({ source: 'nic', upMbit: 1000 });
  });

  it('приоритет: вручную → замер → настоящая карта', () => {
    expect(
      link({ nicMbit: 1000, nicVirtual: false, measuredUpMbit: 612, measuredDownMbit: 700 }),
    ).toMatchObject({
      source: 'measured',
      upMbit: 612,
      downMbit: 700,
    });
    expect(link({ measuredUpMbit: 612, manualMbit: 1000 })).toMatchObject({ source: 'manual', upMbit: 1000 });
  });

  it('замер: байты за миллисекунды → Мбит/с; нет curl — понятная причина', () => {
    expect(parseSpeedTest('@@down=1000000000\n@@up=500000000\n@@downms=8000\n@@upms=8000\n')).toEqual({
      downMbit: 1000,
      upMbit: 500,
      error: null,
    });
    expect(parseSpeedTest('@@error=нет curl\n').error).toBe('нет curl');
    expect(parseSpeedTest('@@down=0\n@@up=0\n@@downms=8000\n@@upms=8000\n').error).toMatch(/не ответил/);
  });
});

describe('ёмкость ноды', () => {
  it('прямая по точкам восстанавливает фон и нагрузку на одного', () => {
    const f = fitLine([0, 10, 20, 30, 40, 50, 60, 70, 80, 90], [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(f?.a).toBeCloseTo(5);
    expect(f?.k).toBeCloseTo(0.1);
    expect(f?.r2).toBeCloseTo(1);
  });

  it('много памяти и процессора, канал 1 Гбит — упор в канал (пример владельца)', () => {
    // 910 человек в пик, каждый ≈ 0,97 Мбит/с отдачи → 890 Мбит/с из 1000.
    const s = series(14, 910, { cpu: 0.03, mem: 0.002, tx: 0.978, conn: 20 });
    const r = computeCapacity(s, link({ manualMbit: 1000 }), STEP);
    expect(r.status).toBe('ok');
    expect(r.onlinePeak).toBe(910);
    expect(r.bottleneck).toBe('net');
    expect(r.cells.net.usedPct).toBeCloseTo(89, 0);
    // До 90 % канала: (900 − 890) ÷ 0,978 ≈ 10 человек.
    expect(r.left).toBeGreaterThanOrEqual(5);
    expect(r.left).toBeLessThanOrEqual(15);
    expect(r.cells.cpu.left).toBeGreaterThan(1000);
    expect(r.note).toMatch(/Упрётся в канал/);
    expect(r.note).toMatch(/Процессор и память почти свободны/);
  });

  it('канал неизвестен — канал не ограничивает, упор по остальным; подпись честная', () => {
    const s = series(14, 300, { cpu: 0.22, mem: 0.05, tx: 1, conn: 10 });
    const r = computeCapacity(s, link(), STEP);
    expect(r.cells.net.left).toBeNull();
    expect(r.cells.net.detail).toMatch(/канал неизвестен/);
    expect(r.bottleneck).toBe('cpu');
  });

  it('мало данных: меньше 3 дней или меньше 30 человек в пик — числа нет', () => {
    expect(
      computeCapacity(series(2, 400, { cpu: 0.1, mem: 0.01, tx: 1, conn: 10 }), link(), STEP).status,
    ).toBe('few_data');
    const small = computeCapacity(series(14, 20, { cpu: 0.1, mem: 0.01, tx: 1, conn: 10 }), link(), STEP);
    expect(small).toMatchObject({ status: 'few_data', left: null });
    expect(small.note).toMatch(/Мало людей/);
  });

  it('фон процессора выше половины — «сервер слабоват»', () => {
    const s = series(14, 200, { cpu: 0.1, mem: 0.01, tx: 1, conn: 10 }, { cpu: 60, mem: 20 });
    expect(computeCapacity(s, link({ manualMbit: 1000 }), STEP).status).toBe('weak');
  });

  it('онлайна не было — не нода', () => {
    const s = series(14, 100, { cpu: 0.1, mem: 0.01, tx: 1, conn: 10 });
    expect(computeCapacity({ ...s, online: s.online.map(() => 0) }, link(), STEP).status).toBe('no_online');
  });
});

describe('рост парка', () => {
  it('пик недели против прошлой; дни до упора при сложном росте', () => {
    const end = 1_790_000_000 + 14 * 86_400;
    const t = Array.from({ length: 14 * 24 }, (_, i) => 1_790_000_000 + i * 3600);
    const online = t.map((x) => (x > end - 7 * 86_400 ? 1060 : 1000));
    expect(weeklyGrowthPct(t, online, end)).toBe(6);
    // Запас 60 при пике 1000 и росте 6 % в неделю ≈ 7 дней.
    expect(daysUntilFull(60, 1000, 6)).toBe(7);
    expect(daysUntilFull(60, 1000, 0)).toBeNull();
  });
});
