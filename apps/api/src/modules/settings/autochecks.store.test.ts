import { AUTOCHECKS_DEFAULTS } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { AutochecksStore } from './autochecks.store.js';

/** Хранилище с одной записью в app_meta (или без неё). */
const storeWith = (value: string | null) =>
  new AutochecksStore({
    query: { appMeta: { findFirst: async () => (value === null ? undefined : { value }) } },
  } as never);

describe('AutochecksStore: запись прежней версии', () => {
  it('нового тумблера в записи нет — он берётся по умолчанию, а свои значения владельца остаются', async () => {
    const { serverChecksEnabled: _new, ...before } = { ...AUTOCHECKS_DEFAULTS, sshIntervalMinutes: 45 };
    expect(await storeWith(JSON.stringify(before)).get()).toEqual({
      ...before,
      serverChecksEnabled: true,
    });
  });

  it('повреждённая запись и её отсутствие — значения по умолчанию', async () => {
    expect(await storeWith('не json').get()).toEqual(AUTOCHECKS_DEFAULTS);
    expect(await storeWith(JSON.stringify({ sshIntervalMinutes: 2 })).get()).toEqual(AUTOCHECKS_DEFAULTS);
    expect(await storeWith(null).get()).toEqual(AUTOCHECKS_DEFAULTS);
  });
});
