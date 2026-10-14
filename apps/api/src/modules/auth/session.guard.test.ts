import { ACTIVITY_HEADER } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { activityFrom } from './session.guard.js';

const NOW = 1_800_000_000_000;
const req = (path: string, value?: string) => ({
  path,
  headers: value === undefined ? {} : { [ACTIVITY_HEADER]: value },
});

describe('когда человек последний раз что-то делал в панели (заголовок браузера)', () => {
  it('секунды бездействия из заголовка', () => {
    expect(activityFrom(req('/api/servers', '90'), NOW)).toBe(NOW - 90_000);
    expect(activityFrom(req('/api/auth/me', '0'), NOW)).toBe(NOW);
  });

  it('без заголовка — действие сейчас: запрос не из панели или вкладка прежней версии', () => {
    expect(activityFrom(req('/api/servers'), NOW)).toBeUndefined();
    expect(activityFrom(req('/api/servers', ''), NOW)).toBeUndefined();
  });

  it('поток событий, картинки и непонятное значение действием не считаются', () => {
    expect(activityFrom(req('/api/events/stream', '0'), NOW)).toBeNull();
    expect(activityFrom(req('/api/audit/stream'), NOW)).toBeNull();
    expect(
      activityFrom(
        { path: '/api/settings/custom-sites/x/icon', headers: { 'sec-fetch-dest': 'image' } },
        NOW,
      ),
    ).toBeNull();
    expect(activityFrom(req('/api/servers', 'abc'), NOW)).toBeNull();
    expect(activityFrom(req('/api/servers', '-5'), NOW)).toBeNull();
  });

  it('бездействие больше недели обрезается', () => {
    expect(activityFrom(req('/api/servers', '99999999'), NOW)).toBe(NOW - 7 * 24 * 3600 * 1000);
  });
});
