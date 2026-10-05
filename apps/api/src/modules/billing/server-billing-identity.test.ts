import { describe, expect, it } from 'vitest';

import { billingItemBelongsToServer } from './server-billing-identity.js';

const belongs = (over: Partial<Parameters<typeof billingItemBelongsToServer>[0]> = {}) =>
  billingItemBelongsToServer({
    kind: 'rent',
    title: 'Guardora',
    provider: null,
    serverIds: [],
    serverId: 'guardora-server',
    aliases: ['guardora (Аренда)', 'guardora'],
    ...over,
  });

describe('сопоставление аренды с сервером', () => {
  it('прямая связь по serverId всегда имеет приоритет', () => {
    expect(belongs({ kind: 'server', title: 'Польша', serverIds: ['guardora-server'], aliases: [] })).toBe(
      true,
    );
  });

  it('непривязанная аренда узнаётся по владельцу входа или названию сервера', () => {
    expect(belongs()).toBe(true);
    expect(belongs({ title: 'Аренда Hub Rent', aliases: ['HubRent (Аренда)'] })).toBe(true);
    expect(belongs({ title: 'Вход', provider: 'Guardora' })).toBe(true);
  });

  it('не путает оплату выходного VPS с арендой входа', () => {
    expect(belongs({ kind: 'server', title: 'Польша (Выход Guardora)' })).toBe(false);
  });

  it('не забирает аренду, уже привязанную к другому серверу', () => {
    expect(belongs({ serverIds: ['another-server'] })).toBe(false);
  });

  it('не считает совпадением чужую непривязанную аренду', () => {
    expect(belongs({ title: 'Hub Rent', provider: 'Julsapart' })).toBe(false);
  });
});
