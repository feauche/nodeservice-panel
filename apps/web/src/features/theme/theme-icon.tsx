import type { ThemeKey } from './theme';

/** Иконки тем из демо: луна / солнце / полукруг. */
export function ThemeIcon({ theme, className }: { theme: ThemeKey; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {theme === 'light' ? (
        <>
          <path d="M12 3v2M12 19v2M5 5l1.5 1.5M17.5 17.5 19 19M3 12h2M19 12h2M5 19l1.5-1.5M17.5 6.5 19 5" />
          <circle cx="12" cy="12" r="3.6" />
        </>
      ) : theme === 'black' ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none" />
        </>
      ) : (
        <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" />
      )}
    </svg>
  );
}
