import { beforeEach, describe, expect, it } from 'vitest';

import { forgetReturnPath, isReturnPath, rememberReturnPath, takeReturnPath } from './return-path';

describe('куда вернуться после пароля', () => {
  beforeEach(() => sessionStorage.clear());

  it('только свои страницы панели, не экраны входа и не чужие сайты', () => {
    expect(isReturnPath('/incidents/42?tab=log#t')).toBe(true);
    expect(isReturnPath('/settings/security')).toBe(true);
    expect(isReturnPath('/')).toBe(false);
    expect(isReturnPath('/lock')).toBe(false);
    expect(isReturnPath('/login/2fa')).toBe(false);
    expect(isReturnPath('/setup')).toBe(false);
    expect(isReturnPath('/locker')).toBe(true);
    expect(isReturnPath('//evil.example/x')).toBe(false);
    expect(isReturnPath('/\\evil.example')).toBe(false);
    expect(isReturnPath('https://evil.example/')).toBe(false);
  });

  it('запомнить, забрать один раз; экран блокировки прежний адрес не затирает', () => {
    rememberReturnPath('/incidents/7');
    rememberReturnPath('/lock');
    expect(takeReturnPath()).toBe('/incidents/7');
    expect(takeReturnPath()).toBe('/');
  });

  it('выход по своей воле — следующий вход с «Обзора»', () => {
    rememberReturnPath('/servers');
    forgetReturnPath();
    expect(takeReturnPath()).toBe('/');
  });
});
