import type { SVGProps } from 'react';

/**
 * Значок Джарвиса, «Реактор»: кольцо с ядром и лучами. Рисуется как иконки lucide: цвет берёт из текста,
 * размер задаётся классом (`size-4`), поэтому подставляется вместо любой lucide-иконки.
 */
export function JarvisIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3v3.2M12 17.8V21M3 12h3.2M17.8 12H21M5.6 5.6l2.3 2.3M16.1 16.1l2.3 2.3M18.4 5.6l-2.3 2.3M7.9 16.1l-2.3 2.3" />
    </svg>
  );
}
