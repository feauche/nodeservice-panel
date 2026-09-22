import { z } from 'zod';

/** База знаний (этап 9): markdown-документы с тегами и полнотекстовым поиском. */

export const KB_TITLE_MAX = 160;
export const KB_CONTENT_MAX = 100_000;
export const KB_TAGS_MAX = 12;

export const KB_SOURCES = ['self', 'ai', 'web', 'telegram'] as const;
export type KbSource = (typeof KB_SOURCES)[number];
/** Откуда взята информация в статье — для бейджа источника в базе знаний. */
export const KB_SOURCE_LABELS: Record<KbSource, string> = {
  self: 'Вручную',
  ai: 'AI-ассистент',
  web: 'Веб',
  telegram: 'Telegram',
};

export const kbDocSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  archived: z.boolean(),
  source: z.enum(KB_SOURCES),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type KbDoc = z.infer<typeof kbDocSchema>;

/** Короткая карточка для списка (без тела). */
export const kbDocSummarySchema = kbDocSchema.omit({ content: true }).extend({
  excerpt: z.string(),
});
export type KbDocSummary = z.infer<typeof kbDocSummarySchema>;

const tag = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[^\s]+$/, 'Тег без пробелов');

export const kbDocCreateSchema = z.object({
  title: z.string().trim().min(1, 'Нужен заголовок').max(KB_TITLE_MAX),
  content: z.string().max(KB_CONTENT_MAX).default(''),
  tags: z.array(tag).max(KB_TAGS_MAX).default([]),
  source: z.enum(KB_SOURCES).default('self'),
});
export type KbDocCreate = z.infer<typeof kbDocCreateSchema>;

export const kbDocUpdateSchema = z.object({
  title: z.string().trim().min(1).max(KB_TITLE_MAX).optional(),
  content: z.string().max(KB_CONTENT_MAX).optional(),
  tags: z.array(tag).max(KB_TAGS_MAX).optional(),
  archived: z.boolean().optional(),
  source: z.enum(KB_SOURCES).optional(),
});
export type KbDocUpdate = z.infer<typeof kbDocUpdateSchema>;

export const kbListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  // ВАЖНО: z.coerce.boolean() превращает строку "false" в true (Boolean("false") === true),
  // из-за чего ?archived=false отдавал архивные статьи вместо активных. Разбираем строку явно.
  archived: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((v) => v === true || v === 'true' || v === '1'),
});
export type KbListQuery = z.infer<typeof kbListQuerySchema>;

export const kbListResponseSchema = z.object({ items: z.array(kbDocSummarySchema) });
export type KbListResponse = z.infer<typeof kbListResponseSchema>;

/** Версия статьи в истории (для отката). Причина: edit — правка, revert — откат, review — ревизия. */
export const kbVersionSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  reason: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type KbVersion = z.infer<typeof kbVersionSchema>;
export const kbVersionsResponseSchema = z.object({ items: z.array(kbVersionSchema) });
export type KbVersionsResponse = z.infer<typeof kbVersionsResponseSchema>;
