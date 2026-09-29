import {
  isExitOnly,
  SERVER_UPSTREAM_LABELS,
  type Server,
  type ServerUpstream,
  type ServerUpstreamKind,
  UPSTREAM_OWNER_MAX,
} from '@nodeservice/shared';
import { InfoIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useServers } from '../servers-api';

type Mode = ServerUpstreamKind | 'none';
const MODES: ReadonlyArray<{ key: Mode; label: string; sub: string }> = [
  { key: 'bridge', label: SERVER_UPSTREAM_LABELS.bridge, sub: 'Сервер из NodeService' },
  { key: 'rent', label: SERVER_UPSTREAM_LABELS.rent, sub: 'Чужой домен или IP' },
  { key: 'none', label: 'Не указывать', sub: 'Как сейчас' },
];

const H3 = 'm-0 text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase';
const HINT = 'm-0 mt-1.5 text-[12px] leading-snug text-text-3';

function Optional() {
  return (
    <span className="rounded-[6px] bg-surface-3 px-[7px] py-px text-[11px] font-medium whitespace-nowrap text-text-3">
      Необязательно
    </span>
  );
}

/**
 * «Откуда приходит трафик» (витрина `entry-field-variants.html`, A): только у чистого выхода — выпускает
 * трафик и сам клиентов не принимает. Появляется и уходит плавно. Если сервер и принимает клиентов, и выпускает
 * трафик, вход у него он сам — поле скрыто, а сохранённый раньше вход при сохранении убирается.
 */
