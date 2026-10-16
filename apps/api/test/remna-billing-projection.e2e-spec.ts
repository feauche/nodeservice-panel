import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/infra/db/migrate.js';
import * as schema from '../src/infra/db/schema/index.js';
import { ProvidersRepository } from '../src/modules/providers/providers.repository.js';
import { RemnaBillingProvidersController } from '../src/modules/remnawave/remna-billing-providers.controller.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test')) throw new Error('test DB only');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema, casing: 'snake_case' });
const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let domain = 'one.example';
let remote = [
  { uuid, name: 'Same name', loginUrl: 'https://provider.example', faviconLink: null, nodes: [] },
];
const assets = {
  dto: async (p: (typeof remote)[number]) => ({
    id: p.uuid,
    name: p.name,
    siteUrl: p.loginUrl,
    nodesCount: 0,
  }),
  icon: async () => null,
};
const legacy = {
  toDto: (p: typeof schema.providers.$inferSelect) => ({ id: p.id, name: p.name, siteUrl: p.siteUrl }),
};
const audit = { record: vi.fn(async () => null) };
const controller = new RemnaBillingProvidersController(
  db,
  { list: async () => remote } as never,
  { credentials: async () => ({ domain, apiKey: 'test' }) } as never,
  assets as never,
  legacy as never,
  audit as never,
);
const bill = (title: string, providerId: string) => ({
  kind: 'other' as const,
  title,
  providerId,
  amountMinor: 100,
  currency: 'RUB',
  periodUnit: 'month' as const,
  periodCount: 1,
  paidUntil: new Date(),
});
beforeAll(async () => {
  await runMigrations(db);
  await db.execute(sql`truncate providers cascade`);
});
afterAll(() => pool.end());
describe('Remna providers keep stable billing identity', () => {
  it('removes the old panel directory: twins merge into Remnawave, payments move, the rest leaves the picker', async () => {
    // До связи с Remnawave провайдеры жили в справочнике панели; те же хостеры есть в Remnawave, часто
    // под чуть другим именем — в «Новой оплате» было по два пункта.
    const space = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const legacy = await db
      .insert(schema.providers)
      .values([
        { name: 'same NAME ', siteUrl: 'https://legacy.example' },
        { name: 'Space Core', siteUrl: 'https://billing.spacecore.example' },
        { name: 'Old brand', siteUrl: 'https://my.provider.example' },
        { name: 'Only in panel', siteUrl: 'https://alone.example' },
        { name: 'Unused', siteUrl: 'https://unused.example' },
      ])
      .returning();
    const id = (name: string) => legacy.find((p) => p.name === name)?.id ?? '';
    await db
      .insert(schema.billingItems)
      .values([
        bill('Old payment', id('same NAME ')),
        bill('Space payment', id('Space Core')),
        bill('Brand payment', id('Old brand')),
        bill('Registrar', id('Only in panel')),
      ]);
    const before = remote;
    remote = [
      ...before,
      { uuid: space, name: 'SpaceCore', loginUrl: 'https://spacecore.example', faviconLink: null, nodes: [] },
    ] as typeof remote;
    const [a, b] = await Promise.all([controller.list(), controller.list()]);
    const rows = await db.select().from(schema.providers);
    const local = rows.find((p) => p.remoteUuid === uuid);
    const spaceRow = rows.find((p) => p.remoteUuid === space);
    if (!local || !spaceRow) throw new Error('missing projection');
    expect(local.id).not.toBe(uuid);
    for (const r of [a, b]) {
      // Выбрать можно только провайдеров Remnawave; старый с оплатой виден лишь в самой оплате.
      expect(r.items.filter((p) => p.selectable !== false).map((p) => p.id)).toEqual(
        expect.arrayContaining([local.id, spaceRow.id]),
      );
      expect(r.items.filter((p) => p.selectable !== false)).toHaveLength(2);
      expect(r.items.find((p) => p.id === id('Only in panel'))).toMatchObject({ selectable: false });
    }
    const payments = await db.select().from(schema.billingItems);
    const providerOf = (title: string) => payments.find((x) => x.title === title)?.providerId;
    expect(providerOf('Old payment')).toBe(local.id);
    expect(providerOf('Brand payment')).toBe(local.id);
    expect(providerOf('Space payment')).toBe(spaceRow.id);
    expect(providerOf('Registrar')).toBe(id('Only in panel'));
    const left = rows.filter((p) => p.remotePanel === null);
    expect(left.map((p) => p.name)).toEqual(['Only in panel']);
    expect(left[0].archivedAt).not.toBeNull();
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'provider.legacy_removed',
        metadata: {
          removedProviders: 4,
          mergedProviders: 'Old brand → Same name, same NAME → Same name, Space Core → SpaceCore',
          movedPayments: 3,
          keptForHistory: 'Only in panel',
        },
      }),
    );
    const repo = new ProvidersRepository(db);
    expect(await repo.findById(local.id)).toBeUndefined();
    expect(await repo.list()).toEqual([]);
    remote = before;
  });
  it('an old provider with two same-named Remnawave twins keeps its payment and leaves the picker', async () => {
    const [old] = await db
      .insert(schema.providers)
      .values({ name: 'Twice', siteUrl: 'https://twice.example' })
      .returning();
    await db.insert(schema.billingItems).values(bill('Twice payment', old.id));
    const before = remote;
    const twin = (u: string) => ({ uuid: u, name: 'Twice', loginUrl: null, faviconLink: null, nodes: [] });
    remote = [
      ...before,
      twin('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
      twin('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
    ] as typeof remote;
    const res = await controller.list();
    expect(res.items.find((p) => p.id === old.id)).toMatchObject({ selectable: false });
    const [pay] = await db
      .select()
      .from(schema.billingItems)
      .where(eq(schema.billingItems.title, 'Twice payment'));
    expect(pay.providerId).toBe(old.id);
    remote = before;
    await controller.list();
  });
  it('keeps historical FK/name on deletion and separates another panel with the same remote UUID', async () => {
    const [local] = await db.select().from(schema.providers).where(eq(schema.providers.remoteUuid, uuid));
    await db.insert(schema.billingItems).values(bill('Historical', local.id));
    remote = [];
    const deleted = await controller.list();
    expect(deleted.items.find((p) => p.id === local.id)).toMatchObject({
      name: 'Same name',
      selectable: false,
    });
    domain = 'two.example';
    remote = [{ uuid, name: 'Other panel', loginUrl: 'https://other.example', faviconLink: null, nodes: [] }];
    const changed = await controller.list();
    expect(changed.items.find((p) => p.id === local.id)).toMatchObject({
      name: 'Same name',
      selectable: false,
    });
    const rows = await db.select().from(schema.providers).where(eq(schema.providers.remoteUuid, uuid));
    expect(rows).toHaveLength(2);
    expect(rows[0].id).not.toBe(rows[1].id);
    const [historical] = await db
      .select()
      .from(schema.billingItems)
      .where(eq(schema.billingItems.title, 'Historical'));
    expect(historical.providerId).toBe(local.id);
  });
});

