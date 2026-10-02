import { describe, expect, it } from 'vitest';

import {
  SERVER_CHECK_AUTO_KEYS,
  SERVER_CHECK_KEYS,
  SERVER_CHECK_META,
  serverCheckRunSchema,
} from './server-checks.js';

describe('реестр проверок: что панель запускает сама', () => {
  it('по расписанию — только свои команды: сторонние скрипты и тяжёлые в суточный прогон не входят', () => {
    expect(SERVER_CHECK_AUTO_KEYS).toEqual(['russia_access', 'cpu']);
    for (const key of SERVER_CHECK_AUTO_KEYS) {
      expect(SERVER_CHECK_META[key].thirdParty, key).toBe(false);
      expect(SERVER_CHECK_META[key].heavy, key).toBe(false);
    }
  });

  it('ручная проверка из России — своя, остальные ручные проверки сервера используют сторонние скрипты', () => {
    expect(SERVER_CHECK_META.russia_access).toMatchObject({ thirdParty: false, heavy: false });
    const thirdParty = SERVER_CHECK_KEYS.filter((k) => SERVER_CHECK_META[k].thirdParty);
    expect(thirdParty).toEqual(['ip_region', 'geoblock', 'dpi', 'ip_quality', 'iperf3_ru', 'yabs']);
  });

  it('YABS: честно сказано, что ставится из пакетов системы, а что скрипт качает сам без сверки', () => {
    expect(SERVER_CHECK_META.yabs.source).toBe(
      'github.com/masonr/yet-another-bench-script (он же yabs.sh); fio и iPerf3 ставятся из пакетов системы, а Geekbench 4 скрипт скачивает с сайта Primate Labs — его панель не сверяет',
    );
  });

  it('запуск, отменённый из-за несовпавшего скрипта, — свой итог, а не ошибка', () => {
    const run = {
      id: '0192c000-cccc-7000-8000-000000000001',
      serverId: '0192c000-cccc-7000-8000-000000000002',
      check: 'geoblock',
      status: 'cancelled',
      trigger: 'manual',
      actorDisplay: 'admin',
      startedAt: '2026-10-01T00:00:00.000Z',
      finishedAt: '2026-10-01T00:00:05.000Z',
      output: '',
      error: 'Скачанный скрипт не совпал с проверенной версией, записанной в панели, — запуск отменён.',
      explanation: null,
    };
    expect(serverCheckRunSchema.parse(run).status).toBe('cancelled');
  });
});
