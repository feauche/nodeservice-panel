import { ServerIcon } from 'lucide-react';
import type { ComboOption } from '@/components/ui/combobox';

/** Shared node presentation for billing and integration selectors. */
export function nodeOption(node: { id: string; name: string; host: string }): ComboOption {
  return {
    value: node.id,
    label: node.name,
    keywords: node.host,
    node: (
      <span className="flex min-w-0 items-center gap-2">
        <ServerIcon className="size-3.5 flex-none text-text-3" aria-hidden="true" />
        <span className="truncate">{node.name}</span>
        <span className="truncate font-mono text-[11.5px] text-text-3">{node.host}</span>
      </span>
    ),
  };
}
