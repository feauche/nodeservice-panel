import type { RemnawaveNode, Server } from '@nodeservice/shared';

/**
 * Нода Remnawave этого сервера. Связь считает панель на сервере (по адресу, по IP, на который указывает домен,
 * или по выбору в профиле сервера) и отдаёт её вместе с нодами — веб адреса сам не сверяет.
 */
export function nodeOfServer(
  nodes: readonly RemnawaveNode[] | undefined,
  server: Pick<Server, 'id'>,
): RemnawaveNode | undefined {
  return nodes?.find((n) => n.serverIds?.includes(server.id));
}
