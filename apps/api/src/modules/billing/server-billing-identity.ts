import type { BillingKind, Server } from '@nodeservice/shared';

const GENERIC = new Set([
  'аренда',
  'арендодатель',
  'вход',
  'выход',
  'сервер',
  'серверы',
  'хостинг',
  'rent',
  'rental',
  'entry',
  'exit',
  'server',
  'hosting',
  'host',
]);

const words = (value: string): string[] =>
  value
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length >= 2 && !GENERIC.has(word));

const compact = (value: string): string =>
  value
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/[^\p{L}\p{N}]+/gu, '');

/** Имена, по которым непривязанную карточку аренды можно безопасно соотнести с сервером. */
export function serverBillingAliases(
  server: Pick<Server, 'name'> & {
    profile?: { upstream?: Server['profile']['upstream'] };
    upstream?: Server['profile']['upstream'];
  },
): string[] {
  const aliases = [server.name];
  const upstream = server.profile?.upstream ?? server.upstream;
  if (upstream?.kind === 'rent' && upstream.owner?.trim()) aliases.push(upstream.owner.trim());
  return [...new Set(aliases)];
}

/**
 * Аренду разрешено узнавать по имени только когда она ещё не привязана ни к одному серверу. Это покрывает
 * карточки вроде «Guardora» / «Hub Rent», но не приписывает серверу чужую оплату и не путает её с VPS
 * «Польша (Выход Guardora)».
 */
export function billingItemBelongsToServer(input: {
  kind: BillingKind;
  title: string;
  provider: string | null;
  serverIds: string[];
  serverId: string;
  aliases?: readonly string[];
}): boolean {
  if (input.serverIds.includes(input.serverId)) return true;
  if (input.kind !== 'rent' || input.serverIds.length > 0) return false;

  const itemWords = words([input.title, input.provider ?? ''].join(' '));
  if (itemWords.length === 0) return false;
  const itemSet = new Set(itemWords);
  const itemCompact = compact([input.title, input.provider ?? ''].join(' '));

  return (input.aliases ?? []).some((alias) => {
    const aliasWords = words(alias);
    if (aliasWords.length === 0) return false;
    const exactWords = aliasWords.every((word) => itemSet.has(word));
    const aliasCompact = aliasWords.join('');
    return exactWords || (aliasCompact.length >= 4 && itemCompact.includes(aliasCompact));
  });
}
