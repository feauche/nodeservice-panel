import type { OverviewServerMetrics, RemnawaveServerReadiness, Server } from '@nodeservice/shared';
import { ChevronRightIcon } from 'lucide-react';
import { useState } from 'react';
import { formatPct } from '@/features/overview/overview-format';
import { ProviderIcon } from '@/features/providers/provider-icon';
import { useProviders } from '@/features/providers/providers-api';
import { cn } from '@/lib/utils';
import { HealthDot } from './server-card';
import { CPU_WARN_PCT, DISK_WARN_PCT, MEM_WARN_PCT, type ServerHealth, serverState } from './server-health';
import { CountryMark, RoleMark } from './server-marks';

export type ServersView = 'cards' | 'list';

const VIEW_KEY = 'ns-servers-view';

function readView(): ServersView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'cards';
  } catch {
    return 'cards';
  }
}

/** Вид страницы «Серверы»: запоминается в браузере, поэтому переживает перезагрузку и обновление панели. */
export function useServersView(): [ServersView, (v: ServersView) => void] {
  const [view, setView] = useState<ServersView>(readView);
  const set = (v: ServersView) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* нет хранилища — вид просто не запомнится */
    }
  };
  return [view, set];
}

const COLS =
  'grid grid-cols-[10px_minmax(0,1fr)_20px] items-center gap-x-3 md:grid-cols-[10px_minmax(0,1.4fr)_minmax(0,1fr)_56px_56px_56px_minmax(0,140px)_20px] xl:grid-cols-[10px_minmax(0,1.4fr)_minmax(0,1fr)_76px_56px_56px_56px_minmax(0,140px)_20px]';

const TONE: Record<ServerHealth, string> = { ok: 'text-text-3', warn: 'text-warn', crit: 'text-crit' };

function Pct({ value, warn, offline }: { value: number | null | undefined; warn: number; offline: boolean }) {
  if (offline || value === null || value === undefined)
    return <span className="text-right text-text-3 max-md:hidden">—</span>;
  return (
    <span
      className={cn(
        'text-right tabular-nums max-md:hidden',
        value >= warn ? 'font-semibold text-warn' : 'text-text-2',
      )}
    >
      {formatPct(value)}%
    </span>
  );
}

/**
 * Компактный вид парка (выбор владельца 28.09.2026, витрина `fleet-scale-variants.html`): одна строка
 * на сервер — состояние, имя, что не так, CPU/память/диск, провайдер. Клик открывает ту же карточку.
 * Порядок — тот же, что у карточек (ручной); перетаскивание — только в виде «Карточки».
 */
export function ServerList({
  servers,
  metricsById,
  readinessById,
  onOpen,
}: {
  servers: Server[];
  metricsById: Map<string, OverviewServerMetrics>;
  readinessById?: Map<string, RemnawaveServerReadiness>;
  onOpen: (server: Server) => void;
}) {
  const providers = useProviders();
  const providerOf = (s: Server) =>
    s.providerId ? (providers.data?.items.find((p) => p.id === s.providerId) ?? null) : null;
  return (
    <div data-testid="servers-list" className="overflow-hidden rounded-2xl border border-border bg-surface">
      <div
        aria-hidden="true"
        className={cn(
          COLS,
          'border-b border-border bg-bg-2 px-4 py-2 text-[10.5px] font-semibold tracking-[0.06em] text-text-3 uppercase max-md:hidden',
        )}
      >
        <span />
        <span>Сервер</span>
        <span>Состояние</span>
        <span className="max-xl:hidden">Агент</span>
        <span className="text-right">CPU</span>
        <span className="text-right">RAM</span>
        <span className="text-right">Диск</span>
        <span className="pl-3">Провайдер</span>
        <span />
      </div>
      <ul className="m-0 list-none p-0">
        {servers.map((s) => {
          const m = metricsById.get(s.id) ?? null;
          // Что не так — из того же правила, что цвет точки: колонка «Состояние» не спорит с точкой,
          // и остановленная нода видна здесь так же, как пилюлей на карточке.
          const { health, reason: problem } = serverState(s, m, readinessById?.get(s.id));
          // Метрики шлёт агент: нет его на связи — цифр нет. SSH и нода их не гасят.
          const offline = s.agentStatus !== 'online';
          const agentVersion = s.agentVersion
            ? s.agentVersion.startsWith('v')
              ? s.agentVersion
              : `v${s.agentVersion}`
            : '—';
          const provider = providerOf(s);
          return (
            <li key={s.id} className="border-t border-border first:border-t-0">
              {/* biome-ignore lint/a11y/useSemanticElements: строка содержит отдельную кнопку страны; вложенные button недопустимы */}
              <div
                role="button"
                tabIndex={0}
                data-testid="server-row"
                onClick={() => onOpen(s)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  onOpen(s);
                }}
                className={cn(
                  COLS,
                  'w-full cursor-pointer px-4 py-2.5 text-left text-[12.5px] transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand',
                )}
              >
                <HealthDot health={health} />
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-heading text-[13.5px] font-semibold">{s.name}</span>
                    <RoleMark server={s} />
                    <CountryMark server={s} />
                  </span>
                  <span className="block truncate font-mono text-[11px] text-text-3">{s.host}</span>
                  <span className="block truncate font-mono text-[10.5px] text-text-3 xl:hidden">
                    Агент {agentVersion}
                  </span>
                  {problem && (
                    <span className={cn('block truncate text-[11.5px] md:hidden', TONE[health])}>
                      {problem}
                    </span>
                  )}
                </span>
                <span className={cn('truncate max-md:hidden', TONE[health])} title={problem ?? undefined}>
                  {problem ?? '—'}
                </span>
                <span
                  data-testid="server-agent-version"
                  className={cn(
                    'truncate font-mono text-[11.5px] max-xl:hidden',
                    s.agentVersion ? (offline ? 'text-text-3' : 'text-text-2') : 'text-text-3',
                  )}
                >
                  {agentVersion}
                </span>
                <Pct value={m?.cpuPct} warn={CPU_WARN_PCT} offline={offline} />
                <Pct value={m?.memPct} warn={MEM_WARN_PCT} offline={offline} />
                <Pct value={m?.diskPct} warn={DISK_WARN_PCT} offline={offline} />
                <span className="flex min-w-0 items-center gap-1.5 pl-3 text-text-2 max-md:hidden">
                  {provider ? (
                    <>
                      <ProviderIcon provider={provider} size="sm" />
                      <span className="truncate">{provider.name}</span>
                    </>
                  ) : (
                    <span className="text-text-3">—</span>
                  )}
                </span>
                <ChevronRightIcon className="size-4 text-text-3" aria-hidden="true" />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
