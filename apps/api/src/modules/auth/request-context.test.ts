import { describe, expect, it } from 'vitest';

import { incomingRequestId } from './request-context.js';

describe('incomingRequestId — идентификатор запроса из заголовка', () => {
  it('принимает только UUID и приводит к нижнему регистру', () => {
    expect(incomingRequestId('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(
      '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    );
    expect(incomingRequestId('3F2504E0-4F89-41D3-9A0C-0305E82C3301')).toBe(
      '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    );
  });

  it('всё остальное отбрасывает: панель выдаст свой идентификатор', () => {
    expect(incomingRequestId(undefined)).toBeUndefined();
    expect(incomingRequestId('')).toBeUndefined();
    expect(incomingRequestId('x'.repeat(4000))).toBeUndefined();
    expect(incomingRequestId('3f2504e0-4f89-41d3-9a0c-0305e82c3301 и ещё текст')).toBeUndefined();
    expect(incomingRequestId('3f2504e04f8941d39a0c0305e82c3301')).toBeUndefined();
    // заголовок повторён дважды — Node отдаёт массив
    expect(incomingRequestId(['3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'x'])).toBeUndefined();
  });
});
