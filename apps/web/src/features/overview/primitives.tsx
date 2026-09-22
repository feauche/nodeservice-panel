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

/** Путь в общей шкале двух серий: обе линии сравнимы между собой (один min/max). */
function toPathScaled(values: Array<number | null>, w: number, h: number, min: number, max: number, pad = 4) {
  if (values.filter((v) => v !== null).length < 2) return '';
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

/**
 * Area-график «Трафика парка»: приём (синий) и отдача (бирюзовый) в одной шкале,
 * каждая линия с мягкой заливкой. Одна серия — как раньше, только приём.
 */
export function AreaSpark({
  values,
  values2 = [],
  className,
}: {
  values: Array<number | null>;
  values2?: Array<number | null>;
  className?: string;
}) {
  const w = 560;
  const h = 150;
  const nums = [...values, ...values2].filter((v): v is number => v !== null);
  if (nums.length < 2) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const series = [
    { d: toPathScaled(values, w, h, min, max), color: 'var(--ns-accent)' },
    { d: toPathScaled(values2, w, h, min, max), color: 'var(--ns-teal)' },
  ].filter((s) => s.d);
  if (series.length === 0) return null;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={className}
      aria-hidden="true"
      data-testid="areaspark"
    >
      {series.map((s) => {
        const first = s.d.slice(2).split(' ')[0];
        const area = `${s.d} L ${w - 4} ${h - 2} L ${first} ${h - 2} Z`;
        return (
          <g key={s.color}>
            <path d={area} fill={s.color} opacity="0.12" stroke="none" />
            <path d={s.d} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" />
          </g>
        );
      })}
    </svg>
  );
}
