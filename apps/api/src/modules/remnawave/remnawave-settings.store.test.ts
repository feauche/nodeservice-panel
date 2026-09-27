import { describe, expect, it } from 'vitest';

import { RemnawaveSettingsStore } from './remnawave-settings.store.js';

function make() {
  let row: { key: string; value: string } | undefined;
  const db = {
    query: { appMeta: { findFirst: async () => row } },
    insert: () => ({
      values: (v: { key: string; value: string }) => ({
        onConflictDoUpdate: async () => {
          row = v;
        },
      }),
    }),
    delete: () => ({
      where: async () => {
        row = undefined;
      },
    }),
  };
  const crypto = {
    encrypt: (s: string) => `enc:${s}`,
    decrypt: (s: string) => s.replace(/^enc:/, ''),
  };
  return new RemnawaveSettingsStore(db as never, crypto as never);
}

const SNAP = { checkedAt: '2026-09-27T10:00:00.000Z', error: null, stats: null, nodes: [], cert: null };

describe('RemnawaveSettingsStore', () => {
  it('пусто, пока не подключено', async () => {
    const s = make();
    expect(await s.domain()).toBeNull();
    expect(await s.credentials()).toBeNull();
    expect(await s.snapshot()).toBeNull();
  });

  it('connect сохраняет домен и шифрует токен; credentials расшифровывает обратно', async () => {
    const s = make();
    await s.connect('vpn-panel.example.com', 'rw_pat_x', SNAP);
    expect(await s.domain()).toBe('vpn-panel.example.com');
    expect(await s.credentials()).toEqual({ domain: 'vpn-panel.example.com', apiKey: 'rw_pat_x' });
    expect(await s.snapshot()).toEqual(SNAP);
  });

  it('updateSnapshot без подключения ничего не создаёт', async () => {
    const s = make();
    await s.updateSnapshot(SNAP);
    expect(await s.snapshot()).toBeNull();
  });

  it('updateSnapshot после подключения меняет только снимок, домен и токен остаются', async () => {
    const s = make();
    await s.connect('x.example.com', 'k1', SNAP);
    const next = { ...SNAP, error: 'упало' };
    await s.updateSnapshot(next);
    expect(await s.snapshot()).toEqual(next);
    expect(await s.credentials()).toEqual({ domain: 'x.example.com', apiKey: 'k1' });
  });

  it('disconnect стирает всё', async () => {
    const s = make();
    await s.connect('x.example.com', 'k1', SNAP);
    await s.disconnect();
    expect(await s.domain()).toBeNull();
    expect(await s.snapshot()).toBeNull();
  });

  it('битая расшифровка — credentials честно null, а не падение', async () => {
    let row: { key: string; value: string } | undefined;
    const db = {
      query: { appMeta: { findFirst: async () => row } },
      insert: () => ({
        values: (v: { key: string; value: string }) => ({
          onConflictDoUpdate: async () => {
            row = v;
          },
        }),
      }),
    };
    const good = new RemnawaveSettingsStore(db as never, { encrypt: (x: string) => `enc:${x}` } as never);
    await good.connect('x.example.com', 'k1', SNAP);
    const broken = new RemnawaveSettingsStore(
      db as never,
      {
        decrypt: () => {
          throw new Error('bad key');
        },
      } as never,
    );
    expect(await broken.credentials()).toBeNull();
  });
});
