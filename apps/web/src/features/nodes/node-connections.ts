import { type NodeConnection, nodeConnectionsSchema } from '@nodeservice/shared';
import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';

/**
 * Подключения ноды из профиля Remnawave: порты и имена SNI. По ним проверка снаружи (BS Checker из формы и из
 * события) подставляет порт и SNI ноды. null вместо uuid — запрос не делается.
 */
export function useNodeConnections(uuid: string | null | undefined) {
  return useQuery({
    queryKey: ['node-connections', uuid],
    queryFn: ({ signal }) => api.get(`/nodes/${uuid}/connections`, nodeConnectionsSchema, signal),
    enabled: Boolean(uuid),
    staleTime: 60_000,
  });
}

/** Подключение, выбранное по умолчанию: основное, иначе первое. */
export function primaryConnection(data: { items: NodeConnection[]; primary: string | null } | undefined) {
  return data?.items.find((c) => c.tag === data.primary) ?? data?.items[0] ?? null;
}

/** «VLESS · Reality · XHTTP»: короткое описание подключения без служебных слов. */
export function connectionKind(c: NodeConnection): string {
  const protocol = c.protocol ? c.protocol.toUpperCase().replace('SHADOWSOCKS', 'Shadowsocks') : null;
  const security =
    c.security && c.security !== 'none' ? c.security.replace(/^./, (x) => x.toUpperCase()) : null;
  const network = c.network && !['raw', 'tcp'].includes(c.network) ? c.network.toUpperCase() : null;
  return [protocol, security, network].filter(Boolean).join(' · ') || 'Подключение';
}
