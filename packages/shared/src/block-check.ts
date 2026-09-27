import { z } from 'zod';

/**
 * J10: аномалия онлайна ноды Remnawave и проверка блокировок (ТСПУ / «блок 16–20 КБ»). Решения
 * владельца 27.09.2026 и исследование методик (Runnin4ik/dpi-detector и открытые обсуждения
 * net4people/bbs) — пороги ниже откалиброваны сообществом, но со временем могут меняться, поэтому
 * хранятся как настраиваемые константы, а не выводятся заново из формул.
 */

/** Падение числа онлайн-пользователей ноды на столько процентов и больше — уже аномалия. */
export const NODE_ONLINE_DROP_PCT = 80;
/** …если это случилось за такое время (минуты) или быстрее. */
export const NODE_ONLINE_DROP_WINDOW_MIN = 5;
/** Не поднимать тревогу по совсем маленьким нодам: 300 → 10 показательно, 3 → 0 — нет. */
export const NODE_ONLINE_DROP_MIN_BASELINE = 10;

/** Обрыв потока данных без явного отказа в этом диапазоне (КБ, кумулятивно) — сигнатура блока «16–20 КБ». */
export const BLOCK_1620_MIN_KB = 12;
export const BLOCK_1620_MAX_KB = 40;
/** Шаг нагрузки на попытку и число попыток (итог — до 40 КБ на 10-й). */
export const BLOCK_1620_STEP_KB = 4;
export const BLOCK_1620_STEPS = 10;

/** Сколько раз повторить проверку перед вердиктом — единичный обрыв ненадёжен (бывают случайные RST). */
export const BLOCK_CHECK_ATTEMPTS = 3;
/** Тайм-ауты проверки, секунды. */
export const BLOCK_CHECK_CONNECT_TIMEOUT_SEC = 8;
export const BLOCK_CHECK_READ_TIMEOUT_SEC = 12;

export const BLOCK_VERDICTS = ['unreachable', 'tspu', 'block_16_20', 'ok'] as const;
export type BlockVerdict = (typeof BLOCK_VERDICTS)[number];
export const BLOCK_VERDICT_LABELS: Record<BlockVerdict, string> = {
  unreachable: 'Сервер недоступен',
  tspu: 'Похоже на блокировку ТСПУ',
  block_16_20: 'Похоже на блок «16–20 КБ»',
  ok: 'Проблем не обнаружено',
};

/** Один прогон проверки с одного пробующего сервера. */
export const blockProbeResultSchema = z.object({
  /** Имя сервера-пробы (в отчёте всегда явно называем, откуда шла проверка). */
  from: z.string(),
  verdict: z.enum(BLOCK_VERDICTS),
  /** Короткая техническая деталь для инцидента: этап обрыва, объём данных и т. п. По-русски, без терминов кода. */
  detail: z.string(),
  /** Кумулятивный объём данных на момент обрыва (КБ) — только для block_16_20/ok. */
  stalledAtKb: z.number().nullable(),
  error: z.string().nullable(),
});
export type BlockProbeResult = z.infer<typeof blockProbeResultSchema>;

export const blockCheckResultSchema = z.object({
  nodeName: z.string(),
  address: z.string(),
  /** null — SNI ноды не удалось определить (например, инбаунд не Reality), проверка не запускалась. */
  sniUsed: z.string().nullable(),
  probes: z.array(blockProbeResultSchema),
  /** Итоговый вердикт по всем пробам вместе (см. combineVerdicts). */
  verdict: z.enum(BLOCK_VERDICTS),
});
export type BlockCheckResult = z.infer<typeof blockCheckResultSchema>;
