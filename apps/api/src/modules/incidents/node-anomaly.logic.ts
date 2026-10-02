import {
  NODE_ONLINE_COLLAPSE_BASELINE_SAMPLES,
  NODE_ONLINE_COLLAPSE_WINDOW_MIN,
  NODE_ONLINE_DROP_WINDOW_MIN,
} from '@nodeservice/shared';

import type { VmMatrixSeries } from '../metrics/vm-reader.service.js';

/** Снимок онлайна ноды: время снимка Remnawave (мс) и число пользователей. */
export interface OnlineSample {
  at: number;
  online: number;
}

const WINDOW_MS = NODE_ONLINE_DROP_WINDOW_MIN * 60_000;
const COLLAPSE_WINDOW_MS = NODE_ONLINE_COLLAPSE_WINDOW_MIN * 60_000;
/**
 * Перерыв в снимках (панель не работала, Remnawave не отвечала) дольше этого — прежний онлайн уже не база:
 * за большее время онлайн заметно меняется и сам, без всякого сбоя.
 */
export const ONLINE_GAP_MAX_MS = 30 * 60_000;
/** За сколько минут читать сохранённые измерения после запуска: окно плюс допустимый перерыв. */
export const ONLINE_RESTORE_MIN = NODE_ONLINE_COLLAPSE_WINDOW_MIN + ONLINE_GAP_MAX_MS / 60_000;

/**
 * С чем сравнивать свежий онлайн: наибольший онлайн за окно (NODE_ONLINE_DROP_WINDOW_MIN) перед последним
 * известным снимком. Сравнение только с предыдущей минутой пропускало падение ступеньками
 * (300 → 200 → 110 → 30: ни один шаг не дотягивает до порога). Окно считается от последнего снимка, а не
 * от «сейчас»: после перезапуска панели базой остаётся онлайн до перерыва. `prior` — по возрастанию времени,
 * без свежего снимка. null — сравнивать не с чем (снимков нет или перерыв слишком длинный).
 */
export function onlineBaseline(prior: OnlineSample[], nowMs: number): OnlineSample | null {
  const last = prior.at(-1);
  if (!last || nowMs - last.at > ONLINE_GAP_MAX_MS) return null;
  let best: OnlineSample | null = null;
  // При равных значениях — более поздний снимок: «за N минут» в тексте тогда не длиннее настоящего.
  for (const s of prior) if (s.at > last.at - WINDOW_MS && (!best || s.online >= best.online)) best = s;
  return best;
}

/**
 * Подтверждённый высокий онлайн за длинное окно. Берём третий по высоте снимок: так один-два
 * случайных пика не станут базой, а реальный рабочий уровень не исчезнет после пяти минут низкого
 * онлайна. Перерыв дольше ONLINE_GAP_MAX_MS отменяет сравнение: за это время картина могла смениться.
 */
export function collapseBaseline(prior: OnlineSample[], nowMs: number): OnlineSample | null {
  const last = prior.at(-1);
  if (!last || nowMs - last.at > ONLINE_GAP_MAX_MS) return null;
  const eligible = prior.filter((s) => s.at > last.at - COLLAPSE_WINDOW_MS);
  if (eligible.length < NODE_ONLINE_COLLAPSE_BASELINE_SAMPLES) return null;
  const high = [...eligible]
    .sort((a, b) => b.online - a.online)
    .at(NODE_ONLINE_COLLAPSE_BASELINE_SAMPLES - 1);
  if (!high) return null;
  // Время — последний снимок не ниже устойчивого уровня, чтобы длительность не завышать.
  return eligible.findLast((s) => s.online >= high.online) ?? high;
}

/** История с новым снимком: всё, что старше длинного окна, базой уже не станет. */
export function withSample(prior: OnlineSample[], sample: OnlineSample): OnlineSample[] {
  return [...prior.filter((s) => s.at > sample.at - COLLAPSE_WINDOW_MS), sample];
}

/**
 * Сохранённые измерения онлайна (по минутам) → история по нодам. У переименованной ноды рядов несколько:
 * точки одной минуты сливаются по наибольшему значению.
 */
export function samplesFromSeries(series: VmMatrixSeries[]): Map<string, OnlineSample[]> {
  const byNode = new Map<string, Map<number, number>>();
  for (const s of series) {
    const uuid = s.labels.node_uuid;
    if (!uuid) continue;
    const points = byNode.get(uuid) ?? new Map<number, number>();
    byNode.set(uuid, points);
    for (const [t, v] of s.points)
      if (Number.isFinite(t) && Number.isFinite(v)) points.set(t, Math.max(points.get(t) ?? 0, v));
  }
  const out = new Map<string, OnlineSample[]>();
  for (const [uuid, points] of byNode)
    out.set(
      uuid,
      [...points].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ at: t * 1000, online: Math.round(v) })),
    );
  return out;
}

/** Онлайн до падения из текста дела: «Онлайн: 396 → 0 (−100 %) …». Есть только у дел о падении онлайна. */
export function baselineFromDetail(detail: string): number | null {
  const m = /Онлайн:\s*(\d+)\s*→/.exec(detail);
  return m ? Number(m[1]) : null;
}

/** «за 1 минуту», «за 3 минуты», «за 12 минут». */
export function minutesText(n: number): string {
  const few = n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20);
  return `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'минуту' : few ? 'минуты' : 'минут'}`;
}
