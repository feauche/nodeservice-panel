import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';
import { randomId } from './utils';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

// Панель во внутренней сети открывают по http: там у браузера нет ни буфера обмена, ни crypto.randomUUID.
describe('Панель по http во внутренней сети', () => {
  it('копирует через буфер обмена, если он есть', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await copyText('ключ')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('ключ');
  });

  it('без буфера обмена — через скрытое поле рядом с кнопкой, и поле убирается', async () => {
    vi.stubGlobal('navigator', {});
    const dialog = document.createElement('div');
    const button = document.createElement('button');
    dialog.append(button);
    document.body.append(dialog);
    let copied: string | null = null;
    let inDialog = false;
    const exec = vi.fn((cmd: string) => {
      const field = document.querySelector('textarea');
      copied = cmd === 'copy' && field ? field.value : null;
      inDialog = field?.parentElement === dialog;
      return true;
    });
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    expect(await copyText('коды восстановления', button)).toBe(true);
    expect(copied).toBe('коды восстановления');
    expect(inDialog).toBe(true);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('браузер запретил буфер — запасной путь; не вышло и так — false', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('запрещено')) },
    });
    Object.defineProperty(document, 'execCommand', { value: vi.fn(() => false), configurable: true });
    expect(await copyText('отчёт')).toBe(false);
  });

  it('UUID без crypto.randomUUID — из случайных байтов, версия 4', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
    const a = randomId();
    const b = randomId();
    expect(a).toMatch(UUID);
    expect(b).toMatch(UUID);
    expect(a).not.toBe(b);
  });
});
