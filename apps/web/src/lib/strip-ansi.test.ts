import { describe, expect, it } from 'vitest';

import { stripAnsi } from './strip-ansi';

describe('stripAnsi', () => {
  it('убирает цвета, курсор, OSC и BEL', () => {
    expect(stripAnsi('\u001b[32mok\u001b[0m \u001b[1;31mfail\u001b[m')).toBe('ok fail');
    expect(stripAnsi('\u001b]0;title\u0007root@host:~# ')).toBe('root@host:~# ');
    expect(stripAnsi('a\u001b[2Kb\u0007')).toBe('ab');
  });
  it('одиночные ESC-команды ncurses-приложений: keypad, charset, reset', () => {
    expect(stripAnsi('\u001b=\u001b(B\u001b)0htop\u001b>\u001bc')).toBe('htop');
  });
  it('перевод строки CRLF и прогресс-бары через \\r', () => {
    expect(stripAnsi('line1\r\nline2\r\n')).toBe('line1\nline2\n');
    expect(stripAnsi('10%\r50%\r100%\ndone')).toBe('100%\ndone');
  });
});
