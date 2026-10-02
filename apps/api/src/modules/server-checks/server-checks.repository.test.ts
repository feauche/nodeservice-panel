import type { BlockCheckResult } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import type { ServerCheckRow } from '../../infra/db/schema/index.js';
import { toCheckRun } from './server-checks.repository.js';

const result: BlockCheckResult = {
  nodeName: 'Нидерланды - 1',
  address: '1.2.3.4',
  sniUsed: 'mask.example',
  probes: [],
  foreign: [],
  verdict: 'unreachable',
  unchecked: 'no_probers',
  foreignUnchecked: null,
  entry: null,
};

function row(output: string): ServerCheckRow {
  return {
    id: '0192c000-cccc-7000-8000-000000000001',
    serverId: '0192c000-cccc-7000-8000-000000000002',
    check: 'russia_access',
    status: 'ok',
    trigger: 'manual',
    actorDisplay: 'admin',
    startedAt: new Date('2026-10-02T12:00:00Z'),
    finishedAt: new Date('2026-10-02T12:01:00Z'),
    output,
    error: null,
    explanation: null,
  };
}

describe('сохранённый результат доступности из России', () => {
  it('возвращается клиенту структурированным объектом', () => {
    expect(toCheckRun(row(JSON.stringify(result))).blockResult).toEqual(result);
  });

  it('повреждённый старый вывод не роняет список проверок', () => {
    expect(toCheckRun(row('{')).blockResult).toBeNull();
  });
});
