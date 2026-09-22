import { z } from 'zod';

/**
 * Контракт настроек панели (этап 1+: только то, что уже есть в продукте).
 *
 *  GET /api/settings/appearance  → AppearanceSettings   (публично: логотип нужен и на экране входа)
 *  PUT /api/settings/appearance  → AppearanceSettings   (только администратор)
 */

/** Ссылка на логотип: только http(s), до 2048 символов. null — вернуть встроенный логотип. */
export const logoUrlSchema = z
  .url({ protocol: /^https?$/, error: 'Нужна прямая ссылка вида https://…/logo.png или .svg' })
  .max(2048, 'Слишком длинная ссылка')
  .nullable();

/**
 * Название панели с цветами: код цвета в квадратных скобках красит всё до следующего кода.
 * Коды: [#rgb] / [#rrggbb] или [#accent] (цвет акцента текущей темы). Пробелы сохраняются.
 * Пример: «Node[#accent]Service» → «Node» обычным, «Service» акцентным.
 */
export const BRAND_NAME_DEFAULT = 'Node[#accent]Service';
export const BRAND_NAME_MAX = 64;
const COLOR_TOKEN = /(\[#(?:accent|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\])/;
const COLOR_CODE = /^\[#(accent|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\]$/;

export interface BrandSegment {
  text: string;
  /** null — цвет текста по умолчанию; 'accent' — акцент темы; иначе hex. */
  color: string | null;
}

export function parseBrandName(raw: string): BrandSegment[] {
  const out: BrandSegment[] = [];
  let color: string | null = null;
  for (const part of raw.split(COLOR_TOKEN)) {
    if (part === '') continue;
    const code = COLOR_CODE.exec(part)?.[1];
    if (code !== undefined) {
      color = code === 'accent' ? 'accent' : `#${code.toLowerCase()}`;
      continue;
    }
    out.push({ text: part, color });
  }
  return out;
}

/** Видимый текст без кодов цвета. */
export function brandNamePlain(raw: string): string {
  return parseBrandName(raw)
    .map((s) => s.text)
    .join('');
}

export const brandNameSchema = z
  .string()
  .max(BRAND_NAME_MAX * 2, 'Слишком длинное название')
  .refine((v) => brandNamePlain(v).trim().length > 0, 'Название не может быть пустым')
  .refine((v) => brandNamePlain(v).length <= BRAND_NAME_MAX, `Название — до ${BRAND_NAME_MAX} символов`);

export const appearanceSettingsSchema = z.object({
  /** Свой логотип внутри панели (в шапке, на экранах входа). Иконка вкладки браузера не меняется. */
  logoUrl: logoUrlSchema,
  /** Название с цветовыми кодами, см. parseBrandName. */
  brandName: brandNameSchema.default(BRAND_NAME_DEFAULT),
});
export type AppearanceSettings = z.infer<typeof appearanceSettingsSchema>;

export const appearanceSettingsUpdateSchema = z.object({
  logoUrl: logoUrlSchema.optional(),
  brandName: brandNameSchema.optional(),
});
export type AppearanceSettingsUpdate = z.infer<typeof appearanceSettingsUpdateSchema>;

export const APPEARANCE_DEFAULTS: AppearanceSettings = { logoUrl: null, brandName: BRAND_NAME_DEFAULT };
