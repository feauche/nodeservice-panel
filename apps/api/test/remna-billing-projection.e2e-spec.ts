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
const controller = new RemnaBillingProvidersController(
  db,
  { list: async () => remote } as never,
  { credentials: async () => ({ domain, apiKey: 'test' }) } as never,
  assets as never,
  legacy as never,
);
beforeAll(async () => {
  await runMigrations(db);
  await db.execute(sql`truncate providers cascade`);
});
afterAll(() => pool.end());
describe('Remna providers keep stable billing identity', () => {
  it('keeps legacy equal names and coalesces concurrent projection IDs', async () => {
    await db.insert(schema.providers).values({ name: 'Same name', siteUrl: 'https://legacy.example' });
    const [a, b] = await Promise.all([controller.list(), controller.list()]);
    const rows = await db.select().from(schema.providers);
    expect(rows).toHaveLength(2);
    const local = rows.find((p) => p.remoteUuid === uuid);
    if (!local) throw new Error('missing projection');
    expect(local.id).not.toBe(uuid);
    expect(a.items.some((p) => p.id === local.id)).toBe(true);
    expect(b.items.some((p) => p.id === local.id)).toBe(true);
    const repo = new ProvidersRepository(db);
    expect(await repo.findById(local.id)).toBeUndefined();
    expect((await repo.list()).map((p) => p.remotePanel)).toEqual([null]);
  });
  it('keeps historical FK/name on deletion and separates another panel with the same remote UUID', async () => {
    const [local] = await db.select().from(schema.providers).where(eq(schema.providers.remoteUuid, uuid));
    await db.insert(schema.billingItems).values({
      kind: 'other',
      title: 'Historical',
      providerId: local.id,
      amountMinor: 100,
      currency: 'RUB',
      periodUnit: 'month',
      periodCount: 1,
      paidUntil: new Date(),
    });
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
    const [bill] = await db.select().from(schema.billingItems);
    expect(bill.providerId).toBe(local.id);
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
