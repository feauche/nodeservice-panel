import { z } from 'zod';

/**
 * Провайдеры (хостеры), у которых куплены серверы: общий справочник панели.
 * Название и сайт вводит администратор, иконку панель берёт с сайта сама (favicon).
 *
 *  GET    /api/providers                 → { items: Provider[] } (с числом серверов)
 *  POST   /api/providers                 → Provider (iconPending: true — иконка ищется в фоне)
 *  PATCH  /api/providers/:id             → Provider (смена сайта — иконка заново)
 *  DELETE /api/providers/:id             → 204 (у серверов провайдер сбрасывается)
 *  GET    /api/providers/:id/icon        → картинка (404, если не нашли)
 *  POST   /api/providers/:id/icon/refresh→ Provider
 *  POST   /api/providers/icon-preview    → { iconDataUrl, sourceUrl } — превью в форме до сохранения
 *
 * Иконка по умолчанию ищется на сайте (<link rel=icon>, /favicon.ico). Можно указать ссылку на
 * картинку вручную (`iconUrl`) — тогда берётся только она; `iconSourceUrl` — откуда иконка взята
 * фактически (для подсказки в форме «Изменить»).
 */

export const PROVIDER_NAME_MAX = 64;
export const PROVIDER_NOTE_MAX = 500;
/** Иконка крупнее не нужна: хранится в БД, показывается 16–36 px. */
export const PROVIDER_ICON_MAX_BYTES = 64 * 1024;

export const PROVIDER_PROBLEM = {
  nameTaken: 'urn:nodeservice:problem:provider-name-taken',
  notFound: 'urn:nodeservice:problem:provider-not-found',
} as const;

export const providerNameSchema = z
  .string()
  .trim()
  .min(1, 'Введите название')
  .max(PROVIDER_NAME_MAX, `До ${PROVIDER_NAME_MAX} символов`);

/** Сайт: адрес с http(s); «hetzner.com» без схемы тоже принимаем и дописываем https. */
export const providerSiteUrlSchema = z
  .string()
  .trim()
  .min(1, 'Введите адрес сайта')
  .max(200)
  .transform((v) => (/^https?:\/\//i.test(v) ? v : `https://${v}`))
  .pipe(z.url({ protocol: /^https?$/, hostname: z.regexes.domain }).or(z.url({ protocol: /^https?$/ })));

/** Ссылка на картинку иконки, если задана вручную; без схемы — дописываем https. */
export const providerIconUrlSchema = z
  .string()
  .trim()
  .min(1, 'Введите ссылку на иконку')
  .max(500)
  .transform((v) => (/^https?:\/\//i.test(v) ? v : `https://${v}`))
  .pipe(z.url({ protocol: /^https?$/ }));

export const providerSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  siteUrl: z.string(),
  /** Хост сайта без схемы — для подписи «hetzner.com». */
  siteHost: z.string(),
  hasIcon: z.boolean(),
  /** Ссылка, заданная вручную; null — иконка ищется на сайте сама. */
  iconUrl: z.string().nullable(),
  /** Откуда иконка взята фактически (найдена на сайте или по ручной ссылке); null — не нашли. */
  iconSourceUrl: z.string().nullable(),
  /** Иконка ещё ищется в фоне: клиент перечитывает список, пока true. */
  iconPending: z.boolean(),
  /** Меняется при каждом обновлении иконки — ломает кэш <img>. */
  iconVersion: z.number().int(),
  note: z.string().nullable(),
  serversCount: z.number().int().min(0),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type Provider = z.infer<typeof providerSchema>;

export const providersResponseSchema = z.object({ items: z.array(providerSchema) });
export type ProvidersResponse = z.infer<typeof providersResponseSchema>;

export const createProviderRequestSchema = z.object({
  name: providerNameSchema,
  siteUrl: providerSiteUrlSchema,
  note: z.string().trim().max(PROVIDER_NOTE_MAX).optional(),
  iconUrl: providerIconUrlSchema.nullable().optional(),
});
export type CreateProviderRequest = z.input<typeof createProviderRequestSchema>;

export const updateProviderRequestSchema = z.object({
  name: providerNameSchema.optional(),
  siteUrl: providerSiteUrlSchema.optional(),
  note: z.string().trim().max(PROVIDER_NOTE_MAX).nullable().optional(),
  /** null — вернуться к автоматическому поиску на сайте. */
  iconUrl: providerIconUrlSchema.nullable().optional(),
});
export type UpdateProviderRequest = z.input<typeof updateProviderRequestSchema>;

export const providerIconPreviewRequestSchema = z.object({
  siteUrl: providerSiteUrlSchema,
  /** Есть ссылка — превью только по ней, сайт не сканируется. */
  iconUrl: providerIconUrlSchema.nullable().optional(),
});
export type ProviderIconPreviewRequest = z.input<typeof providerIconPreviewRequestSchema>;

export const providerIconPreviewResponseSchema = z.object({
  /** data:image/…;base64,… либо null, если на сайте иконки не нашлось. */
  iconDataUrl: z.string().nullable(),
  /** Откуда взята иконка превью. */
  sourceUrl: z.string().nullable(),
  /** Почему иконки нет — короткая причина для формы; null, если нашли. */
  reason: z.string().nullable(),
});
export type ProviderIconPreviewResponse = z.infer<typeof providerIconPreviewResponseSchema>;

/** Иконка взята не с сайта, а из запасного кэша иконок (Google): подпись «из кэша Google». */
export function isProviderIconServiceUrl(sourceUrl: string | null | undefined): boolean {
  return Boolean(sourceUrl && /^https:\/\/(www\.)?google\.com\/s2\/favicons\b/i.test(sourceUrl));
}

/** Хост из адреса сайта для подписи и запасной буквы-иконки. */
export function providerSiteHost(siteUrl: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(siteUrl.trim());
  return (m?.[1] ?? siteUrl).toLowerCase().replace(/^www\./, '');
}
