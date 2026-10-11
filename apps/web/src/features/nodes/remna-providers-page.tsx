import type { RemnaProvider } from '@nodeservice/shared';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ProviderIcon } from '@/features/providers/provider-icon';
import { apiErrorMessage } from '@/lib/api';
import { useRemnaProviders, useUpdateRemnaProvider } from './nodes-api';

export function RemnaProviderIcon({
  src,
  name,
  className,
}: {
  src?: string | null;
  name: string;
  className?: string;
}) {
  return (
    <ProviderIcon
      key={src ?? name}
      provider={{ id: '', name, hasIcon: Boolean(src), iconVersion: 0 }}
      src={src}
      size="md"
      className={className}
    />
  );
}
export function ProviderEdit({ uuid }: { uuid: string }) {
  const query = useRemnaProviders(),
    provider = query.data?.providers.find((p) => p.uuid === uuid);
  return provider ? (
    <ProviderFields key={uuid} provider={provider} />
  ) : (
    <p className="text-[12px] text-text-3">
      {query.isError ? apiErrorMessage(query.error) : 'Загрузка провайдера…'}
    </p>
  );
}
function ProviderFields({ provider }: { provider: RemnaProvider }) {
  const update = useUpdateRemnaProvider(provider.uuid);
  const [name, setName] = useState(provider.name),
    [url, setUrl] = useState(provider.loginUrl ?? '');
  const [nameDirty, setNameDirty] = useState(false),
    [urlDirty, setUrlDirty] = useState(false),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!nameDirty) setName(provider.name);
  }, [provider.name, nameDirty]);
  useEffect(() => {
    if (!urlDirty) setUrl(provider.loginUrl ?? '');
  }, [provider.loginUrl, urlDirty]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    try {
      await update.mutateAsync({
        ...(nameDirty ? { name: name.trim() } : {}),
        ...(urlDirty ? { loginUrl: url.trim() || null } : {}),
      });
      setNameDirty(false);
      setUrlDirty(false);
      setSaved(true);
    } catch {}
  }
  return (
    <form onSubmit={save} className="grid min-w-0 gap-4">
      <fieldset disabled={update.isPending} className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label
            htmlFor={`provider-name-${provider.uuid}`}
            className="grid min-w-0 gap-2 text-[12.5px] text-text-2"
          >
            Название провайдера
            <Input
              id={`provider-name-${provider.uuid}`}
              value={name}
              required
              minLength={2}
              maxLength={30}
              onChange={(e) => {
                setName(e.target.value);
                setNameDirty(true);
                setSaved(false);
              }}
            />
          </label>
          <label
            htmlFor={`provider-url-${provider.uuid}`}
            className="grid min-w-0 gap-2 text-[12.5px] text-text-2"
          >
            Ссылка провайдера
            <Input
              id={`provider-url-${provider.uuid}`}
              type="url"
              value={url}
              placeholder="https://example.com"
              onChange={(e) => {
                setUrl(e.target.value);
                setUrlDirty(true);
                setSaved(false);
              }}
            />
          </label>
        </div>
        <p className="text-[11.5px] leading-relaxed text-text-3">
          Название и ссылка сохраняются в Remnawave для всех нод этого провайдера. Иконка загружается из
          Remnawave.
        </p>
        {update.isError && (
          <p role="alert" className="text-[12px] text-crit">
            {apiErrorMessage(update.error)}
          </p>
        )}
        <div className="flex items-center justify-end gap-3">
          {saved && (
            <span role="status" className="text-[12px] text-ok">
              Сохранено в Remnawave
            </span>
          )}
          <Button
            type="submit"
            disabled={(!nameDirty && !urlDirty) || name.trim().length < 2 || update.isPending}
            className="bg-cta text-cta-foreground"
          >
            Сохранить провайдера
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
