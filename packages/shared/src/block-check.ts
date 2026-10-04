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
/**
 * Сколько снимков онлайна подряд должны показать просадку, чтобы открыть инцидент (решение владельца
 * 29.09.2026: на третью проверку, не на вторую — перезагрузки и короткие сбои не должны шуметь).
 */
export const NODE_ONLINE_DROP_CONFIRM_CHECKS = 3;
/**
 * Медленный, но критичный обвал: короткое окно выше его не видит, если онлайн падал
 * ступенями. База считается по нескольким высоким снимкам, поэтому один случайный пик
 * не поднимает тревогу.
 */
export const NODE_ONLINE_COLLAPSE_PCT = 90;
export const NODE_ONLINE_COLLAPSE_WINDOW_MIN = 6 * 60;
export const NODE_ONLINE_COLLAPSE_MIN_BASELINE = 50;
export const NODE_ONLINE_COLLAPSE_BASELINE_SAMPLES = 3;
/** Медленную просадку подтверждаем дольше, чем резкую: пятью свежими снимками. */
export const NODE_ONLINE_COLLAPSE_CONFIRM_CHECKS = 5;
/** Сколько снимков подряд онлайн должен быть в норме, чтобы открытый инцидент закрылся сам. */
export const NODE_ONLINE_RECOVER_CHECKS = 3;
/** «В норме» — не меньше такой доли онлайна до падения, %. */
export const NODE_ONLINE_RECOVER_PCT = 50;

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

/**
 * `partial` — порт отвечает с перебоями: с части российских проверяющих отвечает, с части нет, либо один и
 * тот же проверяющий подключается не каждый раз. Сервер работает: «недоступен» и «блокировка IP из России»
 * про него сказать нельзя (молчащий проверяющий или сорвавшаяся попытка не перевешивают удачных).
 */
export const BLOCK_VERDICTS = [
  'unreachable',
  'ip_block',
  'tspu',
  'block_16_20',
  'vpn_failed',
  'indeterminate',
  'partial',
  'ok',
] as const;
export type BlockVerdict = (typeof BLOCK_VERDICTS)[number];
export const BLOCK_VERDICT_LABELS: Record<BlockVerdict, string> = {
  unreachable: 'Сервер недоступен',
  ip_block: 'Похоже на блокировку IP из России',
  tspu: 'Похоже на блокировку ТСПУ',
  block_16_20: 'Похоже на блок «16–20 КБ»',
  vpn_failed: 'VPN-трафик не проходит',
  indeterminate: 'REALITY-трафик не проверен',
  partial: 'Порт отвечает с перебоями',
  ok: 'Проблем не обнаружено',
};

/**
 * Почему проверка не состоялась (проб нет): панель называет настоящую причину, а не одну на все случаи.
 * - no_port — в Remnawave не нашёлся порт подключения ноды;
 * - bad_address — адрес, порт или имя маскировки записаны с недопустимыми знаками;
 * - no_probers — в парке нет подходящего российского сервера с рабочим SSH;
 * - ssh — проверяющие есть, но панель не зашла ни на один из них;
 * - no_answer — панель зашла, но команда проверки на проверяющих не вернула результата;
 * - remnawave — порт узнать не удалось: Remnawave не ответила на запрос (это не «порта нет»);
 * - gone — проверять нечего: мост, указанный в профиле как вход, удалён из панели.
 */
export const BLOCK_UNCHECKED_REASONS = [
  'no_port',
  'bad_address',
  'no_probers',
  'ssh',
  'no_answer',
  'remnawave',
  'gone',
] as const;
export type BlockUncheckedReason = (typeof BLOCK_UNCHECKED_REASONS)[number];

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

export const VPN_PROBE_VERDICTS = [
  'unavailable',
  'ok',
  'regional_block',
  'failed_everywhere',
  'mixed',
] as const;
export type VpnProbeVerdict = (typeof VPN_PROBE_VERDICTS)[number];

export const vpnProbeResultSchema = z.object({
  from: z.string(),
  country: z.string().nullable(),
  ok: z.boolean(),
  stage: z.string(),
  detail: z.string(),
  latencyMs: z.number().int().min(0).nullable(),
  bytes: z.number().int().min(0),
});
export type VpnProbeResult = z.infer<typeof vpnProbeResultSchema>;

export const blockCheckResultSchema = z.object({
  /** Что именно проверяли: пользовательский порт ноды или SSH-порт обычного сервера. Старые записи — node. */
  targetKind: z.enum(['node', 'server']).optional(),
  /** Фактический проверенный порт. В старых сохранённых результатах поля нет. */
  port: z.number().int().min(1).max(65535).optional(),
  nodeName: z.string(),
  address: z.string(),
  /** null — SNI ноды неизвестен: TCP-порт всё равно проверен, недоступна только глубокая проверка DPI. */
  sniUsed: z.string().nullable(),
  probes: z.array(blockProbeResultSchema),
  /**
   * Проверка того же TCP-порта с зарубежных серверов парка. Она идёт вместе с российской всегда, чтобы
   * первое сообщение и повторный разбор показывали одну географию. Из России нет, из-за рубежа есть — так
   * выглядит блокировка IP на стороне России. Пусто — зарубежных проверяющих нет или они не ответили.
   */
  foreign: z.array(blockProbeResultSchema).default([]),
  /** Настоящий VLESS/REALITY-трафик через агенты; поля отсутствуют у старых сохранённых результатов. */
  vpnProbes: z.array(vpnProbeResultSchema).optional(),
  vpnForeign: z.array(vpnProbeResultSchema).optional(),
  vpnVerdict: z.enum(VPN_PROBE_VERDICTS).optional(),
  vpnUnchecked: z.string().nullable().optional(),
  /** Итоговый вердикт по всем пробам вместе (см. combineVerdicts). */
  verdict: z.enum(BLOCK_VERDICTS),
  /** Почему проб нет; null — пробы есть (или причина не записана: старый результат). */
  unchecked: z.enum(BLOCK_UNCHECKED_REASONS).nullable().default(null),
  /**
   * Почему нет проверки из-за рубежа: зарубежных серверов в парке нет, панель на них не зашла или команда
   * не вернула результата. null — зарубежная проверка состоялась.
   */
  foreignUnchecked: z.enum(BLOCK_UNCHECKED_REASONS).nullable().default(null),
  /**
   * Проверка входа, если у сервера-выхода в профиле указано, откуда приходит трафик (свой мост или вход
   * арендодателя): стучимся в порт входа из России. Видно, чья сторона сломалась. null — входа нет.
   */
  entry: z
    .object({
      /** «Вход арендодателя» или «Мост «Имя»». */
      label: z.string(),
      address: z.string(),
      owner: z.string().nullable(),
      /**
       * Вход арендован (не свой мост): при неоплате арендодатель выключает именно его, а выход продолжает
       * работать — поэтому «вход молчит, выход жив» при близком сроке оплаты читается как неоплата.
       */
      rented: z.boolean().default(false),
      probes: z.array(blockProbeResultSchema),
      verdict: z.enum(BLOCK_VERDICTS),
      /** Почему у входа нет проб; null — пробы есть. */
      unchecked: z.enum(BLOCK_UNCHECKED_REASONS).nullable().default(null),
    })
    .nullable()
    .default(null),
});
export type BlockCheckResult = z.infer<typeof blockCheckResultSchema>;
