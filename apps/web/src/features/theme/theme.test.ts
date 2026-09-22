import { beforeEach, describe, expect, it } from 'vitest';
import { cycleTheme, getTheme, initTheme, setTheme, THEMES } from './theme';

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-ns-theme');
  });

  it('по умолчанию — графит', () => {
    initTheme();
    expect(getTheme()).toBe('dark');
    expect(document.documentElement.getAttribute('data-ns-theme')).toBe('dark');
  });

  it('сохраняет выбор и восстанавливает его', () => {
    setTheme('black');
    expect(localStorage.getItem('ns-theme')).toBe('black');
    document.documentElement.removeAttribute('data-ns-theme');
    initTheme();
    expect(getTheme()).toBe('black');
  });

  it('переключает по кругу через все три темы', () => {
    setTheme('dark');
    const seen: string[] = [];
    for (let i = 0; i < THEMES.length; i++) {
      cycleTheme();
      seen.push(getTheme());
    }
    expect(seen).toEqual(['light', 'black', 'dark']);
  });

  it('игнорирует мусор в localStorage', () => {
    localStorage.setItem('ns-theme', 'neon');
    initTheme();
    expect(getTheme()).toBe('dark');
  });
});
