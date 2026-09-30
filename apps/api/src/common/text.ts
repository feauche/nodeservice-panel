/**
 * «Похоже на блокировку IP из России» → «похоже на блокировку IP из России»: строчной делается только
 * первая буква обычного слова. Целиком в нижний регистр подпись переводить нельзя — «IP», «ТСПУ» и
 * «SSH» превращались в «ip», «тспу» и «ssh». Подпись, начинающаяся с сокращения, остаётся как есть.
 */
export function lowerFirst(s: string): string {
  return /^[А-ЯЁA-Z][а-яёa-z]/.test(s) ? `${s.charAt(0).toLowerCase()}${s.slice(1)}` : s;
}

/**
 * Обрезать длинный многострочный текст до `max` знаков, сохранив начало и последний блок (после последней
 * пустой строки): в тексте инцидента вывод стоит в конце, и простая обрезка по длине съедала именно его.
 * Режется середина — по границе строки, на её месте «…». Последний блок слишком длинный — обычная обрезка.
 */
export function clipKeepingEnd(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n\n');
  const tail = cut >= 0 ? text.slice(cut + 2) : '';
  const mark = '\n…\n';
  const room = max - tail.length - mark.length;
  if (!tail || room < 40) return `${text.slice(0, max - 1)}…`;
  const head: string[] = [];
  let used = 0;
  for (const line of text.slice(0, cut).split('\n')) {
    if (used + line.length + 1 > room) break;
    head.push(line);
    used += line.length + 1;
  }
  return `${head.join('\n').trimEnd()}${mark}${tail}`;
}
