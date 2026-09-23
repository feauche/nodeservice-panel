import type { Provider } from '@nodeservice/shared';
import { PlusIcon } from 'lucide-react';
import { useState } from 'react';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { ProviderDialog } from './provider-dialog';
import { ProviderIcon } from './provider-icon';
import { useProviders } from './providers-api';

const NONE = '__none__';
const ADD = '__add__';

/**
 * Выбор провайдера с иконками. Последний пункт «Добавить провайдера…» открывает форму, и
 * созданный провайдер сразу становится выбранным — из окна сервера выходить не нужно.
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
  return (
    <>
      <Select
        value={value ?? NONE}
        disabled={disabled}
        onValueChange={(v) => {
          if (v === ADD) {
            setAdding(true);
            return;
          }
          // Radix присылает '' сразу после выбора значения, для которого скрытый <option> ещё не
          // зарегистрирован (только что созданный провайдер) — это не выбор пользователя.
          if (v === '') return;
          onChange(v === NONE ? null : v);
        }}
      >
        <SelectTrigger
          id={id}
          aria-label="Провайдер"
          className={cn(
            'h-10 rounded-[10px] [&>span]:flex [&>span]:min-w-0 [&>span]:items-center',
            className,
          )}
        >
          {/* Radix копирует в триггер содержимое выбранного пункта — иконка и имя приходят оттуда */}
          <SelectValue placeholder={<span className="text-text-3">Без провайдера</span>} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>
            <span className="text-text-3">Без провайдера</span>
          </SelectItem>
          {items.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              <span className="flex items-center gap-2">
                <ProviderIcon provider={p} size="sm" />
                {p.name}
                <span className="text-[11.5px] text-text-3">{p.siteHost}</span>
              </span>
            </SelectItem>
          ))}
          <SelectItem value={ADD} className="border-t border-border text-brand data-highlighted:text-brand">
            <span className="flex items-center gap-2">
              <PlusIcon className="size-4" aria-hidden="true" />
              Добавить провайдера…
            </span>
          </SelectItem>
        </SelectContent>
      </Select>
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
