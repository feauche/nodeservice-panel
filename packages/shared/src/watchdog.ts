import { z } from 'zod';

/**
 * Сторож панели («Настройки → Уведомления → Сторож панели»): маленький скрипт на одном из серверов парка.
 * Раз в минуту он спрашивает /api/health/ready панели и пишет в Telegram сам, если панель три минуты подряд
 * не отвечает, — когда панель лежит, она сама ничего прислать не может. Обратного канала у сторожа нет:
 * панель знает только, где и когда его поставила.
 *
 *  GET  /api/settings/watchdog          → WatchdogStatus
 *  POST /api/settings/watchdog/install  { serverId } → WatchdogStatus   (step-up)
 *  POST /api/settings/watchdog/remove   → WatchdogStatus
 *  POST /api/settings/watchdog/test     → WatchdogTestResponse
 */

export const watchdogInstalledSchema = z.object({
  serverId: z.string(),
  /** Имя сервера сейчас; сервер удалён из панели — имя на момент установки. */
  serverName: z.string(),
  installedAt: z.iso.datetime({ offset: true }),
  /** Сервер удалён из панели: убрать сторожа с него панель уже не может. */
  serverGone: z.boolean(),
  /**
   * После установки поменялись чаты Telegram, прокси, адрес или часовой пояс панели: сторож пишет и
   * проверяет по-старому, пока его не поставят заново.
   */
  outdated: z.boolean(),
});
export type WatchdogInstalled = z.infer<typeof watchdogInstalledSchema>;

export const watchdogStatusSchema = z.object({
  /** Где стоит сторож; null — не поставлен. */
  installed: watchdogInstalledSchema.nullable(),
  /** Почему поставить сейчас нельзя (нет чатов Telegram, у панели нет внешнего адреса); null — можно. */
  blocker: z.string().nullable(),
});
export type WatchdogStatus = z.infer<typeof watchdogStatusSchema>;

export const watchdogInstallRequestSchema = z.object({ serverId: z.uuid() });
export type WatchdogInstallRequest = z.infer<typeof watchdogInstallRequestSchema>;

export const watchdogTestResponseSchema = z.object({
  /** Тестовое сообщение дошло хотя бы в один чат. */
  ok: z.boolean(),
  /** Что показать владельцу: дошло ли сообщение и видит ли сторож панель. */
  detail: z.string(),
});
export type WatchdogTestResponse = z.infer<typeof watchdogTestResponseSchema>;

export const WATCHDOG_PROBLEM = {
  /** Поставить нельзя: нет чатов Telegram или внешнего адреса панели (detail — что сделать). */
  blocked: 'urn:nodeservice:problem:watchdog-blocked',
  /** Команда на сервере не удалась (detail — причина по-русски). */
  failed: 'urn:nodeservice:problem:watchdog-failed',
} as const;
