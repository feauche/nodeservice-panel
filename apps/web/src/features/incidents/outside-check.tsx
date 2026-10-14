import type { Incident, RemnawaveNode } from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';
import { ExternalLinkIcon, PlugIcon, RadarIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useIntegrationsStatus } from '@/features/integrations/integrations-status';
import { primaryConnection, useNodeConnections } from '@/features/nodes/node-connections';
import { Pill } from '@/features/settings/settings-ui';
import { plural } from '@/lib/plural';
import { cn } from '@/lib/utils';
import { RECOVERY_KINDS } from './incident-recovery';

/** Кнопка строки проверки: на телефоне — во всю ширину. */
const OPEN =
  'inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border border-border bg-surface px-3.5 text-[12.5px] font-medium whitespace-nowrap text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground max-sm:w-full';

/** Карточка нужна у событий о доступности ноды, пока они не закрыты: после закрытия проверять уже нечего. */
export const showsOutsideCheck = (inc: Incident): boolean =>
  RECOVERY_KINDS.includes(inc.kind) && inc.status !== 'resolved';

function Row({
  icon,
  title,
  forNode,
  children,
  action,
}: {
  icon: string;
  title: string;
  forNode: boolean;
  children: ReactNode;
  action: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[38px_minmax(0,1fr)_auto] items-center gap-3 border-t border-border px-4 py-3 first:border-t-0 max-sm:grid-cols-[38px_minmax(0,1fr)] max-sm:gap-y-2.5">
      <span className="grid size-[38px] place-items-center rounded-[10px] border border-border bg-surface-2">
        <img src={icon} alt="" className="size-5 rounded-[5px]" />
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <b className="text-[13.5px] font-semibold">{title}</b>
          {forNode && <Pill tone="ok">для этой ноды</Pill>}
        </div>
        <p className="mt-0.5 text-[12px] leading-snug text-text-3">{children}</p>
      </div>
      <span className="max-sm:col-span-2">{action}</span>
    </li>
  );
}

/**
 * «Проверить снаружи» на странице события (витрина bs-dns-2026-10, вариант A): BS Checker с портом и SNI подключения
 * ноды и DPI Checker по её адресу. Проверка откроется уже заполненной; деньги тратятся только по кнопке «Запустить»
 * в самом сервисе. Для сервера белого списка первым стоит BS Checker, для обычной ноды — DPI Checker.
 */
export function OutsideCheckCard({ node }: { node: RemnawaveNode }) {
  const connections = useNodeConnections(node.uuid);
  const integrations = useIntegrationsStatus();
  const conn = primaryConnection(connections.data);
  const port = conn?.port ?? node.port ?? null;
  const sni = conn?.names[0];
  const more = Math.max(0, (connections.data?.items.length ?? 0) - 1);
  const state = (provider: 'bschecker' | 'dpi') => {
    const item = integrations.data?.items.find((i) => i.provider === provider);
    return { known: Boolean(integrations.data), off: Boolean(integrations.data) && !item?.connected };
  };
  const bsState = state('bschecker');
  const dpiState = state('dpi');

  const bs = (
    <Row
      key="bs"
      icon="/integration-icons/bschecker.svg"
      title="BS Checker · мобильные операторы"
      forNode={Boolean(node.whitelist)}
      action={
        <Link
          to="/integrations/bschecker"
          search={bsState.off ? {} : { node: node.uuid, ...(port ? { port } : {}), ...(sni ? { sni } : {}) }}
          className={OPEN}
        >
          {bsState.off ? (
            <PlugIcon className="size-3.5" aria-hidden="true" />
          ) : (
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          )}
          {bsState.off ? 'Подключить' : 'Открыть проверку'}
        </Link>
      }
    >
      Проходит ли нода белые списки мобильных операторов:{' '}
      <span className="font-mono text-[11.5px]">
        {node.address}
        {port ? `:${port}` : ''}
      </span>
      {sni && (
        <>
          , SNI <span className="font-mono text-[11.5px]">{sni}</span>
        </>
      )}
      {more > 0 && ` и ещё ${more} ${plural(more, 'подключение', 'подключения', 'подключений')} ноды`}.{' '}
      {bsState.off
        ? 'BS Checker не подключён — откроется его раздел, там «Подключение».'
        : 'Цена видна до запуска.'}
    </Row>
  );
  const dpi = (
    <Row
      key="dpi"
      icon="/integration-icons/dpi.ico"
      title="DPI Checker · провайдеры РФ"
      forNode={!node.whitelist}
      action={
        <Link to="/integrations/dpi" search={dpiState.off ? {} : { node: node.uuid }} className={OPEN}>
          {dpiState.off ? (
            <PlugIcon className="size-3.5" aria-hidden="true" />
          ) : (
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          )}
          {dpiState.off ? 'Подключить' : 'Открыть проверку'}
        </Link>
      }
    >
      Открывается ли IP <span className="font-mono text-[11.5px]">{node.address}</span> с точек домашних
      провайдеров России — так видна блокировка ТСПУ.{' '}
      {dpiState.off
        ? 'DPI Checker не подключён — откроется его раздел, там «Подключение».'
        : 'Цена — до запуска, в деньгах аккаунта DPI Checker.'}
    </Row>
  );
  return (
    <section aria-label="Проверить снаружи" className="overflow-hidden rounded-[14px] border border-border">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3">
        <RadarIcon className="size-4 text-text-3" aria-hidden="true" />
        <h3 className="font-heading text-[14.5px] font-semibold">Проверить снаружи</h3>
        <span className={cn('text-[12px] text-text-3')}>откроется уже заполненной</span>
      </div>
      <ul>{node.whitelist ? [bs, dpi] : [dpi, bs]}</ul>
    </section>
  );
}
