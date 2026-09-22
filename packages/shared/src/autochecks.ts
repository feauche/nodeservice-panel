import { z } from 'zod';

/**
 * Настройки → «Автопроверки»: все фоновые проверки панели и агента.
 * Каждая — тумблер + интервал; кнопка «По умолчанию» возвращает раздел к AUTOCHECKS_DEFAULTS.
 */

const interval = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export const autochecksSettingsSchema = z.object({
  /** SSH-проверка серверов БЕЗ online-агента (живость только по SSH). */
  sshEnabled: z.boolean(),
  sshIntervalMinutes: interval(5, 1440),
  /** SSH-проверка серверов С online-агентом: живость даёт heartbeat, SSH — контроль доступа, реже. */
  sshAgentEnabled: z.boolean(),
  sshAgentIntervalMinutes: interval(15, 10_080),
  /** Отметка «агент не в сети», если heartbeat молчит дольше порога. */
  agentOfflineEnabled: z.boolean(),
  agentOfflineAfterSeconds: interval(10, 600),
  /** Сбор и отправка метрик агентом (частота уходит агенту при подключении). */
  metricsEnabled: z.boolean(),
  metricsIntervalSeconds: interval(5, 120),
});
export type AutochecksSettings = z.infer<typeof autochecksSettingsSchema>;

export const AUTOCHECKS_DEFAULTS: AutochecksSettings = {
  sshEnabled: true,
  sshIntervalMinutes: 15,
  sshAgentEnabled: true,
  sshAgentIntervalMinutes: 60,
  agentOfflineEnabled: true,
  agentOfflineAfterSeconds: 30,
  metricsEnabled: true,
  metricsIntervalSeconds: 10,
};

/** Update-схема собрана из полей без дефолтов: .partial() поверх default подставил бы значения (см. урок этапа 3). */
export const autochecksSettingsUpdateSchema = autochecksSettingsSchema.partial();
export type AutochecksSettingsUpdate = z.infer<typeof autochecksSettingsUpdateSchema>;
