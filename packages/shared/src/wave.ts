import { countryName } from './countries.js';
import type { IncidentKind } from './incidents.js';
import type { RemnawaveNode } from './remnawave.js';

/**
 * Волна (0.106.0, Н3): за короткое время упали сразу несколько нод одного провайдера. Обычно это сбой у провайдера,
 * а не у самих нод: панель собирает их в одно событие и присылает одно сообщение вместо нескольких.
 */
export const WAVE_EXPLAIN =
  'Волна — когда за короткое время падают сразу несколько нод одного провайдера. Обычно это сбой у провайдера, а не у самих нод. Панель собирает их в одно событие и присылает одно сообщение вместо нескольких.';

/** Какие события нод собираются в волну: потеря связи, падение онлайна, недоступный порт. Нагрузка — нет. */
export const WAVE_KINDS: readonly IncidentKind[] = ['node_down', 'node_blocked', 'server_down'];

export type WaveGroup = { key: string; label: string; cause: 'provider' | 'country' };

/**
 * Группа ноды для волны: провайдер из Remnawave, а у ноды без провайдера — страна. Без того и другого нода в волны
 * не попадает.
 */
export function waveGroupOf(
  node: Pick<RemnawaveNode, 'providerUuid' | 'providerName' | 'countryCode'>,
): WaveGroup | null {
  if (node.providerUuid)
    return {
      key: `provider:${node.providerUuid}`,
      label: node.providerName || 'Провайдер',
      cause: 'provider',
    };
  if (node.countryCode)
    return { key: `country:${node.countryCode}`, label: countryName(node.countryCode), cause: 'country' };
  return null;
}
