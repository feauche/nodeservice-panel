import { NODE_WATCH_LABELS, NODE_WATCH_MODES, type NodeWatch, type Server } from '@nodeservice/shared';

import { Pill } from '@/features/settings/settings-ui';
import { cn } from '@/lib/utils';

const SUB: Record<NodeWatch, string> = {
  auto: 'Следим, если найдём контейнер',
  on: 'Нет контейнера тоже инцидент',
  off: 'На сервере нет ноды',
};

const HINT: Record<NodeWatch, string> = {
  auto: 'Панель следит за нодой, только если найдёт её контейнер. Если он остановится, будет инцидент.',
  on: 'Нода здесь обязана быть: если контейнер остановится или пропадёт, сразу будет инцидент.',
  off: 'За нодой на этом сервере не следим: инцидент об остановленной ноде заводиться не будет. Подходит для серверов без ноды.',
};

/** Пилюля «что зонд видел в последний раз» для блока «Нода Remnawave на сервере». */
export function NodeStatePill({ server }: { server: Pick<Server, 'node' | 'nodeWatch'> }) {
  if (server.nodeWatch === 'off') return <Pill tone="muted">Слежение выключено</Pill>;
  if (server.node === 'running') return <Pill tone="ok">Контейнер работает</Pill>;
  if (server.node === 'stopped') return <Pill tone="crit">Контейнер остановлен</Pill>;
  if (server.node === 'none')
    return <Pill tone={server.nodeWatch === 'on' ? 'crit' : 'muted'}>Контейнер не найден</Pill>;
  return <Pill tone="muted">Ещё не проверяли</Pill>;
}

/**
 * «Нода Remnawave на сервере» — три режима одной полосой: выбор в один клик, подпись под каждым
 * режимом, пояснение выбранного под полосой. Живёт на вкладке «Профиль».
 */
export function NodeWatchSegments({
  value,
  onChange,
  disabled,
}: {
  value: NodeWatch;
  onChange: (v: NodeWatch) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <fieldset className="m-0 flex gap-[3px] rounded-[11px] border border-border bg-surface-2 p-[3px] max-sm:flex-col">
        <legend className="sr-only">Нода Remnawave на сервере</legend>
        {NODE_WATCH_MODES.map((m) => {
          const on = m === value;
          return (
            <button
              key={m}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => onChange(m)}
              className={cn(
                'flex flex-1 cursor-pointer flex-col items-center gap-[2px] rounded-[8px] px-3 py-2 text-center transition-[background,box-shadow,color] duration-150 disabled:cursor-default disabled:opacity-60',
                on
                  ? 'bg-surface text-foreground shadow-[0_0_0_1px_var(--ns-border-2)]'
                  : 'text-text-2 hover:text-foreground',
              )}
            >
              <span className="text-[12.5px] font-medium">{NODE_WATCH_LABELS[m]}</span>
              <span className={cn('text-[11px]', on ? 'text-text-2' : 'text-text-3')}>{SUB[m]}</span>
            </button>
          );
        })}
      </fieldset>
      <p className="mt-2.5 text-[12px] leading-snug text-text-3">{HINT[value]}</p>
    </div>
  );
}
