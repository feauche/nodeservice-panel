import type { SVGProps } from 'react';
/** Literal SVG paths from Remna-Downdetector dashboard.html.
 * Reference SHA: a5a941b9d496428bc7f8e2e4fba39aa0fc83201e.
 * Only sizing follows the existing NodeService shell. */
export function ReferenceJournalIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" />
    </svg>
  );
}
export function ReferenceSettingsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.6v-.09A1.7 1.7 0 0 0 8.55 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.2 15a1.7 1.7 0 0 0-.6-1A1.7 1.7 0 0 0 2.5 13.6H2.4V9.6h.1A1.7 1.7 0 0 0 4.2 8a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 8.55 3.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V2h4v.09A1.7 1.7 0 0 0 15 3.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 8a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.09v4h-.09A1.7 1.7 0 0 0 19.4 15Z" />
    </svg>
  );
}

export function ReferenceNodesIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="4" y="4" width="16" height="6" rx="2" />
      <rect x="4" y="14" width="16" height="6" rx="2" />
      <path d="M8 7h.01M8 17h.01" />
    </svg>
  );
}

/** Original integration favicons from the reference. */
export function DpiCheckerIcon({ className }: SVGProps<SVGSVGElement>) {
  return (
    <span className={className} aria-hidden="true">
      <img src="/integration-icons/dpi.ico" alt="" className="block size-full rounded-[4px] object-contain" />
    </span>
  );
}
export function DnsIntegrationsIcon({ className }: SVGProps<SVGSVGElement>) {
  return (
    <span className={`relative inline-block !size-6 flex-none ${className ?? ''}`} aria-hidden="true">
      <img
        src="/integration-icons/regru.ico"
        alt=""
        className="absolute top-0 left-0 size-[15px] rounded-[4px] object-contain ring-1 ring-surface"
      />
      <img
        src="/integration-icons/cloudflare.ico"
        alt=""
        className="absolute right-0 bottom-0 size-[15px] rounded-[4px] object-contain ring-1 ring-surface"
      />
    </span>
  );
}
