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
  // Силуэт графика — площадь с сеткой, как у готового графика, а не столбики.
  return (
    <div role="status" aria-label="Загрузка графика" className="relative h-full min-h-44 overflow-hidden">
      <div className="absolute inset-0 flex flex-col justify-between py-1.5" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="block h-px w-full bg-border" />
        ))}
      </div>
      <svg
        viewBox="0 0 600 190"
        preserveAspectRatio="none"
        className="absolute inset-x-0 bottom-0 h-[78%] w-full animate-pulse motion-reduce:animate-none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="ns-sk-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--ns-surface-3)" />
            <stop offset="1" stopColor="var(--ns-surface-2)" stopOpacity="0.35" />
          </linearGradient>
        </defs>
        <path
          d="M0,120 C60,100 100,130 160,110 C220,90 260,70 320,95 C380,120 420,80 480,90 C540,100 570,85 600,92 L600,190 L0,190 Z"
          fill="url(#ns-sk-area)"
        />
      </svg>
    </div>
  );
}
