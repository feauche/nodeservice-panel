import {
  CSRF_HEADER,
  incidentSchema,
  incidentsListResponseSchema,
  incidentWeekStatsSchema,
} from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IncidentRunnerService } from '../src/modules/incidents/incident-runner.service.js';
import { currentIncidentApp } from './current-incidents.fixture.js';

describe('инциденты нод и сохранность прежней истории (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof currentIncidentApp>>;
  beforeAll(async () => {
    ctx = await currentIncidentApp();
  });
  afterAll(async () => {
    await ctx?.app.close();
  });
  beforeEach(async () => {
    await ctx.db.execute(sql`truncate incidents cascade`);
  });
  const list = async (status = 'all') =>
    incidentsListResponseSchema.parse(
      (await ctx.agent.get(`/api/incidents?status=${status}`).expect(200)).body,
    );
  it('список и detail читают nodeUuid, diagnostics и хронологию без локального SSH сервера', async () => {
    const row = await ctx.seed();
    const report = {
      source: 'checkhost' as const,
      report: {
        verdict: 'unknown' as const,
        checkedAt: new Date().toISOString(),
        target: '198.51.100.9:5492',
        link: null,
        observations: [],
        error: null,
      },
    };
    await ctx.repo.update(row.id, { diagnostics: report });
    const detail = incidentSchema.parse((await ctx.agent.get(`/api/incidents/${row.id}`).expect(200)).body);
    expect(detail).toMatchObject({ nodeUuid: row.nodeUuid, diagnostics: report, serverId: null });
    expect((await list()).items[0]?.id).toBe(row.id);
  });
  it('acknowledge и ручное resolve идемпотентны, добавляют хронологию и Журнал', async () => {
    const row = await ctx.seed();
    const post = (action: string) =>
      ctx.agent.post(`/api/incidents/${row.id}/${action}`).set(CSRF_HEADER, ctx.csrf).send({}).expect(200);
    const first = incidentSchema.parse((await post('acknowledge')).body);
    expect(first.status).toBe('acknowledged');
    expect((await post('acknowledge')).body.timeline).toHaveLength(first.timeline.length);
    const resolved = incidentSchema.parse((await post('resolve')).body);
    expect(resolved).toMatchObject({ status: 'resolved', resolvedBy: 'manual', proposal: null });
    expect((await post('resolve')).body.timeline).toHaveLength(resolved.timeline.length);
    expect((await list('open')).items).toHaveLength(0);
    expect((await list('resolved')).items).toHaveLength(1);
    const audit = await ctx.agent.get(`/api/audit?targetId=${row.id}`).expect(200);
    expect(audit.body.items.map((entry: { action: string }) => entry.action)).toEqual(
      expect.arrayContaining(['incident.acknowledged', 'incident.resolved']),
    );
  });
  it('удаление решённых сохраняет открытые; одиночное удаление даёт404 при повторном чтении', async () => {
    const resolved = await ctx.seed(),
      open = await ctx.seed();
    await ctx.repo.update(resolved.id, { status: 'resolved', resolvedBy: 'manual', resolvedAt: new Date() });
    expect(
      (await ctx.agent.delete('/api/incidents/resolved').set(CSRF_HEADER, ctx.csrf).expect(200)).body,
    ).toEqual({ deleted: 1 });
    expect((await list()).items.map((row) => row.id)).toEqual([open.id]);
    await ctx.agent.delete(`/api/incidents/${open.id}`).set(CSRF_HEADER, ctx.csrf).expect(204);
    await ctx.agent.get(`/api/incidents/${open.id}`).expect(404);
  });
  it('старые attempts/logs сохраняются, running закрываются без выполнения SSH', async () => {
    const row = await ctx.seed();
    await ctx.repo.update(row.id, {
      attempts: [
        {
          id: 'legacy-attempt',
          action: 'restart_node',
          level: 'T2',
          by: 'auto',
          status: 'running',
          startedAt: new Date().toISOString(),
          finishedAt: null,
          steps: [],
          log: 'Исторический лог',
        },
      ],
    });
    await ctx.app.get(IncidentRunnerService).onModuleInit();
    const detail = incidentSchema.parse((await ctx.agent.get(`/api/incidents/${row.id}`).expect(200)).body);
    expect(detail.attempts[0]).toMatchObject({
      id: 'legacy-attempt',
      status: 'failed',
      log: 'Исторический лог',
    });
    expect(detail.attempts[0]?.finishedAt).not.toBeNull();
    expect(detail.timeline.at(-1)?.action).toContain('Автопочинка удалена');
  });
  it('старые action/policy/settings HTTP пути отсутствуют, compatibility runner отклоняет исполнение410', async () => {
    const row = await ctx.seed();
    for (const route of [`/api/incidents/${row.id}/actions`, '/api/incidents/policy'])
      await ctx.agent.post(route).set(CSRF_HEADER, ctx.csrf).send({ action: 'restart_node' }).expect(404);
    await ctx.agent
      .put('/api/settings/incidents')
      .set(CSRF_HEADER, ctx.csrf)
      .send({ autofixEnabled: true })
      .expect(404);
    await expect(
      ctx.app.get(IncidentRunnerService).start(row.id, 'restart_node', 'manual'),
    ).rejects.toMatchObject({ status: 410 });
  });
  it('постраничная история и статистика недели остаются доступными', async () => {
    for (let i = 0; i < 11; i++) await ctx.seed();
    const page = incidentsListResponseSchema.parse(
      (await ctx.agent.get('/api/incidents?status=all&page=2&pageSize=10').expect(200)).body,
    );
    expect(page).toMatchObject({ total: 11, page: 2, totalPages: 2 });
    expect(page.items).toHaveLength(1);
    const week = incidentWeekStatsSchema.parse(
      (await ctx.agent.get('/api/incidents/week-stats').expect(200)).body,
    );
    expect(week.total).toBe(11);
  });
});
