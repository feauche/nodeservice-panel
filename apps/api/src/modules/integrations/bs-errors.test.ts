import { describe, expect, it } from 'vitest';
import { bsErrorText } from './bs-errors.js';

describe('BS Checker: ошибки по-русски по коду контракта', () => {
  it('знакомый код — своя фраза, пауза из retry_after там, где просят подождать', () => {
    expect(bsErrorText('scope_required')).toContain('Может менять адреса точек аренды');
    expect(bsErrorText('rate_limited', { retry_after: 2.2 })).toBe(
      'Слишком часто: BS Checker принимает не чаще раза в секунду. Подождите 3 с.',
    );
    expect(bsErrorText('daily_limit')).toContain('48 в сутки');
  });
  it('ошибки адресов — по номеру выхода, если сервис написал их по-русски', () => {
    expect(
      bsErrorText('invalid_targets', {
        errors: [
          { index: 1, message: 'адрес в запрещённой сети' },
          { index: 0, message: 'bad port' },
        ],
      }),
    ).toBe('Адреса выходов не приняты. Выход 2: адрес в запрещённой сети');
    expect(bsErrorText('invalid_exits', { errors: [{ index: 0, message: 'порт занят VPN' }] })).toBe(
      'Серверы точки не приняты. Сервер 1: порт занят VPN',
    );
  });
  it('незнакомый код — по HTTP-статусу, без английских слов', () => {
    expect(bsErrorText('something_new', null, 402)).toBe('Не хватает кредитов на балансе BS Checker.');
    expect(bsErrorText('something_new', null, 503)).toBe('BS Checker временно не работает. Повторите позже.');
    expect(bsErrorText('something_new', null, 418)).toBe('BS Checker не выполнил запрос (код ответа 418).');
  });
});
