/**
 * Убирает управляющие последовательности терминала из записи сессии, оставляя текст:
 * CSI (цвета, курсор), OSC (заголовок окна, гиперссылки), одиночные ESC-команды, а также
 * \r и BEL. Возврат каретки без перевода строки (прогресс-бары) схлопывается до последнего кадра.
 */
const ANSI_RE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: это и есть управляющие символы терминала
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[ -/]*[0-~]|\u0007/g;

export function stripAnsi(input: string): string {
  const plain = input.replace(ANSI_RE, '');
  return plain
    .split('\n')
    .map((line) => {
      // "abc\rxyz" → "xyz" (последний кадр строки), хвост "\r" — просто убрать
      const parts = line.split('\r');
      return parts[parts.length - 1] === '' && parts.length > 1
        ? parts[parts.length - 2]
        : parts[parts.length - 1];
    })
    .join('\n');
}
