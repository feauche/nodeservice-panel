import type { NodePreferences, RemnawaveNode } from '@nodeservice/shared';
import { useNavigate } from '@tanstack/react-router';
import {
  ActivityIcon,
  CableIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  InfoIcon,
  RadarIcon,
  Settings2Icon,
  XIcon,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { CountryFlag } from '@/components/country-flag';
import { DialogPrimaryButton } from '@/components/dialog-actions';
import { MetricArea } from '@/components/metric-area';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { FormSkeleton } from '@/components/ui/loading-state';
import { AskAssistant } from '@/features/assistant/ask-assistant';
import type { NodeDialogTab } from '@/features/knowledge/markdown';
import { plural } from '@/features/overview/overview-format';
import { ProviderSelect } from '@/features/providers/provider-select';
import { ProvidersSourceContext } from '@/features/providers/providers-api';
import { NodeScenarios } from '@/features/scenarios/node-scenarios';
import { useMonitoring } from '@/features/settings/settings-api';
import { Pill, Segmented } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  bytes,
  LoadBar,
  loadPerCore,
  mbitPerSecond,
  nodeState,
  ram,
  uptime,
  WhitelistBadge,
} from './node-card';
import { useNodeMetrics } from './node-metrics';
import { NodeTcpCheck } from './node-tcp-check';
import { useAssignNodeProvider, useNodePreferences, useNodes, useSaveNodePreferences } from './nodes-api';
import { RemnaProviderIcon } from './remna-providers-page';

const TABS = [
  ['metrics', 'Метрики', ActivityIcon],
  ['connection', 'Подключение', CableIcon],
  ['settings', 'Настройки', Settings2Icon],
  ['scenarios', 'Сценарии', GitBranchIcon],
] as const;

/** Кнопки паспорта — одной высоты и ширины, как в окне 0.67.0. */
const SIDE_BTN =
  'inline-flex h-[38px] w-full cursor-pointer items-center justify-start gap-2 rounded-[10px] border border-border bg-surface-2 px-3 text-[13px] font-medium whitespace-nowrap text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand [&_img]:size-4 [&_svg]:size-4';
const label = 'mb-1.5 block text-[12.5px] font-medium text-text-2';
const num = (v: number | null | undefined, digits = 0) =>
  v == null
    ? '—'
    : v.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Карточка показателя во вкладке «Метрики»: подпись заглавными слева, значение справа, график ниже. */
function MetricCard({
  title,
  sub,
  right,
  children,
}: {
  title: string;
  sub?: string;
  right: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-2xl border border-border bg-surface px-[18px] pt-4 pb-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[11.5px] font-semibold tracking-[0.08em] text-text-2 uppercase">{title}</h3>
          {sub && <p className="mt-[3px] text-[12px] text-text-3">{sub}</p>}
        </div>
        <div className="text-right font-heading text-[22px] leading-tight font-bold whitespace-nowrap tabular-nums">
          {right}
        </div>
      </div>
      {children}
    </section>
  );
}

/** Карточка во вкладке «Настройки»: подпись заглавными и содержимое. */
function SettingsCard({
  title,
  optional,
  children,
}: {
  title: string;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-2xl border border-border bg-surface px-[18px] py-4">
      <h3 className="mb-2.5 flex items-center gap-2 text-[11.5px] font-semibold tracking-[0.08em] text-text-2 uppercase">
        {title}
        {optional && (
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] font-semibold tracking-normal text-text-3 normal-case">
            Необязательно
          </span>
        )}
      </h3>
      {children}
    </section>
  );
}

