import { Skeleton } from './skeleton';
export function RowsSkeleton({ rows = 3, label = 'Загрузка данных' }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-3">
      {Array.from({ length: rows }, (_, i) => i + 1).map((row) => (
        <div key={row} className="flex min-h-16 items-center gap-3 rounded-xl border border-border p-3">
          <Skeleton className="size-9 shrink-0 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
      ))}
    </div>
  );
}
export function FormSkeleton() {
  return (
    <div role="status" aria-label="Загрузка настроек" className="grid gap-4 sm:grid-cols-2">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="h-11 w-full rounded-[10px]" />
        </div>
      ))}
    </div>
  );
}
export function ChartSkeleton() {
  return (
    <div
      role="status"
      aria-label="Загрузка графика"
      className="flex h-full min-h-44 items-end gap-3 border-b border-l border-border p-4"
    >
      {[45, 65, 52, 78, 62, 85, 70, 55, 68, 80].map((h) => (
        <Skeleton key={h} className="flex-1 rounded-t-md" style={{ height: `${h}%` }} />
      ))}
    </div>
  );
}
