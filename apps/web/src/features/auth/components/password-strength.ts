import { PASSWORD_MIN } from '@nodeservice/shared';

import { plural } from '@/lib/plural';

/** Те же 13 слов, что в демо: пароль с любым из них считается утёкшим. */
export const LEAKED_WORDS = [
  'password',
  'qwerty',
  '123456',
  'admin',
  'letmein',
  'welcome',
  'iloveyou',
  'dragon',
  'football',
  'monkey',
  '111111',
  'abc123',
  'passw0rd',
] as const;

export const STRENGTH_LABELS = ['', 'слабая — подберут быстро', 'средняя', 'хорошая', 'отличная'] as const;

export const PASSWORD_DEFAULT_HINT =
  'От 12 символов. Фраза из 3–4 слов надёжнее набора символов, а запомнить проще.';

export type Score = 0 | 1 | 2 | 3 | 4;

/** Оценка 0–4: длина 8/12/20, регистр, цифры или символы. */
export function passwordScore(p: string): Score {
  if (!p) return 0;
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 12) s++;
  if (/[A-ZА-ЯЁ]/.test(p) && /[a-zа-яё]/.test(p)) s++;
  if (/\d/.test(p) || /[^\p{L}\p{N}\s]/u.test(p)) s++;
  if (p.length >= 20) s++;
  return Math.min(4, s) as Score;
}

export function isLeakedPassword(p: string): boolean {
  const l = p.toLowerCase();
  return LEAKED_WORDS.some((w) => l.includes(w));
}

export interface StrengthInfo {
  /** Заполненных сегментов (утёкший пароль — всегда 1). */
  level: Score;
  leaked: boolean;
  label: string;
}

export function passwordStrength(p: string): StrengthInfo {
  if (!p) return { level: 0, leaked: false, label: PASSWORD_DEFAULT_HINT };
  const leaked = isLeakedPassword(p);
  const score = passwordScore(p);
  if (leaked) return { level: 1, leaked: true, label: 'Встречается в утечках — не подойдёт' };
  const left = PASSWORD_MIN - p.length;
  const more = left > 0 ? ` · нужно ещё ${left} ${plural(left, 'символ', 'символа', 'символов')}` : '';
  return { level: score, leaked: false, label: `Стойкость: ${STRENGTH_LABELS[Math.max(1, score)]}${more}` };
}
