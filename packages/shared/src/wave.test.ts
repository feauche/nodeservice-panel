import { describe, expect, it } from 'vitest';
import { scenarioSchema } from './scenarios.js';
import { waveGroupOf } from './wave.js';

describe('волна: группа ноды', () => {
  it('провайдер, а без провайдера — страна; без обоих — не в волнах', () => {
    expect(waveGroupOf({ providerUuid: 'p1', providerName: 'Aeza', countryCode: 'NL' })).toEqual({
      key: 'provider:p1',
      label: 'Aeza',
      cause: 'provider',
    });
    expect(waveGroupOf({ providerUuid: null, providerName: null, countryCode: 'RU' })).toMatchObject({
      key: 'country:RU',
      cause: 'country',
    });
    expect(waveGroupOf({ providerUuid: null, providerName: null, countryCode: null })).toBeNull();
  });

  it('у старых сценариев исключений нет — поведение не меняется', () => {
    const rule = scenarioSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Старый',
      trigger: 'offline',
      actions: ['notify'],
    });
    expect(rule.except).toEqual([]);
  });
});
