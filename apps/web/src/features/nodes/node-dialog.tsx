import type { NodePreferences, RemnawaveNode } from '@nodeservice/shared';
import { ActivityIcon, CableIcon, CopyIcon, GitBranchIcon, Settings2Icon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { CountryFlag } from '@/components/country-flag';
import { DialogPrimaryButton } from '@/components/dialog-actions';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { FormSkeleton } from '@/components/ui/loading-state';
import { ProviderSelect } from '@/features/providers/provider-select';
import { ProvidersSourceContext } from '@/features/providers/providers-api';
import { NodeScenarios } from '@/features/scenarios/node-scenarios';
import { Pill, Segmented } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { bytes, mbitPerSecond, nodeState, percent, ram, uptime } from './node-card';
import { NodeMetricChart, useNodeMetrics } from './node-metrics';
import { NodeTcpCheck } from './node-tcp-check';
import { useAssignNodeProvider, useNodePreferences, useNodes, useSaveNodePreferences } from './nodes-api';
import { RemnaProviderIcon } from './remna-providers-page';

const label = 'mb-2 block text-sm font-medium text-text-2';
export function NodeDialog({
  node,
  stale,
  onClose,
}: {
  node: RemnawaveNode;
  stale: boolean;
  onClose: () => void;
}) {
  const [range, setRange] = useState('60');
  const metrics = useNodeMetrics(Number(range));
  const points = metrics.data?.history.find((n) => n.uuid === node.uuid)?.points ?? [];
  const [tab, setTab] = useState('metrics'),
    query = useNodePreferences(node.uuid),
    save = useSaveNodePreferences(node.uuid),
    assign = useAssignNodeProvider(node.uuid),
    status = useNodes();
  const [form, setForm] = useState<NodePreferences | null>(null),
    [dirty, setDirty] = useState(false),
    [saved, setSaved] = useState(false),
    [provider, setProvider] = useState(node.providerUuid ?? null),
    [providerDirty, setProviderDirty] = useState(false);
  useEffect(() => {
    if (query.data && !dirty) setForm(query.data);
  }, [query.data, dirty]);
  useEffect(() => {
    if (!providerDirty) setProvider(node.providerUuid ?? null);
  }, [node.providerUuid, providerDirty]);
  const state = nodeState(node);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaved(false);
    try {
      if (providerDirty && provider !== (node.providerUuid ?? null)) {
        await assign.mutateAsync(provider);
        setProviderDirty(false);
      }
      if (dirty) {
        await save.mutateAsync(form);
        setDirty(false);
      }
      setSaved(true);
    } catch {}
  }
  const tabs = [
    ['metrics', 'Метрики', ActivityIcon],
    ['connection', 'Подключение', CableIcon],
    ['settings', 'Настройки', Settings2Icon],
    ['scenarios', 'Сценарии', GitBranchIcon],
  ] as const;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex flex-col md:flex-row h-[min(900px,calc(100dvh-40px))] max-h-[calc(100dvh-40px)] gap-0 overflow-hidden rounded-2xl border-border-2 bg-surface p-0 sm:max-w-[1320px]"
        overlayClassName="bg-black/45 backdrop-blur-sm"
      >
        <aside className="flex-none border-b border-border bg-bg-2 md:flex md:min-h-0 md:w-[250px] md:flex-col md:overflow-y-auto md:border-r md:border-b-0">
          <div className="px-5 pt-5 pb-4 pr-10 md:pr-5">
            <div className="flex flex-wrap items-center gap-2.5">
              {node.countryCode && <CountryFlag code={node.countryCode} size="md" />}
              <DialogTitle className="font-heading text-[18px]">{node.name}</DialogTitle>
              <Pill tone={stale ? 'muted' : state.tone}>{stale ? 'Старый снимок' : state.label}</Pill>
            </div>
            <DialogDescription className="mt-2 flex flex-wrap items-center gap-3 text-[12px]">
              <span className="font-mono md:hidden">
                {node.address}
                {node.port ? `:${node.port}` : ''}
              </span>
              <span className="flex items-center gap-1.5">
                <RemnaProviderIcon
                  src={node.providerIcon}
                  name={node.providerName ?? '?'}
                  className="size-4"
                />
                {node.providerName || 'Без провайдера'}
              </span>
            </DialogDescription>
          </div>
          <dl className="hidden space-y-6 px-5 py-4 text-sm md:block">
            <div>
              <dt className="mb-1 text-text-3">Адрес и порт</dt>
              <dd className="break-all font-mono">
                {node.address}:{node.port ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="mb-1 text-text-3">Процессор</dt>
              <dd>{node.cpuCount ?? '—'} ядер</dd>
              <dd className="mt-1 text-xs text-text-2">{node.cpuModel ?? 'Модель не передана'}</dd>
            </div>
            <div>
              <dt className="mb-1 text-text-3">Ресурсы</dt>
              <dd>{bytes(node.memoryTotalBytes)} RAM</dd>
            </div>
            <div>
              <dt className="mb-1 text-text-3">Время работы</dt>
              <dd>{uptime(node.uptime)}</dd>
            </div>
            <div>
              <dt className="mb-1 text-text-3">Версии</dt>
              <dd>Xray {node.xrayVersion ?? '—'}</dd>
              <dd>Node {node.nodeVersion ?? '—'}</dd>
            </div>
          </dl>
          <div className="mt-auto hidden border-t border-border p-5 text-xs leading-relaxed text-text-3 md:block">
            Показания приходят из Remnawave. Частота опроса задаётся в настройках автопроверок.
          </div>
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            role="tablist"
            aria-label="Информация о ноде"
            className="flex flex-none gap-1 border-b border-border px-3 py-3 md:gap-2 md:px-5 md:py-4 md:pr-12"
          >
            {tabs.map(([id, name, Icon], index) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`node-tab-${id}`}
                aria-controls={`node-panel-${id}`}
                aria-selected={tab === id}
                tabIndex={tab === id ? 0 : -1}
                onKeyDown={(e) => {
                  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                    e.preventDefault();
                    const next =
                      tabs[
                        e.key === 'Home'
                          ? 0
                          : e.key === 'End'
                            ? 2
                            : (index + (e.key === 'ArrowLeft' ? 2 : 1)) % 3
                      ][0];
                    setTab(next);
                    document.getElementById(`node-tab-${next}`)?.focus();
                  }
                }}
                onClick={() => setTab(id)}
                className={cn(
                  'flex min-w-0 flex-1 items-center justify-center gap-2 rounded-[11px] border px-2 py-3 text-[13px] md:flex-none md:px-4 md:text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-brand',
                  tab === id
                    ? 'border-border bg-surface-2 text-foreground'
                    : 'border-transparent text-text-2 hover:bg-surface-2 hover:text-foreground',
                )}
              >
                <Icon className="hidden size-4 md:block" />
                {name}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id={`node-panel-${tab}`}
            aria-labelledby={`node-tab-${tab}`}
            className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
          >
            {stale && (
              <p className="mb-4 rounded-lg bg-warn-soft p-3 text-xs text-warn">
                Нет свежего ответа. Показано последнее полученное состояние.
              </p>
            )}
            {tab === 'metrics' ? (
              <div className="space-y-5">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h2 className="font-heading text-[16px] font-semibold">Состояние ноды</h2>
                    <p className="mt-1 text-[12px] text-text-3">
                      Одинаковые минутные снимки из Remnawave для всех графиков.
                    </p>
                  </div>
                </div>
                <details className="rounded-xl bg-surface-2/60 p-4 md:hidden">
                  <summary className="cursor-pointer text-sm font-medium">Ресурсы и версии ноды</summary>
                  <dl className="mt-4 space-y-3 text-sm">
                    <div>
                      <dt className="text-text-3">Процессор</dt>
                      <dd>
                        {node.cpuCount ?? '—'} ядер · {node.cpuModel ?? 'Модель не передана'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-text-3">Память</dt>
                      <dd>{bytes(node.memoryTotalBytes)} RAM</dd>
                    </div>
                    <div>
                      <dt className="text-text-3">Версии</dt>
                      <dd>
                        Xray {node.xrayVersion ?? '—'} · Node {node.nodeVersion ?? '—'}
                      </dd>
                    </div>
                  </dl>
                </details>
                {!node.isConnected && node.lastStatusMessage && (
                  <p className="rounded-lg bg-crit-soft p-3 text-xs text-crit">{node.lastStatusMessage}</p>
                )}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Segmented
                    label="Период метрик"
                    value={range}
                    onChange={setRange}
                    items={[
                      { key: '60', label: '1 час' },
                      { key: '1440', label: '24 часа' },
                      { key: '10080', label: '7 дней' },
                    ]}
                  />
                  <span className="text-xs text-text-3">Обновление 15 с · замеры раз в минуту</span>
                </div>
                {metrics.isError && (
                  <p role="alert" className="text-xs text-crit">
                    {apiErrorMessage(metrics.error)}
                  </p>
                )}
                <div className="grid gap-4 md:grid-cols-2">
                  <NodeMetricChart
                    loading={metrics.isPending}
                    title={node.cpuPercent == null ? 'Нагрузка · Load average' : 'Процессор'}
                    value={
                      node.cpuPercent == null
                        ? String(node.loadAverage?.[0] ?? '—')
                        : percent(node.cpuPercent)
                    }
                    data={points.map((p) => ({ t: p.t, v: node.cpuPercent == null ? p.load : p.cpu }))}
                    percent={node.cpuPercent != null}
                  />
                  <NodeMetricChart
                    loading={metrics.isPending}
                    title="Оперативная память"
                    value={percent(ram(node))}
                    data={points.map((p) => ({ t: p.t, v: p.ram }))}
                    percent
                    color="var(--ns-ok)"
                  />
                  <NodeMetricChart
                    loading={metrics.isPending}
                    title="Входящий трафик"
                    value={`${mbitPerSecond(node.rxBytesPerSec)} Мбит/с`}
                    data={points.map((p) => ({ t: p.t, v: p.rx == null ? null : (p.rx * 8) / 1_000_000 }))}
                    unit=" Мбит/с"
                  />
                  <NodeMetricChart
                    loading={metrics.isPending}
                    title="Исходящий трафик"
                    value={`${mbitPerSecond(node.txBytesPerSec)} Мбит/с`}
                    data={points.map((p) => ({ t: p.t, v: p.tx == null ? null : (p.tx * 8) / 1_000_000 }))}
                    unit=" Мбит/с"
                    color="var(--ns-ok)"
                  />
                  <NodeMetricChart
                    loading={metrics.isPending}
                    title="Онлайн на ноде"
                    value={String(node.usersOnline ?? '—')}
                    data={points.map((p) => ({ t: p.t, v: p.online }))}
                  />
                  <section className="rounded-2xl border border-border bg-surface p-4">
                    <h3 className="mb-3 text-xs font-semibold uppercase text-text-2">Подключение и трафик</h3>
                    <Info label="Адрес" value={node.address} />
                    <Info label="Порт" value={String(node.port ?? '—')} />
                    <Info label="Трафик" value={bytes(node.trafficUsedBytes)} />
                    <Info label="Время работы" value={uptime(node.uptime)} />
                  </section>
                </div>
                <p className="text-[11px] text-text-3">
                  История нагрузки и памяти сохраняется с момента подключения мониторинга. Прошлые значения не
                  восстанавливаются из текущего снимка.
                </p>
              </div>
            ) : tab === 'connection' ? (
              <div className="space-y-5">
                <NodeTcpCheck uuid={node.uuid} />
                <div>
                  <h2 className="font-heading text-[16px] font-semibold">Данные подключения и проверки</h2>
                  <p className="mt-1 text-[12px] text-text-3">
                    Адрес, порт и идентификаторы из текущего подключения Remnawave.
                  </p>
                </div>
                <section className="grid gap-px overflow-hidden rounded-[14px] border border-border bg-border sm:grid-cols-2 [&>*]:rounded-none [&>*]:bg-surface-2">
                  <ConnectionField label="Адрес / IP" value={node.address} copy />
                  <ConnectionField label="Порт ноды" value={node.port?.toString() ?? 'Не передан'} />
                  <ConnectionField label="Идентификатор ноды" value={node.uuid} copy />
                  <ConnectionField label="Панель Remnawave" value={status.data?.domain ?? '—'} copy />
                </section>
                <p className="rounded-[12px] border border-border bg-surface-2/55 px-4 py-3 text-[12.5px] leading-5 text-text-2">
                  API-ключ хранится зашифрованным. Изменить его можно в «Настроить подключение» на странице
                  нод. Ключи и пароли самой ноды Remnawave в этом ответе не передаёт.
                </p>
              </div>
            ) : tab === 'scenarios' ? (
              <NodeScenarios uuid={node.uuid} />
            ) : (
              <div className="space-y-5">
                <div>
                  <h2 className="font-heading text-[16px] font-semibold">Настройки ноды</h2>
                  <p className="mt-1 text-[12px] text-text-3">
                    Провайдер, предупреждения, расчёт ёмкости и заметка.
                  </p>
                </div>
                <section className="rounded-[14px] border border-border bg-surface p-5">
                  <h3 className="mb-4 text-[12px] font-semibold uppercase tracking-wide text-text-3">
                    Провайдер
                  </h3>
                  <label className={label} htmlFor="node-provider">
                    Провайдер ноды
                  </label>
                  <ProvidersSourceContext.Provider value="/nodes/providers/catalog">
                    <ProviderSelect
                      id="node-provider"
                      value={provider}
                      onChange={(id) => {
                        setProvider(id);
                        setProviderDirty(true);
                      }}
                      disabled={assign.isPending || save.isPending}
                    />
                  </ProvidersSourceContext.Provider>
                  <p className="mt-2 text-[11.5px] text-text-3">
                    Новый провайдер применяется к этой ноде при сохранении настроек.
                  </p>
                  {assign.isError && (
                    <p role="alert" className="mt-2 text-xs text-crit">
                      {apiErrorMessage(assign.error)}
                    </p>
                  )}
                </section>
                {query.isPending ? (
                  <FormSkeleton />
                ) : query.isError ? (
                  <p role="alert" className="text-xs text-crit">
                    {apiErrorMessage(query.error)}
                  </p>
                ) : (
                  form && (
                    <form
                      id="node-settings-form"
                      onSubmit={submit}
                      className="pt-2 [&_input]:h-11 [&_input]:text-sm"
                    >
                      <fieldset disabled={save.isPending || assign.isPending} className="space-y-4">
                        <section className="rounded-[14px] border border-border bg-surface p-5">
                          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-text-3">
                            Предупреждения о нагрузке
                          </h3>
                          <p className="mb-4 mt-1 text-[12px] leading-5 text-text-3">
                            Пустое поле использует общий порог из настроек событий. При устойчивом превышении
                            мониторинг создаст событие, если предупреждения включены.
                          </p>
                          <div className="grid gap-4 sm:grid-cols-2">
                            {[
                              ['cpuWarningPercent', 'Предупреждать при CPU выше, %'],
                              ['memoryWarningPercent', 'Предупреждать при RAM выше, %'],
                            ].map(([key, title]) => (
                              <div key={key}>
                                <label htmlFor={key} className={label}>
                                  {title}
                                </label>
                                <Input
                                  id={key}
                                  type="number"
                                  min={1}
                                  max={100}
                                  placeholder="Общий порог"
                                  value={(form[key as keyof NodePreferences] as number | null) ?? ''}
                                  onChange={(e) => {
                                    setForm({
                                      ...form,
                                      [key]: e.target.value === '' ? null : Number(e.target.value),
                                    });
                                    setDirty(true);
                                    setSaved(false);
                                  }}
                                />
                              </div>
                            ))}
                          </div>
                        </section>
                        <section className="rounded-[14px] border border-border bg-surface p-5">
                          <div>
                            <label htmlFor="node-channel" className={label}>
                              Лимит канала провайдера, Мбит/с
                            </label>
                            <Input
                              id="node-channel"
                              type="number"
                              min={1}
                              max={1000000}
                              value={form.channelMbps ?? ''}
                              placeholder="Укажите лимит провайдера для расчёта ёмкости"
                              onChange={(e) => {
                                setForm({
                                  ...form,
                                  channelMbps: e.target.value ? Number(e.target.value) : null,
                                });
                                setDirty(true);
                                setSaved(false);
                              }}
                            />
                            <p className="mt-2 text-[11.5px] leading-5 text-text-3">
                              Используется только для расчёта запаса в разделе «Ёмкость». Пустое поле
                              означает, что лимит неизвестен.
                            </p>
                          </div>
                        </section>
                        <section className="rounded-[14px] border border-border bg-surface p-5">
                          <div>
                            <label htmlFor="node-note" className={label}>
                              Заметка
                            </label>
                            <textarea
                              id="node-note"
                              value={form.note}
                              maxLength={1000}
                              rows={3}
                              onChange={(e) => {
                                setForm({ ...form, note: e.target.value });
                                setDirty(true);
                                setSaved(false);
                              }}
                              className="w-full rounded-[11px] border border-border bg-surface-2 px-4 py-3 text-sm outline-none focus:border-brand"
                              placeholder="Информация о ноде"
                            />
                          </div>
                        </section>
                        {save.isError && (
                          <p role="alert" className="text-xs text-crit">
                            {apiErrorMessage(save.error)}
                          </p>
                        )}
                      </fieldset>
                    </form>
                  )
                )}
              </div>
            )}
          </div>
          <div className="flex h-[72px] shrink-0 items-center justify-between gap-4 border-t border-border bg-surface px-6 py-4">
            <span className="hidden min-w-0 flex-1 text-xs text-text-3 sm:block">
              {saved
                ? 'Сохранено'
                : tab === 'settings'
                  ? 'Провайдер — в Remnawave, заметка и пороги — в NodeService'
                  : 'Данные Remnawave · обновление каждые 15 секунд'}
            </span>
            {tab === 'settings' && (
              <DialogPrimaryButton
                form="node-settings-form"
                type="submit"
                disabled={!form || save.isPending || assign.isPending || (!dirty && !providerDirty)}
              >
                Сохранить
              </DialogPrimaryButton>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
function Info({ label, value, copy }: { label: string; value: string; copy?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-1 border-b border-border px-4 py-3 text-[12px] last:border-b-0">
      <span className="text-text-2">{label}</span>
      <span className="flex min-w-0 items-center gap-2 break-all font-medium">
        {value}
        {copy && (
          <button
            type="button"
            aria-label={`Копировать ${label}`}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value);
                setCopied(true);
                setTimeout(() => setCopied(false), 1800);
              } catch {}
            }}
            className="rounded p-1 text-text-3 hover:bg-surface-2"
          >
            <CopyIcon className="size-3.5" />
            {copied && <span className="sr-only">Скопировано</span>}
          </button>
        )}
      </span>
    </div>
  );
}
function ConnectionField({ label, value, copy = false }: { label: string; value: string; copy?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="min-w-0 rounded-2xl bg-surface-2/60 p-5 sm:p-6">
      <p className="mb-3 text-sm text-text-2">{label}</p>
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 break-all text-base font-medium">{value}</p>
        {copy && (
          <button
            type="button"
            aria-label={`Копировать ${label}`}
            className="flex size-11 shrink-0 items-center justify-center rounded-xl text-text-2 transition-colors hover:bg-surface-3 hover:text-brand focus-visible:outline-2 focus-visible:outline-brand"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value);
                setCopied(true);
                setTimeout(() => setCopied(false), 1800);
              } catch {}
            }}
          >
            <CopyIcon className="size-4" />
          </button>
        )}
      </div>
      {copied && (
        <p role="status" className="mt-2 text-sm text-ok">
          Скопировано
        </p>
      )}
    </div>
  );
}
