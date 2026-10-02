import type { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.schema.js';

const toWs = (base: string) =>
  `${base
    .replace(/\/+$/, '')
    .replace(/^http:/i, 'ws:')
    .replace(/^https:/i, 'wss:')}/api/agent/v1/ws`;

/** Основной вход, независимые запасные входы и обычный адрес панели, без повторов. */
export function configuredAgentBaseUrls(config: ConfigService<Env, true>): string[] {
  return [
    config.get('AGENT_PUBLIC_URL'),
    ...(config.get('AGENT_FALLBACK_URLS') ?? []),
    config.get('PUBLIC_URL'),
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.replace(/\/+$/, ''))
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 5);
}

export function configuredAgentWsUrls(config: ConfigService<Env, true>): string[] {
  return configuredAgentBaseUrls(config).map(toWs);
}
