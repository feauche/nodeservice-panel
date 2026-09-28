import type { AssistantActivity } from '@nodeservice/shared';
import { CheckIcon, Loader2Icon, XIcon } from 'lucide-react';
import { create } from 'zustand';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';

type LiveActivity = AssistantActivity & { conversationId: string; seenAt: number };

/** Живые строки «Идёт проверка…» из потока событий панели: пока ответ Джарвиса ещё не пришёл. */
export const useActivityStore = create<{
  items: Record<string, LiveActivity>;
  upsert: (conversationId: string, a: AssistantActivity) => void;
  clear: () => void;
}>((set) => ({
  items: {},
  upsert: (conversationId, a) =>
    set((s) => ({
      items: { ...s.items, [a.id]: { ...a, conversationId, seenAt: s.items[a.id]?.seenAt ?? Date.now() } },
    })),
  // Пустое не трогаем: новый объект перерисовал бы всех подписчиков впустую.
  clear: () => set((s) => (Object.keys(s.items).length === 0 ? s : { items: {} })),
}));

/** Строки для текущей беседы; у новой беседы id ещё нет — берём появившиеся после отправки. */
export function useLiveActivity(conversationId: string | null, since: number): AssistantActivity[] {
  const items = useActivityStore((s) => s.items);
  return Object.values(items)
    .filter((a) => (conversationId ? a.conversationId === conversationId : a.seenAt >= since))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Одна строка долгого действия: пока идёт — вращение и счётчик времени; по готовности та же строка
 * меняется на «✓ … готова за 1:12» с итогом (витрина `billing-variants.html`, раздел 9).
 */
export function ActivityRow({ activity }: { activity: AssistantActivity }) {
  const running = activity.state === 'running' && !activity.finishedAt;
  const now = useNow(running, 1000);
  const took = mmss(
    (activity.finishedAt ? Date.parse(activity.finishedAt) : now) - Date.parse(activity.startedAt),
  );
  return (
    <div
      data-testid="assistant-activity"
      className={cn(
        'flex items-center gap-2.5 rounded-[10px] border bg-surface-2 px-3 py-2 text-[12.5px]',
        activity.state === 'done'
          ? 'border-ok/35'
          : activity.state === 'failed'
            ? 'border-crit/35'
            : 'border-border',
      )}
    >
      {running ? (
        <Loader2Icon className="size-3.5 flex-none animate-spin text-ai" aria-hidden="true" />
      ) : activity.state === 'done' ? (
        <CheckIcon className="size-3.5 flex-none text-ok" aria-hidden="true" />
      ) : activity.state === 'failed' ? (
        <XIcon className="size-3.5 flex-none text-crit" aria-hidden="true" />
      ) : (
        <Loader2Icon className="size-3.5 flex-none text-text-3" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1">
        {running
          ? `${activity.label} — идёт…`
          : activity.state === 'done'
            ? `${activity.label} — готова за ${took}`
            : activity.state === 'failed'
              ? `${activity.label} — не удалась`
              : `${activity.label} — ещё идёт`}
        {!running && activity.detail && <span className="text-text-3"> · {activity.detail}</span>}
      </span>
      {running && <span className="flex-none font-mono text-[12px] text-text-3 tabular-nums">{took}</span>}
    </div>
  );
}
