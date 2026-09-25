import { NODE_WATCH_LABELS, NODE_WATCH_MODES, type NodeWatch, type Server } from '@nodeservice/shared';

import { Pill } from '@/features/settings/settings-ui';
import { cn } from '@/lib/utils';

const SUB: Record<NodeWatch, string> = {
  auto: 'Судим, если контейнер найден',
  on: 'Нет контейнера — тоже инцидент',
  off: 'Сервер без ноды',
};

const HINT: Record<NodeWatch, string> = {
  auto: 'Зонд по SSH раз в 15 с. Остановка контейнера — инцидент сразу, автопочинка ждёт 60 с.',
  on: 'Нода здесь обязана быть: остановлена или не найдена — инцидент сразу.',
  off: 'Инцидентов по ноде на этом сервере не будет. Для серверов без ноды или когда нода выключена намеренно.',
};

/** Пилюля «что зонд видел в последний раз» для шапки блока «Нода». */
export function NodeStatePill({ server }: { server: Pick<Server, 'node' | 'nodeWatch'> }) {
  if (server.nodeWatch === 'off') return <Pill tone="muted">Слежение выключено</Pill>;
  if (server.node === 'running') return <Pill tone="ok">Контейнер работает</Pill>;
  if (server.node === 'stopped') return <Pill tone="crit">Контейнер остановлен</Pill>;
  if (server.node === 'none')
    return <Pill tone={server.nodeWatch === 'on' ? 'crit' : 'muted'}>Контейнер не найден</Pill>;
  return <Pill tone="muted">Ещё не проверяли</Pill>;
}

/**
 * «Нода на сервере» — три режима одной полосой (витрина «Нода», вариант 2): выбор в один клик,
 * подпись под каждым режимом, пояснение выбранного под полосой.
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
        <legend className="sr-only">Нода на сервере</legend>
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
