import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IncidentSshRecheckJob } from '../src/modules/incidents/incident-ssh-recheck.job.js';
import { NodeAnomalyJob } from '../src/modules/incidents/node-anomaly.job.js';
import { NodeBlockRecheckJob } from '../src/modules/incidents/node-block-recheck.job.js';
import { currentIncidentApp } from './current-incidents.fixture.js';

describe('отключённые SSH/агентские incident schedulers (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof currentIncidentApp>>;
  beforeAll(async () => {
    ctx = await currentIncidentApp();
  });
  afterAll(async () => {
    await ctx?.app.close();
  });
  it('ни один прежний scheduler не зарегистрирован даже при открытом node-инциденте', async () => {
    const row = await ctx.seed();
    for (const provider of [IncidentSshRecheckJob, NodeAnomalyJob, NodeBlockRecheckJob])
      expect(() => ctx.app.get(provider)).toThrow();
    expect((await ctx.agent.get(`/api/incidents/${row.id}`).expect(200)).body.id).toBe(row.id);
    expect(ctx.ssh.connect).not.toHaveBeenCalled();
  });
});
