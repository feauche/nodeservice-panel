import { NODE_WATCH_LABELS, NODE_WATCH_MODES, type NodeWatch, type Server } from '@nodeservice/shared';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

const HINT: Record<NodeWatch, string> = {
  auto: 'Панель судит только найденный контейнер: нет контейнера — сервер не нода.',
  on: 'Нода здесь должна быть: остановлена или не найдена — инцидент.',
  off: 'Сервер без ноды или нода выключена намеренно: инцидентов по ней не будет.',
};

/** Что зонд видел в последний раз, одной строкой для подсказки под полем. */
export function nodeStateLine(server: Pick<Server, 'node' | 'nodeWatch'>): string {
  if (server.nodeWatch === 'off') return 'Слежение выключено.';
  if (server.node === 'running') return 'Сейчас: контейнер найден, работает.';
  if (server.node === 'stopped') return 'Сейчас: контейнер найден, остановлен.';
  if (server.node === 'none') return 'Сейчас: контейнер не найден.';
  return 'Сейчас: ещё не проверяли.';
}

/** Поле «Нода на сервере»: следить ли за контейнером `*remna*` и заводить ли по нему инциденты. */
export function NodeWatchSelect({
  id,
  value,
  onChange,
  disabled,
  className,
}: {
  id: string;
  value: NodeWatch;
  onChange: (v: NodeWatch) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(v) => {
          if (v) onChange(v as NodeWatch);
        }}
      >
        <SelectTrigger id={id} aria-label="Нода на сервере" className={cn('h-10 rounded-[10px]', className)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {NODE_WATCH_MODES.map((m) => (
            <SelectItem key={m} value={m}>
              {NODE_WATCH_LABELS[m]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[12px] leading-snug text-text-3">{HINT[value]}</p>
    </div>
  );
}
