import { PANEL_TIME_ZONE_DEFAULT, timeZoneSchema } from '@nodeservice/shared';
import { eq } from 'drizzle-orm';

import type { Db } from '../infra/db/db.module.js';
import { appMeta } from '../infra/db/schema/index.js';

/**
 * Часовой пояс панели из «Настроек → Внешний вид»: время в сообщениях, расписание копий. null — владелец
 * пояс ещё не выбирал (тогда вызывающий берёт свой запасной, например пояс браузера из «Уведомлений»).
 */
export async function panelTimeZone(db: Db): Promise<string | null> {
  const row = await db.query.appMeta.findFirst({ where: eq(appMeta.key, 'settings.appearance') });
  if (!row) return null;
  try {
    const tz = (JSON.parse(row.value) as { timeZone?: unknown }).timeZone;
    return typeof tz === 'string' && timeZoneSchema.safeParse(tz).success ? tz : null;
  } catch {
    return null;
  }
}

export const DEFAULT_TIME_ZONE = PANEL_TIME_ZONE_DEFAULT;
