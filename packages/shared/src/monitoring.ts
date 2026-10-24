import { z } from 'zod';

const integer = (min: number, max: number) => z.number().int().min(min).max(max);
export const monitoringSettingsSchema = z.object({
  enabled: z.boolean(),
  pollSeconds: integer(10, 900),
  apiTimeoutSeconds: integer(5, 60),
  staleAfterMinutes: integer(2, 60),
  dropPercent: integer(30, 100),
  minOnline: integer(5, 10000),
  dropWindowMinutes: integer(5, 240),
  confirmSamples: integer(2, 10),
  recoverySamples: integer(2, 10),
  recoveryPercent: integer(30, 100),
  cpuEnabled: z.boolean(),
  /**
   * Порог нагрузки на ядро: средняя нагрузка за минуту, делённая на число ядер, — как в строке ноды. Процента
   * процессора Remnawave не отдаёт, поэтому предупреждение — по нагрузке (1,0 — ядро занято полностью).
   */
  loadPerCore: z.number().min(0.5).max(10),
  memoryEnabled: z.boolean(),
  memoryPercent: integer(50, 100),
  /**
   * Перегрузка канала (0.110.0, витрина reference-pack-2026-10, раздел 3 — A): больший из входящего и исходящего
   * трафика в процентах от «Лимита канала» ноды. По умолчанию выключено; ноды без лимита не проверяются.
   */
  channelEnabled: z.boolean(),
  channelPercent: integer(50, 100),
  resourceDurationMinutes: integer(1, 60),
  checkHostEnabled: z.boolean(),
  checkHostHours: integer(1, 168),
  checkHostPort: integer(1, 65535),
  checkHostOnDrop: z.boolean(),
  checkHostCooldownMinutes: integer(5, 1440),
  /** Волна (0.106.0): ноды одного провайдера (или страны), упавшие почти одновременно, — одно событие. */
  waveEnabled: z.boolean(),
  /** Со скольких упавших нод одной группы начинается волна. */
  waveMinNodes: integer(2, 10),
  /** За какое время они должны упасть, минут. */
  waveWindowMinutes: integer(5, 30),
});
export type MonitoringSettings = z.infer<typeof monitoringSettingsSchema>;
/**
 * По умолчанию — быстро: Remnawave сама обновляет ноды раз в 10 секунд, опрос раз в 15 секунд и четыре
 * подтверждения подряд узнают о сбое примерно за минуту (0.94.0); нагрузка и память — за 2 минуты (0.95.0).
 * Графики пишутся по-прежнему раз в минуту.
 */
export const MONITORING_DEFAULTS: MonitoringSettings = {
  enabled: true,
  pollSeconds: 15,
  apiTimeoutSeconds: 10,
  staleAfterMinutes: 2,
  dropPercent: 80,
  minOnline: 30,
  dropWindowMinutes: 60,
  confirmSamples: 4,
  recoverySamples: 4,
  recoveryPercent: 50,
  cpuEnabled: true,
  loadPerCore: 1.5,
  memoryEnabled: true,
  memoryPercent: 90,
  channelEnabled: false,
  channelPercent: 90,
  resourceDurationMinutes: 2,
  checkHostEnabled: true,
  checkHostHours: 24,
  checkHostPort: 5492,
  checkHostOnDrop: true,
  checkHostCooldownMinutes: 5,
  waveEnabled: true,
  waveMinNodes: 2,
  waveWindowMinutes: 10,
};
/**
 * Значения по умолчанию до 0.94.0. Сохранённая настройка, равная прежнему значению, при обновлении переходит
 * на новое; изменённое вручную остаётся как было.
 */
export const MONITORING_DEFAULTS_BEFORE_0_94: Partial<MonitoringSettings> = {
  pollSeconds: 60,
  apiTimeoutSeconds: 15,
  staleAfterMinutes: 5,
  confirmSamples: 3,
  recoverySamples: 3,
  checkHostCooldownMinutes: 15,
};
/** Значения по умолчанию до 0.95.0: превышение нагрузки и памяти ждали 5 минут. */
export const MONITORING_DEFAULTS_BEFORE_0_95: Partial<MonitoringSettings> = {
  resourceDurationMinutes: 5,
};
/** Значения по умолчанию до 0.97.0: падение онлайна закрывалось, когда возвращалось 70 % прежнего уровня. */
export const MONITORING_DEFAULTS_BEFORE_0_97: Partial<MonitoringSettings> = {
  recoveryPercent: 70,
};
export const monitoringSettingsUpdateSchema = monitoringSettingsSchema.partial().strict();
