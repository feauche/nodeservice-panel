import { describe, expect, it } from 'vitest';

import {
  agentEnrollResponseSchema,
  agentPulseRequestSchema,
  agentPulseSigningText,
  agentWelcomeSchema,
} from './agent-protocol.js';

const ID = '0192c000-0000-7000-8000-000000000001';

describe('протокол агента: резервные маршруты и HTTPS pulse', () => {
  it('старый ответ с одним wsUrl остаётся допустимым, новый принимает список', () => {
    expect(
      agentEnrollResponseSchema.parse({ serverId: ID, serverName: 'kz-1', wsUrl: 'wss://panel.test/ws' })
        .wsUrls,
    ).toBeUndefined();
    expect(
      agentWelcomeSchema.parse({
        serverName: 'kz-1',
        heartbeatSeconds: 10,
        metricsSeconds: 10,
        wsUrls: ['wss://one.test/ws', 'wss://two.test/ws'],
      }).wsUrls,
    ).toHaveLength(2);
  });

  it('подписываемый текст включает payload без повторной сериализации', () => {
    const req = agentPulseRequestSchema.parse({
      v: 1,
      serverId: ID,
      version: 'v0.7.0',
      id: '0192c000-0000-7000-8000-000000000002',
      ts: '2026-10-02T07:00:00.000Z',
      payload: '{"metrics":{"cpuPct":1}}',
      signature: `${'A'.repeat(86)}==`,
    });
    expect(agentPulseSigningText(req)).toBe(
      'nodeservice-agent-pulse-v1\n0192c000-0000-7000-8000-000000000001\nv0.7.0\n0192c000-0000-7000-8000-000000000002\n2026-10-02T07:00:00.000Z\n{"metrics":{"cpuPct":1}}',
    );
  });
});
