import { describe, expect, it } from 'vitest';

import { AGENT_HEARTBEAT_SECONDS } from './agent-protocol.js';
import {
  AGENT_OFFLINE_MIN_SECONDS,
  AUTOCHECKS_DEFAULTS,
  autochecksSettingsSchema,
  autochecksSettingsUpdateSchema,
} from './autochecks.js';

const firstMessage = (patch: Record<string, unknown>) =>
  autochecksSettingsSchema.safeParse({ ...AUTOCHECKS_DEFAULTS, ...patch }).error?.issues[0]?.message;

describe('настройки «Автопроверки»', () => {
  it('порог «Агент не в сети» — не меньше трёх сигналов агента: одно запоздание сигнала не помечает сервер', () => {
    expect(AGENT_OFFLINE_MIN_SECONDS).toBe(3 * AGENT_HEARTBEAT_SECONDS);
    expect(AGENT_OFFLINE_MIN_SECONDS).toBe(30);
    // Раньше проходил порог, равный интервалу сигнала (10 с): статус и Журнал флапали.
    for (const v of [10, 15, 29])
      expect(firstMessage({ agentOfflineAfterSeconds: v }), String(v)).toBeDefined();
    for (const v of [30, 120, 600])
      expect(firstMessage({ agentOfflineAfterSeconds: v }), String(v)).toBeUndefined();
    expect(autochecksSettingsUpdateSchema.safeParse({ agentOfflineAfterSeconds: 10 }).success).toBe(false);
  });

  it('значения по умолчанию проходят собственную проверку', () => {
    expect(autochecksSettingsSchema.parse(AUTOCHECKS_DEFAULTS)).toEqual(AUTOCHECKS_DEFAULTS);
    expect(AUTOCHECKS_DEFAULTS.agentOfflineAfterSeconds).toBeGreaterThanOrEqual(AGENT_OFFLINE_MIN_SECONDS);
  });

  it('суточные проверки серверов — тумблер, по умолчанию включён; меняется отдельно от остального', () => {
    expect(AUTOCHECKS_DEFAULTS.serverChecksEnabled).toBe(true);
    expect(autochecksSettingsUpdateSchema.parse({ serverChecksEnabled: false })).toEqual({
      serverChecksEnabled: false,
    });
  });

  it('ошибка у поля — по-русски', () => {
    expect(firstMessage({ agentOfflineAfterSeconds: 10 })).toBe('Не меньше 30');
    expect(firstMessage({ agentOfflineAfterSeconds: 601 })).toBe('Не больше 600');
    expect(firstMessage({ sshIntervalMinutes: 2 })).toBe('Не меньше 5');
    expect(firstMessage({ metricsIntervalSeconds: 'abc' })).toBe('Введите целое число');
    expect(firstMessage({ metricsIntervalSeconds: '7.5' })).toBe('Введите целое число');
    // Форма шлёт строки — они по-прежнему превращаются в числа.
    expect(
      autochecksSettingsSchema.parse({ ...AUTOCHECKS_DEFAULTS, sshIntervalMinutes: '30' }).sshIntervalMinutes,
    ).toBe(30);
  });
});
