import type { Provider } from '@nodeservice/shared';
import { PlusIcon } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Combobox } from '@/components/ui/combobox';
import { ProviderDialog } from './provider-dialog';
import { ProviderIcon } from './provider-icon';
import { useProviders } from './providers-api';

/**
 * Выбор провайдера с иконками и поиском (когда провайдеров много). Внизу всегда виден пункт
 * «Добавить провайдера…»: форма открывается поверх, созданный провайдер сразу становится выбранным.
 */
export function ProviderSelect({
  id,
  value,
  onChange,
  disabled,
  className,
}: {
  id?: string;
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  className?: string;
}) {
  const providers = useProviders();
  const [adding, setAdding] = useState(false);
  // Только что созданный провайдер показываем сразу, не дожидаясь перечитывания списка.
  const [justAdded, setJustAdded] = useState<Provider | null>(null);
  const loaded = providers.data?.items ?? [];
  const items = justAdded && !loaded.some((p) => p.id === justAdded.id) ? [...loaded, justAdded] : loaded;
  const options = useMemo(
    () =>
      items.map((p) => ({
        value: p.id,
        label: p.name,
        keywords: p.siteHost,
        node: (
          <span className="flex min-w-0 items-center gap-2">
            <ProviderIcon provider={p} size="sm" />
            <span className="truncate">{p.name}</span>
            <span className="truncate text-[11.5px] text-text-3">{p.siteHost}</span>
          </span>
        ),
      })),
    [items],
  );
  return (
    <>
      <Combobox
        id={id}
        ariaLabel="Провайдер"
        value={value}
        onChange={onChange}
        options={options}
        placeholder={<span className="text-text-3">Без провайдера</span>}
        emptyLabel="Без провайдера"
        searchPlaceholder="Найти провайдера…"
        searchFrom={8}
        action={{
          label: 'Добавить провайдера…',
          icon: <PlusIcon className="size-3.5" aria-hidden="true" />,
          onSelect: () => setAdding(true),
        }}
        disabled={disabled}
        className={className}
      />
      <ProviderDialog
        open={adding}
        onOpenChange={setAdding}
        onSaved={(p: Provider) => {
          setJustAdded(p);
          onChange(p.id);
        }}
      />
    </>
  );
}