describe('billing projection connection boundaries', () => {
  it('keeps the captured panel when connection changes during the remote read', async () => {
    let current = 'snapshot.example';
    const list = vi.fn(async (_force, credentials) => {
      expect(credentials.domain).toBe('snapshot.example');
      current = 'changed.example';
      return [
        {
          uuid,
          name: 'Snapshot provider',
          loginUrl: 'https://provider.example',
          faviconLink: null,
          nodes: [],
        },
      ];
    });
    const instance = new RemnaBillingProvidersController(
      db,
      { list } as never,
      { credentials: async () => ({ domain: current, apiKey: 'test' }) } as never,
      assets as never,
      legacy as never,
    );
    await instance.list();
    const rows = await db
      .select()
      .from(schema.providers)
      .where(eq(schema.providers.remotePanel, 'snapshot.example'));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Snapshot provider');
  });
  it('reports remote creation as completed when subsequent local icon storage fails', async () => {
    const create = vi.fn(async () => ({
      uuid,
      name: 'Created provider',
      loginUrl: 'https://provider.example',
      faviconLink: null,
      nodes: [],
    }));
    const instance = new RemnaBillingProvidersController(
      db,
      { create } as never,
      { credentials: async () => ({ domain: 'create.example', apiKey: 'test' }) } as never,
      {
        ...assets,
        update: async () => {
          throw new Error('local database unavailable');
        },
      } as never,
      legacy as never,
    );
    await expect(
      instance.create({ name: 'Created provider', siteUrl: 'https://provider.example' }),
    ).rejects.toThrow('уже создан');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][1]).toEqual({ domain: 'create.example', apiKey: 'test' });
  });
});
