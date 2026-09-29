import { z } from 'zod';

/**
 * «Куда сервер может выйти» (0.43.0): проверка с самого сервера — к панели, в Россию, за рубеж. Показывается
 * в окне сервера, когда агент не на связи (витрина `agent-pending-variants.html`, вариант A).
 */
export const EGRESS_GROUPS = ['panel', 'ru', 'foreign'] as const;
export type EgressGroup = (typeof EGRESS_GROUPS)[number];
export const EGRESS_GROUP_LABELS: Record<EgressGroup, string> = {
  panel: 'Панель',
  ru: 'Россия',
  foreign: 'За рубежом',
};

export const EGRESS_VERDICTS = [
  'ok',
  'no_internet',
  'ru_and_panel_cut',
  'ru_cut',
  'panel_cut',
  'partial',
  'unknown',
] as const;
export type EgressVerdict = (typeof EGRESS_VERDICTS)[number];
/** Итоги, при которых агент физически не может выйти на связь — статус «Нет связи с панелью». */
export const EGRESS_PANEL_CUT: readonly EgressVerdict[] = ['ru_and_panel_cut', 'panel_cut', 'no_internet'];

export const egressReportSchema = z.object({
  checkedAt: z.iso.datetime(),
  /** Через какой сервер парка заходили; null — напрямую. */
  via: z.string().nullable(),
  verdict: z.enum(EGRESS_VERDICTS),
  /** Одна фраза жирным: что случилось. */
  headline: z.string(),
  /** Что делать. */
  advice: z.string(),
  panelPing: z.boolean().nullable(),
  results: z.array(
    z.object({
      label: z.string(),
      group: z.enum(EGRESS_GROUPS),
      open: z.boolean(),
      ms: z.number().nullable(),
    }),
  ),
  /** Готовый текст обращения к хостеру с результатами. */
  hosterText: z.string(),
});
export type EgressReportDto = z.infer<typeof egressReportSchema>;

export const egressResponseSchema = z.object({ report: egressReportSchema.nullable() });
export type EgressResponse = z.infer<typeof egressResponseSchema>;