export function UpstreamField({
  server,
  roles,
  value,
  onChange,
  error,
}: {
  server: Server;
  roles: Server['profile']['roles'];
  value: ServerUpstream | null;
  onChange: (v: ServerUpstream | null) => void;
  error: string | null;
}) {
  const servers = useServers();
  const open = isExitOnly(roles);
  // Содержимое держим в разметке только пока блок виден или сворачивается: скрытые поля не должны
  // попадать ни в поиск по странице, ни в чтение с экрана. Раскрытие — со второго кадра, чтобы была анимация.
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setShown(true);
      return;
    }
    const t = setTimeout(() => setShown(false), 220);
    return () => clearTimeout(t);
  }, [open]);
  const expanded = open && shown;
  // Вход сохранён, а сервер теперь не чистый выход — объясняем, куда он денется.
  const dropping = !open && server.profile.upstream !== null;
  const mode: Mode = value?.kind ?? 'none';
  const pick = (m: Mode) =>
    onChange(
      m === 'none'
        ? null
        : m === 'bridge'
          ? {
              kind: 'bridge',
              serverId: value?.kind === 'bridge' ? value.serverId : null,
              address: null,
              owner: null,
            }
          : {
              kind: 'rent',
              serverId: null,
              address: value?.kind === 'rent' ? value.address : '',
              owner: value?.kind === 'rent' ? value.owner : null,
            },
    );
  const bridges = (servers.data?.items ?? [])
    .filter((s) => s.id !== server.id)
    .sort(
      (a, b) =>
        Number(b.profile.roles.includes('bridge') || b.profile.roles.includes('entry')) -
          Number(a.profile.roles.includes('bridge') || a.profile.roles.includes('entry')) ||
        a.name.localeCompare(b.name, 'ru'),
    );

  return (
    <>
      <div
        className={cn(
          'grid transition-[grid-template-rows,opacity,margin] duration-200 ease-out motion-reduce:transition-none',
          expanded ? 'grid-rows-[1fr] opacity-100' : '-mt-4 grid-rows-[0fr] opacity-0',
        )}
        aria-hidden={!expanded}
        data-testid="upstream-field"
      >
        <div className="min-h-0 overflow-hidden">
          {shown && (
            <section aria-labelledby="pf-upstream" className="flex flex-col gap-2 pt-px">
              <div className="flex flex-wrap items-center gap-2">
                <h3 id="pf-upstream" className={H3}>
                  Откуда приходит трафик
                </h3>
                <Optional />
              </div>
              <fieldset className="m-0 flex gap-[3px] rounded-[11px] border border-border bg-surface-2 p-[3px] max-sm:flex-col">
                <legend className="sr-only">Откуда приходит трафик</legend>
                {MODES.map((m) => {
                  const on = m.key === mode;
                  return (
                    <button
                      key={m.key}
                      type="button"
                      aria-pressed={on}
                      tabIndex={open ? undefined : -1}
                      onClick={() => pick(m.key)}
                      className={cn(
                        'flex flex-1 cursor-pointer flex-col items-center gap-[2px] rounded-[8px] px-3 py-2 text-center transition-[background,box-shadow,color] duration-150',
                        on
                          ? 'bg-surface text-foreground shadow-[0_0_0_1px_var(--ns-border-2)]'
                          : 'text-text-2 hover:text-foreground',
                      )}
                    >
                      <span className="text-[12.5px] font-medium">{m.label}</span>
                      <span className={cn('text-[11px]', on ? 'text-text-2' : 'text-text-3')}>{m.sub}</span>
                    </button>
                  );
                })}
              </fieldset>

              {value?.kind === 'rent' && (
                <div className="mt-1 grid gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="pf-up-address" className="mb-2 block text-[13px] font-semibold">
                      Адрес входа
                    </label>
                    <Input
                      id="pf-up-address"
                      value={value.address ?? ''}
                      tabIndex={open ? undefined : -1}
                      placeholder="entry.example.com:443"
                      autoCapitalize="none"
                      spellCheck={false}
                      aria-invalid={error ? true : undefined}
                      onChange={(e) => onChange({ ...value, address: e.target.value })}
                      className="h-10 rounded-[10px] bg-surface-2 font-mono text-[13px]"
                    />
                    {error ? (
                      <p className="m-0 mt-1.5 text-[12px] text-crit">{error}</p>
                    ) : (
                      <p className={HINT}>
                        Домен или IP, через двоеточие порт, если не 443. Можно вставить и ссылкой — «https://»
                        панель уберёт сама. По нему подключаются клиенты.
                      </p>
                    )}
                  </div>
                  <div>
                    <label
                      htmlFor="pf-up-owner"
                      className="mb-2 flex items-center gap-2 text-[13px] font-semibold"
                    >
                      Чей вход <Optional />
                    </label>
                    <Input
                      id="pf-up-owner"
                      value={value.owner ?? ''}
                      maxLength={UPSTREAM_OWNER_MAX}
                      tabIndex={open ? undefined : -1}
                      placeholder="Например, guardora, Иван из чата"
                      onChange={(e) => onChange({ ...value, owner: e.target.value })}
                      className="h-10 rounded-[10px] bg-surface-2"
                    />
                    <p className={HINT}>Кому писать, если лёг вход. Видите вы и Джарвис.</p>
                  </div>
                </div>
              )}

              {value?.kind === 'bridge' && (
                <div className="mt-1">
                  <label htmlFor="pf-up-bridge" className="mb-2 block text-[13px] font-semibold">
                    Мост
                  </label>
                  <Combobox
                    id="pf-up-bridge"
                    ariaLabel="Мост"
                    value={value.serverId}
                    onChange={(id) => onChange({ ...value, serverId: id })}
                    options={bridges.map((s) => ({ value: s.id, label: s.name, keywords: s.host }))}
                    placeholder={<span className="text-text-3">Выберите сервер</span>}
                    searchPlaceholder="Найти сервер…"
                    className="h-10 w-full"
                  />
                  {error ? (
                    <p className="m-0 mt-1.5 text-[12px] text-crit">{error}</p>
                  ) : (
                    <p className={HINT}>
                      Сверху — серверы, отмеченные как «Мост» или «Принимает подключения».
                    </p>
                  )}
                </div>
              )}

              {value && (
                <p className="m-0 text-[12px] leading-normal text-text-3">
                  {value.kind === 'bridge'
                    ? 'При падении онлайна панель проверит и мост, и этот выход — видно, где разрыв цепочки.'
                    : 'При падении онлайна панель проверит и вход, и этот выход — видно, чья сторона сломалась. Сменил арендодатель домен — поменяйте здесь.'}
                </p>
              )}
            </section>
          )}
        </div>
      </div>
      {dropping && (
        <p className="-mt-2 flex items-start gap-2 text-[12px] leading-snug text-text-3">
          <InfoIcon className="mt-px size-3.5 flex-none" aria-hidden="true" />
          Сервер сам принимает клиентов, поэтому «Откуда приходит трафик» не нужно: указанный вход уберётся
          при сохранении.
        </p>
      )}
    </>
  );
}
