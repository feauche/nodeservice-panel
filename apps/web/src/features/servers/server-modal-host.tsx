import { useEffect } from 'react';

import { ServerModal } from './server-modal';
import { useServerModalStore } from './server-modal-store';
import { useServers } from './servers-api';

/**
 * Хозяин карточки сервера: монтируется в AppShell, поэтому карточка открывается с любой страницы.
 * Список серверов читаем только пока карточка открыта.
 */
export function ServerModalHost() {
  const serverId = useServerModalStore((st) => st.serverId);
  return serverId ? <OpenServerModal id={serverId} /> : null;
}

function OpenServerModal({ id }: { id: string }) {
  const tab = useServerModalStore((st) => st.tab);
  const close = useServerModalStore((st) => st.close);
  const servers = useServers();
  const server = servers.data?.items.find((s) => s.id === id) ?? null;
  // Сервера уже нет (удалён, устаревшая ссылка) — закрываем, а не держим пустую рамку.
  useEffect(() => {
    if (servers.isSuccess && !server) close();
  }, [servers.isSuccess, server, close]);
  return <ServerModal server={server} initialTab={tab} onClose={close} />;
}