function CopyField({ title, value, copy = false }: { title: string; value: string; copy?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="min-w-0 bg-surface px-4 py-3.5">
      <span className="text-[11px] font-semibold tracking-[0.08em] text-text-3 uppercase">{title}</span>
      <div className="mt-1.5 flex min-h-8 items-center justify-between gap-2.5">
        <span className="min-w-0 font-mono text-[13.5px] break-all">{value}</span>
        {copy && (
          <button
            type="button"
            aria-label={`Копировать: ${title}`}
            className="grid size-8 flex-none cursor-pointer place-items-center rounded-[9px] text-text-3 transition-colors hover:bg-surface-2 hover:text-brand focus-visible:outline-2 focus-visible:outline-brand"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value);
                setCopied(true);
                setTimeout(() => setCopied(false), 1800);
              } catch {
                // Буфер обмена недоступен (не HTTPS или запрет браузера): значение видно и так.
              }
            }}
          >
            {copied ? (
              <CheckIcon className="size-4 text-ok" aria-hidden="true" />
            ) : (
              <CopyIcon className="size-4" aria-hidden="true" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Окно ноды в устройстве 0.67.0 (витрина redesign-2026-10, вариант A): слева паспорт и действия, справа вкладки
 * в рамке, внизу полоса. Размер окна постоянный на всех вкладках — прокручивается только содержимое.
 */
export function NodeDialog({
  node,
  stale,
  onClose,
  initialTab,
}: {
  node: RemnawaveNode;
  stale: boolean;
  onClose: () => void;
  /** Совет «порт через Check-Host» открывает окно сразу на «Подключении». */
  initialTab?: NodeDialogTab;
}) {
  const navigate = useNavigate();
  const [range, setRange] = useState('60');
  const metrics = useNodeMetrics(Number(range));
  const points = metrics.data?.history.find((n) => n.uuid === node.uuid)?.points ?? [];
  const typical = metrics.data?.onlineTypicalByNode[node.uuid] ?? null;
  const [tab, setTab] = useState<NodeDialogTab>(initialTab ?? 'metrics'),
    [tcpRun, setTcpRun] = useState(0),
    query = useNodePreferences(node.uuid),
    save = useSaveNodePreferences(node.uuid),
    assign = useAssignNodeProvider(node.uuid),
    status = useNodes(),
    monitoring = useMonitoring();
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
  const whitelist = form?.whitelist ?? node.whitelist ?? false;
  const domain = status.data?.domain ?? null;
  const edit = (patch: Partial<NodePreferences>) => {
    if (!form) return;
    setForm({ ...form, ...patch });
    setDirty(true);
    setSaved(false);
  };
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
    } catch {
      // Ошибка показана под полями: save.error и assign.error.
    }
  }
  const dot =
    stale || state.tone === 'muted'
      ? 'bg-text-3'
      : state.tone === 'crit'
        ? 'bg-crit shadow-[0_0_0_4px_var(--ns-crit-soft)]'
        : state.tone === 'warn'
          ? 'bg-warn shadow-[0_0_0_4px_var(--ns-warn-soft)]'
          : 'bg-ok shadow-[0_0_0_4px_var(--ns-ok-soft)]';
  const mbit = (v: number | null) => (v == null ? null : (v * 8) / 1_000_000);
  const loadNow = node.loadAverage?.[0] ?? null;
  const ask = {
    context: { kind: 'node' as const, id: node.uuid },
    label: `Нода: ${node.name}`,
    question: `Что с ${node.name} и что проверить?`,
    placeholder: 'Спросите про эту ноду…',
  };
  const checker = whitelist
    ? { to: '/integrations/bschecker' as const, icon: '/integration-icons/bschecker.svg', name: 'BS Checker' }
    : { to: '/integrations/dpi' as const, icon: '/integration-icons/dpi.ico', name: 'DPI Checker' };
  const runTcp = () => {
    setTab('connection');
    setTcpRun((n) => n + 1);
  };
  const openChecker = () => {
    onClose();
    void navigate({ to: checker.to, search: { node: node.uuid } });
  };
  const actions = (compact: boolean) => (
    <>
      <AskAssistant
        className={cn(
          SIDE_BTN,
          'border-ai/40 bg-ai-soft text-ai hover:bg-ai-soft hover:text-ai',
          compact && 'w-auto',
        )}
        target={ask}
        onOpenNode={(uuid, next) => {
          if (uuid === node.uuid && next) setTab(next);
        }}
      />
      <button type="button" onClick={runTcp} className={cn(SIDE_BTN, compact && 'w-auto')}>
        <RadarIcon aria-hidden="true" />
        Проверить порт · Check-Host
      </button>
      <button type="button" onClick={openChecker} className={cn(SIDE_BTN, compact && 'w-auto')}>
        <img src={checker.icon} alt="" className="rounded-[3px]" />
        Проверить в {checker.name}
      </button>
      {domain && (
        <a
          href={`https://${domain}`}
          target="_blank"
          rel="noreferrer"
          className={cn(SIDE_BTN, compact && 'w-auto')}
        >
          <ExternalLinkIcon aria-hidden="true" />
          Открыть Remnawave
        </a>
      )}
    </>
  );
  const pills = (
    <>
      <Pill tone={stale ? 'muted' : state.tone}>{stale ? 'Старый снимок' : state.label}</Pill>
      {whitelist && <WhitelistBadge />}
      {node.xrayVersion && <Pill>Xray {node.xrayVersion}</Pill>}
    </>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          'grid h-[min(780px,calc(100dvh-48px))] w-[min(1180px,calc(100vw-40px))] grid-cols-[290px_minmax(0,1fr)] gap-0 overflow-hidden rounded-[18px] border border-border-2 bg-surface p-0 shadow-float sm:max-w-[1180px]',
          // Телефон: лист на весь экран, паспорт — шапкой сверху.
          'max-md:top-0 max-md:left-0 max-md:h-dvh max-md:w-screen max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:grid-cols-1 max-md:rounded-none max-md:border-0',
        )}
        overlayClassName="bg-black/45 backdrop-blur-sm"
      >
        <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto border-r border-border bg-bg-2 px-5 py-[22px] max-md:hidden">
          <div>
            <div className="flex min-w-0 items-center gap-2.5">
              <span className={cn('size-2 flex-none rounded-full', dot)} aria-hidden="true" />
              {node.countryCode && <CountryFlag code={node.countryCode} size="md" />}
              <DialogTitle className="min-w-0 truncate font-heading text-[20px] font-bold tracking-[-0.01em]">
                {node.name}
              </DialogTitle>
            </div>
            <DialogDescription className="sr-only">
              Нода {node.name}: метрики, подключение, настройки и сценарии
            </DialogDescription>
            <div className="mt-2.5 flex flex-wrap gap-1.5">{pills}</div>
          </div>
          <dl className="m-0 flex flex-col gap-[13px]">
            {[
              [
                'Адрес и порт',
                <span
                  key="a"
                  className="font-mono break-all"
                >{`${node.address}${node.port ? `:${node.port}` : ''}`}</span>,
              ],
              [
                'Провайдер',
                <span key="p" className="flex items-center gap-2">
                  <RemnaProviderIcon
                    src={node.providerIcon}
                    name={node.providerName ?? '?'}
                    className="size-5 rounded-[5px] [&_img]:size-3.5"
                  />
                  {node.providerName || 'Не указан'}
                </span>,
              ],
              [
                'Процессор',
                <span key="c">
                  {node.cpuCount ? `${node.cpuCount} ${plural(node.cpuCount, 'ядро', 'ядра', 'ядер')}` : '—'}
                  {node.cpuModel && <small className="block text-[12px] text-text-3">{node.cpuModel}</small>}
                </span>,
              ],
              ['Память', node.memoryTotalBytes ? `${bytes(node.memoryTotalBytes)} RAM` : '—'],
              ['Время работы', uptime(node.uptime)],
              ['Версии', `Xray ${node.xrayVersion ?? '—'} · Node ${node.nodeVersion ?? '—'}`],
              [
                'Трафик за всё время',
                `${bytes(node.trafficUsedBytes)} · ${node.trafficLimitBytes ? `лимит ${bytes(node.trafficLimitBytes)}` : 'без лимита'}`,
              ],
            ].map(([title, value]) => (
              <div key={String(title)}>
                <dt className="mb-[3px] text-[11.5px] text-text-3">{title}</dt>
                <dd className="m-0 text-[13.5px] leading-snug">{value}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-auto flex flex-col gap-2 border-t border-border pt-4">{actions(false)}</div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-col">
          {/* Телефон: паспорт коротко и действия лентой. */}
          <div className="hidden flex-none border-b border-border bg-bg-2 px-4 pt-3 pb-3 max-md:block">
            <div className="flex items-center gap-2.5">
              <span className={cn('size-2 flex-none rounded-full', dot)} aria-hidden="true" />
              {node.countryCode && <CountryFlag code={node.countryCode} size="md" />}
              <span className="min-w-0 flex-1 truncate font-heading text-[17px] font-bold">{node.name}</span>
              <button
                type="button"
                onClick={onClose}
                aria-label="Закрыть окно"
                className="grid size-9 flex-none place-items-center rounded-[10px] border border-border bg-surface-2 text-text-2"
              >
                <XIcon className="size-4" aria-hidden="true" />
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">{pills}</div>
            <div className="mt-2.5 flex gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none]">
              {actions(true)}
            </div>
          </div>

          <div className="flex flex-none items-center gap-3 border-b border-border py-4 pr-[18px] pl-[22px] max-md:px-3 max-md:py-2.5">
            <div
              role="tablist"
              aria-label="Разделы ноды"
              className="flex min-w-0 gap-[3px] overflow-x-auto rounded-[12px] border border-border bg-surface-2 p-[3px] [scrollbar-width:none]"
            >
              {TABS.map(([id, name, Icon], index) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`node-tab-${id}`}
                  aria-controls={`node-panel-${id}`}
                  aria-selected={tab === id}
                  tabIndex={tab === id ? 0 : -1}
                  onKeyDown={(e) => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
                    e.preventDefault();
                    const at =
                      e.key === 'Home'
                        ? 0
                        : e.key === 'End'
                          ? TABS.length - 1
                          : (index + (e.key === 'ArrowLeft' ? TABS.length - 1 : 1)) % TABS.length;
                    const next = TABS[at]?.[0] ?? 'metrics';
                    setTab(next);
                    document.getElementById(`node-tab-${next}`)?.focus();
                  }}
                  onClick={() => setTab(id)}
                  className={cn(
                    'inline-flex flex-none cursor-pointer items-center gap-[7px] rounded-[9px] px-4 py-2 text-[13.5px] whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-brand max-md:px-2.5 max-md:text-[13px]',
                    tab === id
                      ? 'bg-surface font-semibold text-foreground shadow-[0_0_0_1px_var(--ns-border-2)]'
                      : 'text-text-3 hover:text-foreground',
                  )}
                >
                  <Icon className="size-4 max-md:hidden" aria-hidden="true" />
                  {name}
                </button>
              ))}
            </div>
            <span className="flex-1" />
            <button
              type="button"
              onClick={onClose}
              aria-label="Закрыть окно"
              className="grid size-9 flex-none cursor-pointer place-items-center rounded-[10px] border border-border bg-surface-2 text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground max-md:hidden"
            >
              <XIcon className="size-4" aria-hidden="true" />
            </button>
          </div>

          <div
            role="tabpanel"
            id={`node-panel-${tab}`}
            aria-labelledby={`node-tab-${tab}`}
            className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-[22px] py-5 [scrollbar-gutter:stable] max-md:px-3.5 max-md:py-3.5"
          >
            {stale && (
              <p className="rounded-[10px] bg-warn-soft px-3.5 py-2.5 text-[12.5px] text-warn">
                Нет свежего ответа Remnawave. Показано последнее полученное состояние.
              </p>
            )}
            {tab === 'metrics' ? (
              <>
                {!node.isConnected && node.lastStatusMessage && (
                  <p className="rounded-[10px] bg-crit-soft px-3.5 py-2.5 text-[12.5px] text-crit">
                    {node.lastStatusMessage}
                  </p>
                )}
                <div className="flex flex-wrap items-center justify-between gap-2.5">
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
                  <span className="text-[12px] text-text-3">
                    обновляется каждые 15 с · замер раз в минуту
                  </span>
                </div>
                {metrics.isError && (
                  <p role="alert" className="text-[12.5px] text-crit">
                    {apiErrorMessage(metrics.error)}
                  </p>
                )}
                <MetricCard
                  title="Онлайн ноды"
                  sub="пользователи на ноде прямо сейчас"
                  right={
                    <span className="flex gap-[26px]">
                      <span>
                        <span className="block font-sans text-[10.5px] font-semibold tracking-[0.08em] text-text-3 uppercase">
                          Сейчас
                        </span>
                        {num(node.usersOnline)}
                      </span>
                      {typical && (
                        <span>
                          <span className="block font-sans text-[10.5px] font-semibold tracking-[0.08em] text-text-3 uppercase">
                            Обычно
                          </span>
                          {num(typical.low)}–{num(typical.high)}
                        </span>
                      )}
                    </span>
                  }
                >
                  <MetricArea
                    loading={metrics.isPending}
                    times={points.map((p) => p.t)}
                    series={[
                      {
                        key: 'online',
                        name: 'Онлайн',
                        color: 'var(--ns-accent)',
                        values: points.map((p) => p.online),
                      },
                    ]}
                  />
                </MetricCard>
                <div className="grid gap-3.5 md:grid-cols-2">
                  <MetricCard
                    title="Процессор · нагрузка"
                    right={
                      <>
                        {num(loadNow, 2)}
                        <small className="font-sans text-[12px] font-medium text-text-3">
                          {node.cpuCount
                            ? ` из ${node.cpuCount} ${plural(node.cpuCount, 'ядра', 'ядер', 'ядер')}`
                            : ''}
                        </small>
                      </>
                    }
                  >
                    <div className="mt-2.5">
                      <LoadBar value={loadPerCore(node)} />
                    </div>
                    <MetricArea
                      loading={metrics.isPending}
                      height={130}
                      times={points.map((p) => p.t)}
                      format={(v) => num(v, 2)}
                      yMin={0}
                      series={[
                        {
                          key: 'load',
                          name: 'Нагрузка',
                          color: 'var(--ns-accent)',
                          values: points.map((p) => p.load),
                        },
                      ]}
                    />
                  </MetricCard>
                  <MetricCard title="Память" right={ram(node) == null ? '—' : `${num(ram(node), 1)} %`}>
                    <div className="mt-2.5">
                      <LoadBar value={ram(node)} />
                    </div>
                    <MetricArea
                      loading={metrics.isPending}
                      height={130}
                      unit=" %"
                      yMin={0}
                      yMax={100}
                      times={points.map((p) => p.t)}
                      series={[
                        {
                          key: 'ram',
                          name: 'Память',
                          color: 'var(--ns-ok)',
                          values: points.map((p) => p.ram),
                        },
                      ]}
                    />
                  </MetricCard>
                </div>
                <MetricCard
                  title="Сеть"
                  right={
                    <>
                      <span className="text-brand">↓</span>
                      {mbitPerSecond(node.rxBytesPerSec)} · <span className="text-teal">↑</span>
                      {mbitPerSecond(node.txBytesPerSec)}
                      <small className="font-sans text-[12px] font-medium text-text-3"> Мбит/с</small>
                    </>
                  }
                >
                  <MetricArea
                    loading={metrics.isPending}
                    height={140}
                    unit=" Мбит/с"
                    yMin={0}
                    times={points.map((p) => p.t)}
                    series={[
                      {
                        key: 'rx',
                        name: 'Приём',
                        color: 'var(--ns-accent)',
                        values: points.map((p) => mbit(p.rx)),
                      },
                      {
                        key: 'tx',
                        name: 'Отдача',
                        color: 'var(--ns-teal)',
                        values: points.map((p) => mbit(p.tx)),
                      },
                    ]}
                  />
                </MetricCard>
              </>
            ) : tab === 'connection' ? (
              <>
                <NodeTcpCheck uuid={node.uuid} runToken={tcpRun} />
                <section className="grid gap-px overflow-hidden rounded-[14px] border border-border bg-border sm:grid-cols-2">
                  <CopyField title="Адрес / IP" value={node.address} copy />
                  <CopyField title="Порт ноды" value={node.port?.toString() ?? 'Не передан'} />
                  <CopyField title="Идентификатор ноды" value={node.uuid} copy />
                  <CopyField title="Панель Remnawave" value={domain ?? '—'} copy={Boolean(domain)} />
                </section>
                <p className="text-[12.5px] text-text-3">
                  Ключ API хранится зашифрованным. Изменить его можно в «Настроить подключение» на странице
                  «Ноды».
                </p>
              </>
            ) : tab === 'scenarios' ? (
              <NodeScenarios uuid={node.uuid} />
            ) : query.isPending || !form ? (
              query.isError ? (
                <p role="alert" className="text-[12.5px] text-crit">
                  {apiErrorMessage(query.error)}
                </p>
              ) : (
                <FormSkeleton />
              )
            ) : (
              <form id="node-settings-form" onSubmit={submit} className="flex flex-col gap-3.5">
                <fieldset
                  disabled={save.isPending || assign.isPending}
                  className="m-0 flex flex-col gap-3.5 border-0 p-0"
                >
                  <div className="flex items-start gap-2.5 rounded-[12px] border border-border border-l-[3px] border-l-brand bg-surface-2 px-3.5 py-3 text-[13px] leading-relaxed text-text-2">
                    <InfoIcon className="mt-0.5 size-4 flex-none text-brand" aria-hidden="true" />
                    <span>
                      <b className="text-foreground">Зачем.</b> Ассистент и мониторинг читают эти настройки:
                      какие проверки советовать, когда предупреждать, сколько выдержит канал. На саму ноду в
                      Remnawave влияет только провайдер.
                    </span>
                  </div>
                  <SettingsCard title="Тип ноды" optional>
                    <label
                      className={cn(
                        'flex w-full cursor-pointer items-start gap-3 rounded-[14px] border px-4 py-3.5 text-left transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand has-[:disabled]:cursor-default',
                        form.whitelist
                          ? 'border-teal/55 bg-teal/[0.07]'
                          : 'border-border bg-surface hover:border-border-2',
                      )}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={form.whitelist}
                        onChange={(e) => edit({ whitelist: e.target.checked })}
                      />
                      <span
                        aria-hidden="true"
                        className={cn(
                          'mt-px grid size-5 flex-none place-items-center rounded-[6px] border-[1.5px] transition-colors',
                          form.whitelist
                            ? 'border-transparent bg-teal text-bg'
                            : 'border-border-2 text-transparent',
                        )}
                      >
                        <CheckIcon className="size-[13px]" strokeWidth={3} />
                      </span>
                      <span>
                        <span className="block text-[14px] font-semibold">Сервер белого списка (БС)</span>
                        <span className="mt-1 block text-[12.5px] leading-normal text-text-2">
                          IP ноды входит в белые списки мобильных операторов. Ассистент будет советовать BS
                          Checker с точками, где включён белый список. Без отметки нода обычная: Ассистент
                          советует Check-Host и DPI Checker.
                        </span>
                      </span>
                    </label>
                  </SettingsCard>
                  <div className="grid gap-3.5 md:grid-cols-2">
                    <SettingsCard title="Провайдер">
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
                            setSaved(false);
                          }}
                          disabled={assign.isPending || save.isPending}
                        />
                      </ProvidersSourceContext.Provider>
                      <p className="mt-2 text-[12px] text-text-3">Меняется и в Remnawave при сохранении.</p>
                      {assign.isError && (
                        <p role="alert" className="mt-2 text-[12px] text-crit">
                          {apiErrorMessage(assign.error)}
                        </p>
                      )}
                    </SettingsCard>
                    <SettingsCard title="Канал" optional>
                      <label htmlFor="node-channel" className={label}>
                        Лимит канала провайдера, Мбит/с
                      </label>
                      <Input
                        id="node-channel"
                        type="number"
                        min={1}
                        max={1000000}
                        className="h-10"
                        value={form.channelMbps ?? ''}
                        placeholder="Например, 1000"
                        onChange={(e) =>
                          edit({ channelMbps: e.target.value ? Number(e.target.value) : null })
                        }
                      />
                      <p className="mt-2 text-[12px] text-text-3">
                        Нужен для вкладки «Ёмкость»: сколько ещё выдержит нода. Пусто — лимит неизвестен.
                      </p>
                    </SettingsCard>
                  </div>
                  <SettingsCard title="Предупреждения о нагрузке" optional>
                    <p className="-mt-1 mb-3 text-[12px] text-text-3">
                      Пустое поле — общий порог из «Мониторинга нод». При устойчивом превышении мониторинг
                      создаст событие, если предупреждения включены.
                    </p>
                    <div className="grid gap-3.5 sm:grid-cols-2">
                      {(
                        [
                          ['cpuWarningPercent', 'Процессор выше, %', monitoring.data?.cpuPercent],
                          ['memoryWarningPercent', 'Память выше, %', monitoring.data?.memoryPercent],
                        ] as const
                      ).map(([key, title, common]) => (
                        <div key={key}>
                          <label htmlFor={key} className={label}>
                            {title}
                          </label>
                          <Input
                            id={key}
                            type="number"
                            min={1}
                            max={100}
                            className="h-10"
                            placeholder={common ? `Общий порог · ${common}` : 'Общий порог'}
                            value={form[key] ?? ''}
                            onChange={(e) =>
                              edit({ [key]: e.target.value === '' ? null : Number(e.target.value) })
                            }
                          />
                        </div>
                      ))}
                    </div>
                    <p className="mt-2.5 text-[12px] text-text-3">
                      Процент процессора Remnawave сейчас не передаёт, поэтому предупреждение о процессоре не
                      срабатывает. Нагрузку на ядро видно на вкладке «Метрики» и в «Ёмкости».
                    </p>
                  </SettingsCard>
                  <SettingsCard title="Заметка" optional>
                    <textarea
                      id="node-note"
                      aria-label="Заметка о ноде"
                      value={form.note}
                      maxLength={1000}
                      rows={3}
                      onChange={(e) => edit({ note: e.target.value })}
                      className="w-full rounded-[11px] border border-border bg-surface-2 px-3.5 py-2.5 text-[13.5px] outline-none focus:border-brand"
                      placeholder="Например: мост для Польши, оплачен до 30 октября"
                    />
                  </SettingsCard>
                  {save.isError && (
                    <p role="alert" className="text-[12.5px] text-crit">
                      {apiErrorMessage(save.error)}
                    </p>
                  )}
                </fieldset>
              </form>
            )}
          </div>

          <div className="flex h-[68px] flex-none items-center justify-between gap-3.5 border-t border-border bg-bg-2 px-[22px] max-md:h-auto max-md:px-3.5 max-md:py-3">
            <span className="min-w-0 flex-1 text-[12.5px] text-text-3 max-sm:hidden">
              {tab === 'settings'
                ? saved
                  ? 'Сохранено'
                  : 'Провайдер сохранится и в Remnawave, остальное — в панели'
                : 'Данные Remnawave · обновление каждые 15 секунд'}
            </span>
            {tab === 'settings' ? (
              <DialogPrimaryButton
                form="node-settings-form"
                type="submit"
                disabled={!form || save.isPending || assign.isPending || (!dirty && !providerDirty)}
              >
                Сохранить
              </DialogPrimaryButton>
            ) : (
              status.data?.checkedAt && (
                <span className="text-[12.5px] text-text-3 tabular-nums">
                  Последний замер {new Date(status.data.checkedAt).toLocaleTimeString('ru-RU')}
                </span>
              )
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
