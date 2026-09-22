/** Мини-графики «Обзора»: собственный SVG, без библиотек и анимаций (демо-стиль). */

function toPath(values: Array<number | null>, w: number, h: number, pad = 2): string {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length < 2) return '';
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const step = (w - pad * 2) / (values.length - 1);
  let d = '';
  values.forEach((v, i) => {
    if (v === null) return;
    const x = pad + i * step;
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    d += d === '' ? `M ${x.toFixed(1)} ${y.toFixed(1)}` : ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  return d;
}

export function Sparkline({
  values,
  className,
  stroke = 'var(--ns-text-3)',
  stretch = false,
}: {
  values: Array<number | null>;
  className?: string;
  stroke?: string;
  /** Растянуть на всю ширину контейнера (толщина линии при этом не искажается). */
  stretch?: boolean;
}) {
  const w = 120;
  const h = 36;
  const d = toPath(values, w, h);
  if (!d) return null;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio={stretch ? 'none' : undefined}
      className={className}
      aria-hidden="true"
      data-testid="sparkline"
    >
      <path
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth="1.6"
        strokeLinejoin="round"
        vectorEffect={stretch ? 'non-scaling-stroke' : undefined}
      />
    </svg>
  );
}

/** Area-график «Трафика парка» — как aggchart в демо: линия + мягкая заливка. */
export function AreaSpark({ values, className }: { values: Array<number | null>; className?: string }) {
  const w = 560;
  const h = 150;
  const d = toPath(values, w, h, 4);
  if (!d) return null;
  const first = d.slice(2).split(' ')[0];
  const area = `${d} L ${w - 4} ${h - 2} L ${first} ${h - 2} Z`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={className}
      aria-hidden="true"
      data-testid="areaspark"
    >
      <path d={area} fill="var(--ns-brand)" opacity="0.12" stroke="none" />
      <path d={d} fill="none" stroke="var(--ns-brand)" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}
