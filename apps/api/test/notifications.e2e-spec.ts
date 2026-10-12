import { CSRF_HEADER } from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotificationsService } from '../src/modules/notifications/notifications.service.js';
import { currentIncidentApp } from './current-incidents.fixture.js';

describe('удалённый колокольчик и сохранность истории уведомлений (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof currentIncidentApp>>;
  beforeAll(async () => {
    ctx = await currentIncidentApp();
    await ctx.db.execute(sql`truncate notifications cascade`);
  });
  afterAll(async () => {
    await ctx?.app.close();
  });
  it('старые HTTP пути управления колокольчиком отсутствуют', async () => {
    await ctx.agent.get('/api/notifications').expect(404);
    await ctx.agent
      .post('/api/notifications')
      .set(CSRF_HEADER, ctx.csrf)
      .send({ severity: 'warn', title: 'Не должно сохраниться' })
      .expect(404);
    await ctx.agent.post('/api/notifications/read-all').set(CSRF_HEADER, ctx.csrf).send({}).expect(404);
    await ctx.agent.delete('/api/notifications').set(CSRF_HEADER, ctx.csrf).expect(404);
    expect((await ctx.db.execute(sql`select id from notifications`)).rows).toEqual([]);
  });
  it('внутренняя история server push сохраняется, но колокольчик по HTTP не возвращается', async () => {
    await ctx.db.execute(
      sql`insert into notifications (title, severity) values ('Историческое уведомление', 'warn')`,
    );
    await ctx.app
      .get(NotificationsService)
      .push({ severity: 'crit', title: 'Только действующая доставка', center: true });
    const rows = await ctx.db.execute<{ title: string }>(
      sql`select title from notifications order by created_at, id`,
    );
    expect(rows.rows).toEqual([
      { title: 'Историческое уведомление' },
      { title: 'Только действующая доставка' },
    ]);
    await ctx.agent.get('/api/notifications').expect(404);
  });
});
