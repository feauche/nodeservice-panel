import type { RemnawaveTopologyHost } from '@nodeservice/shared';

/**
 * Ключи подписки пользователя Remnawave по Host — для проверки VPN по ключу в DPI Checker (витрина
 * reference-pack-2026-10, раздел 2 — A). Ссылка — та же, что Remnawave отдаёт клиенту; чей это Host — из «сырой»
 * подписки (у каждой записи там номер Host).
 */
export interface SubscriptionEntry {
  hostUuid: string;
  address: string;
  port: number;
  remark: string;
  protocol: string;
  /** Ссылка из подписки; null — Remnawave отдала Host в «сырой» подписке, а ссылку на него не нашли. */
  link: string | null;
}
export type SubscriptionConfig = Omit<SubscriptionEntry, 'link'>;

/** Адрес, порт и имя (после «#») из ссылки подписки; не ссылка — null. */
export function parseLink(link: string) {
  try {
    const url = new URL(link);
    const port = Number(url.port);
    if (!url.hostname || !Number.isInteger(port) || port < 1) return null;
    return {
      protocol: url.protocol.replace(/:$/, ''),
      address: url.hostname.replace(/^\[|\]$/g, '').toLowerCase(),
      port,
      remark: decodeURIComponent(url.hash.replace(/^#/, '')),
    };
  } catch {
    return null;
  }
}

/**
 * Ссылка каждого Host: по адресу, порту и имени; не совпало имя — по адресу и порту, если такая ссылка одна. Одну
 * ссылку два Host не получат.
 */
export function matchLinks(configs: SubscriptionConfig[], links: string[]): SubscriptionEntry[] {
  const parsed = links.map((link) => ({ link, at: parseLink(link) }));
  const used = new Set<number>();
  const same = (c: SubscriptionConfig, p: NonNullable<(typeof parsed)[number]['at']>) =>
    p.protocol === c.protocol && p.address === c.address.toLowerCase() && p.port === c.port;
  const pick = (c: SubscriptionConfig) => {
    const exact = parsed.findIndex(
      (p, i) => !used.has(i) && p.at && same(c, p.at) && p.at.remark === c.remark,
    );
    if (exact >= 0) return exact;
    const loose = parsed.flatMap((p, i) => (!used.has(i) && p.at && same(c, p.at) ? [i] : []));
    return loose.length === 1 ? (loose[0] as number) : -1;
  };
  return configs.map((c) => {
    const i = pick(c);
    if (i >= 0) used.add(i);
    return { ...c, link: i >= 0 ? (parsed[i]?.link ?? null) : null };
  });
}

/** Ключ для показа: идентификатор пользователя скрыт, остальное как есть. */
export function maskKey(link: string) {
  return link.replace(/^(\w+:\/\/)([^@]{0,4})[^@]*?([^@]{4})@/, '$1$2…$3@');
}

export type NodeKey =
  | {
      ok: true;
      host: { uuid: string; name: string; address: string; port: number };
      /** Host общий с другими нодами: подключение по нему может прийти на любую из них. */
      shared: boolean;
      link: string;
    }
  | { ok: false; reason: string };

/**
 * Ключ VLESS для ноды из подписки пользователя: включённый Host ноды с протоколом VLESS, который есть в подписке, —
 * сначала Host только этой ноды, в порядке подписки. Нет — причина словами.
 */
export function nodeKey(
  nodeUuid: string,
  hosts: RemnawaveTopologyHost[],
  entries: SubscriptionEntry[],
  username: string,
): NodeKey {
  const own = hosts.filter((h) => h.nodeUuids.includes(nodeUuid) && (h.protocol ?? 'vless') === 'vless');
  if (!own.length) return { ok: false, reason: 'У ноды нет Host с VLESS в Remnawave.' };
  const enabled = own.filter((h) => !h.disabled);
  if (!enabled.length)
    return { ok: false, reason: 'Host ноды отключены — в подписке их нет. Вставьте ключ вручную.' };
  const inSubscription = (list: RemnawaveTopologyHost[]) => {
    const ids = new Set(list.map((h) => h.id));
    return entries.find((e) => ids.has(e.hostUuid) && e.protocol === 'vless');
  };
  const entry = inSubscription(enabled.filter((h) => h.nodeUuids.length === 1)) ?? inSubscription(enabled);
  if (!entry)
    return {
      ok: false,
      reason: `Host ноды нет в подписке «${username}» — дайте пользователю сквад с этой нодой.`,
    };
  if (!entry.link)
    return {
      ok: false,
      reason: `Remnawave не отдала ключ для Host «${entry.remark}». Вставьте ключ вручную.`,
    };
  const host = enabled.find((h) => h.id === entry.hostUuid);
  return {
    ok: true,
    host: {
      uuid: entry.hostUuid,
      name: host?.name ?? entry.remark,
      address: entry.address,
      port: entry.port,
    },
    shared: (host?.nodeUuids.length ?? 1) > 1,
    link: entry.link,
  };
}
