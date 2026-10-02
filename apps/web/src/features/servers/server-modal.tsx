import { AGENT_STATUS_LABELS, isExitOnly, type MetricRange, type Server } from '@nodeservice/shared';
import {
  ChevronDownIcon,
  CopyPlusIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  TerminalIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DialogPrimaryButton } from '@/components/dialog-actions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Field } from '@/features/auth/components/field';
import { PasswordField } from '@/features/auth/components/password-field';
import { ServerBillingFact, useServerBilling } from '@/features/billing/billing-pill';
import { useOverviewMetrics } from '@/features/overview/overview-api';
import { ProviderIcon } from '@/features/providers/provider-icon';
import { ProviderSelect } from '@/features/providers/provider-select';
import { useProviders } from '@/features/providers/providers-api';
import { formatAgo } from '@/features/security/security-format';
import { StepUpCancelledError } from '@/features/security/step-up';
import { useTerminalStore } from '@/features/terminal/terminal-store';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { useMediaQuery } from '@/lib/use-media';
import { cn } from '@/lib/utils';
import { AgentInstallDialog } from './agent-install-dialog';
import { AgentWhy, agentSilent, EgressDetails, panelCut, useEgress } from './agent-why';
import { CountryField } from './country-field';
import { AgentPill, HealthDot, osLine, SshPill } from './server-card';
import { ChecksTab } from './server-detail/checks-tab';
import { InstallTab } from './server-detail/install-tab';
import { JournalTab } from './server-detail/journal-tab';
import { MaintenanceTab } from './server-detail/maintenance-tab';
import { MetricsTab } from './server-detail/metrics-tab';
import { ProfileTab } from './server-detail/profile-tab';
import { TerminalHistoryTab } from './server-detail/terminal-history-tab';
import { AUTH_TABS, type ServerEdit, useServerEdit } from './server-detail/use-server-edit';
import { serverState } from './server-health';
import { useCheckServer, useDeleteServer, useDuplicateServer, useServers } from './servers-api';
import { splitTagList, TagInput, useTagCounts } from './tag-input';

export type ServerModalTab =
  | 'metrics'
  | 'journal'
  | 'terminal'
  | 'maintenance'
  | 'checks'
  | 'profile'
  | 'connection'
  | 'install';

const TABS: Array<{ key: ServerModalTab; label: string }> = [
  { key: 'metrics', label: 'Метрики' },
  { key: 'journal', label: 'Журнал' },
  { key: 'terminal', label: 'Терминал' },
  { key: 'maintenance', label: 'Обслуживание' },
  { key: 'checks', label: 'Проверки' },
  { key: 'install', label: 'Установка' },
  { key: 'profile', label: 'Профиль' },
  { key: 'connection', label: 'Подключение' },
];

interface Props {
  server: Server | null;
  initialTab: ServerModalTab;
  onClose: () => void;
}

/** Аптайм из секунд: «41 д 3 ч», «5 ч 12 мин», «17 мин». */
function formatUptime(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—';
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} д ${h} ч`;
  if (h > 0) return `${h} ч ${m} мин`;
  return `${m} мин`;
}

function routeHost(route: string | null): string | null {
  if (!route) return null;
  try {
    return new URL(route).host;
  } catch {
    return route;
  }
}

/** Выбранный вариант A: фактический канал одной спокойной строкой прямо под состоянием агента. */
function AgentFact({ server, noPanel }: { server: Server; noPanel: boolean }) {
  const status = noPanel
    ? 'Нет связи с панелью'
    : server.agentVersion
      ? `${AGENT_STATUS_LABELS[server.agentStatus]} · ${server.agentVersion.startsWith('v') ? server.agentVersion : `v${server.agentVersion}`}`
      : AGENT_STATUS_LABELS[server.agentStatus];
  const showRoute = server.agentStatus === 'online' && server.agentTransport;
  const fallback = server.agentRouteFallback === true;
  const host = routeHost(server.agentRoute);
  return (
    <span className="block min-w-0">
      <span className={cn('block', noPanel && 'font-semibold text-warn')}>{status}</span>
      {showRoute && (
        <span
          data-testid="agent-route"
          className={cn(
            'mt-1 block truncate text-[11.5px] leading-[1.4] font-normal text-text-3',
            fallback && 'text-warn',
          )}
          title={server.agentRoute ?? undefined}
        >
          <span className="font-semibold">
            {server.agentTransport === 'https' ? 'HTTPS' : 'WebSocket'} ·{' '}
            {fallback ? 'запасной вход' : 'основной вход'}
          </span>
          {host && (
            <>
              <br />
              {host}
            </>
          )}
        </span>
      )}
    </span>
  );
}

const SIDE_BTN =
  'h-9 w-full justify-start rounded-[10px] border-border bg-surface-2 px-3 text-[12.5px] font-medium text-text-2 hover:bg-surface-3 hover:text-foreground';

/**
 * Окно сервера в две панели: слева факты и действия (всегда на месте), справа вкладки
 * «Метрики / Журнал / Подключение». На телефоне панели встают друг под другом.
 * Перемонтируется при смене сервера: несохранённые правки другого сервера не переезжают.
 */
export function ServerModal({ server, ...rest }: Props) {
  return server ? <ServerModalView key={server.id} server={server} {...rest} /> : null;
}

/** Вкладки, где что-то меняют: у них общая панель «Сохранить» внизу. */
const EDIT_TABS: ReadonlySet<ServerModalTab> = new Set(['profile', 'connection']);

/** Где Escape свой и окно сервера не закрывает: маленькие поля вкладок и окно терминала. */
const ESCAPE_LOCAL = '[data-escape-local], [data-terminal-window]';

function ServerModalView({ server: s, initialTab, onClose }: Props & { server: Server }) {
  const check = useCheckServer();
  const duplicate = useDuplicateServer();
  const remove = useDeleteServer();
  const overview = useOverviewMetrics();
  const openTerminal = useTerminalStore((st) => st.open);
  const [tab, setTab] = useState<ServerModalTab>(initialTab);
  const [range, setRange] = useState<MetricRange>('1h');
  const [installOpen, setInstallOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const egress = useEgress(s);
  const noPanel = agentSilent(s) && panelCut(egress.data?.report);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  // Телефон — своя раскладка (вариант 1 витрины): шапка + вкладки сверху, факты свёрнуты,
  // действия в нижней панели. В jsdom matchMedia нет — считаем, что не телефон.
  const phone = useMediaQuery('(max-width: 767px)', false);
  const providers = useProviders();
  const fleet = useServers();
  // Правки «Профиля» и «Подключения» живут здесь: переход между вкладками их не сбрасывает.
  const edit = useServerEdit(s, () => setTab('connection'));
  const tabDirty: Partial<Record<ServerModalTab, boolean>> = {
    profile: edit.profile.dirty,
    connection: edit.connection.dirty,
  };
  // Крестик, клик мимо и Escape спрашивают подтверждение, если есть несохранённое: иначе правки на
  // обеих вкладках («Профиль» и «Подключение») молча терялись бы при случайном закрытии.
  const dirtyTabLabels = TABS.filter((t) => tabDirty[t.key]).map((t) => `«${t.label}»`);
  const requestClose = () => (edit.dirty ? setCloseConfirmOpen(true) : onClose());

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);
  const metrics = overview.data?.servers.find((m) => m.serverId === s.id) ?? null;
  // Точка со своей причиной: красная у остановленной ноды не должна оставаться без объяснения.
  const { health, reason } = serverState(s, metrics);
  const resources = [
    s.facts.cpuCores ? `${s.facts.cpuCores} CPU` : null,
    s.facts.memoryMb ? `${Math.round(s.facts.memoryMb / 1024)} ГБ RAM` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const doCheck = async () => {
    try {
      await check.mutateAsync(s.id);
      toast.success(`${s.name}: связь работает. Данные о системе обновлены.`);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };
  const doDuplicate = async () => {
    try {
      const copy = await duplicate.mutateAsync(s.id);
      toast.success(`Создана копия «${copy.name}».`);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };
  const doDelete = async () => {
    try {
      await remove.mutateAsync(s.id);
      setDeleteOpen(false);
      onClose();
      toast.success(`Сервер «${s.name}» удалён.`);
    } catch (err) {
      setDeleteOpen(false);
      if (!(err instanceof StepUpCancelledError)) toast.error(apiErrorMessage(err));
    }
  };

  const billing = useServerBilling(s.id);
  const up = isExitOnly(s.profile.roles) ? s.profile.upstream : null;
  const upstreamFact: ReactNode = up ? (
    <span key="u" className="block whitespace-normal">
      <span className={up.kind === 'rent' ? 'font-mono text-[12.5px]' : undefined}>
        {up.kind === 'rent'
          ? up.address
          : (fleet.data?.items.find((x) => x.id === up.serverId)?.name ?? 'мост удалён')}
      </span>
      <span className="block text-[12px] font-normal text-text-3">
        {up.kind === 'rent' ? `вход арендодателя${up.owner ? ` · ${up.owner}` : ''}` : 'свой мост'}
      </span>
    </span>
  ) : null;
  const provider = s.providerId ? (providers.data?.items.find((p) => p.id === s.providerId) ?? null) : null;
  const facts: Array<[string, ReactNode]> = [
    [
      'Адрес',
      <span
        key="a"
        className="font-mono text-[12.5px] font-medium break-all"
      >{`${s.sshUser}@${s.host}:${s.port}`}</span>,
    ],
    ['Система', osLine(s)],
    ...(provider
      ? ([
          [
            'Провайдер',
            <span key="p" className="flex items-center gap-1.5">
              <ProviderIcon provider={provider} size="sm" />
              <span className="truncate">{provider.name}</span>
            </span>,
          ],
        ] as Array<[string, ReactNode]>)
      : []),
    ...(upstreamFact ? ([['Вход', upstreamFact]] as Array<[string, ReactNode]>) : []),
    ...(billing
      ? ([['Оплата', <ServerBillingFact key="b" serverId={s.id} />]] as Array<[string, ReactNode]>)
      : []),
    ['Ресурсы', resources || '—'],
    ['Аптайм', formatUptime(metrics?.uptimeSec)],
    ['Проверка SSH', s.lastSshCheckAt ? formatAgo(s.lastSshCheckAt) : 'Ещё не было'],
    ['Агент', <AgentFact key="agent" server={s} noPanel={noPanel} />],
  ];

  const content = (
    <>
      {whyOpen && agentSilent(s) && <EgressDetails server={s} />}
      {tab === 'metrics' && (
        <MetricsTab
          serverId={s.id}
          range={range}
          onRange={setRange}
          agentOnline={s.agentStatus === 'online'}
        />
      )}
      {tab === 'journal' && <JournalTab serverId={s.id} />}
      {tab === 'terminal' && <TerminalHistoryTab serverId={s.id} />}
      {tab === 'maintenance' && <MaintenanceTab server={s} />}
      {tab === 'checks' && <ChecksTab server={s} />}
      {tab === 'install' && <InstallTab server={s} />}
      {tab === 'profile' && <ProfileTab server={s} edit={edit.profile} />}
      {tab === 'connection' && <ConnectionTab server={s} edit={edit} />}
    </>
  );
  const dialogs = (
    <>
      <AgentInstallDialog server={s} open={installOpen} onOpenChange={setInstallOpen} />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        kind="crit"
        title={`Удалить «${s.name}»?`}
        description="Сервер пропадёт из панели вместе с историей проверок. Сам сервер и то, что на нём установлено, не трогаем."
        yesLabel="Да, удалить"
        loading={remove.isPending}
        onConfirm={doDelete}
      />
      <ConfirmDialog
        open={closeConfirmOpen}
        onOpenChange={setCloseConfirmOpen}
        kind="warn"
        title="Закрыть без сохранения?"
        description={`Несохранённые правки на ${dirtyTabLabels.length > 1 ? 'вкладках' : 'вкладке'} ${dirtyTabLabels.join(' и ')} пропадут.`}
        yesLabel="Да, закрыть"
        onConfirm={() => {
          setCloseConfirmOpen(false);
          onClose();
        }}
      />
    </>
  );
  const tabsBar = (
    <fieldset
      className={cn(
        'm-0 flex h-10 min-w-0 items-center overflow-x-auto rounded-[11px] border border-border bg-surface-2 p-[3px] [scrollbar-width:none]',
        phone && 'h-9 w-full overflow-x-auto [scrollbar-width:none]',
      )}
    >
      <legend className="sr-only">Разделы сервера</legend>
      {TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          aria-pressed={tab === t.key}
          onClick={() => setTab(t.key)}
          className={cn(
            'h-full flex-none cursor-pointer rounded-[8px] px-3 text-[13px] font-semibold whitespace-nowrap text-text-3 transition-colors hover:text-foreground',
            phone && 'px-3',
            tab === t.key && 'bg-surface text-foreground shadow-[0_1px_0_var(--ns-hairline)]',
          )}
        >
          {t.label}
          {tabDirty[t.key] && (
            <span
              aria-hidden="true"
              title="Есть несохранённые изменения"
              className="ml-1.5 inline-block size-1.5 translate-y-[-2px] rounded-full bg-brand"
            />
          )}
        </button>
      ))}
    </fieldset>
  );
  const saveBar = EDIT_TABS.has(tab) ? <SaveBar edit={edit} tab={tab} /> : null;
  const closeButton = (
    <Button
      type="button"
      variant="outline"
      aria-label="Закрыть"
      onClick={requestClose}
      className="size-9 flex-none rounded-[10px] border-border bg-surface-2 p-0 text-text-2 hover:bg-surface-3 hover:text-foreground"
    >
      <XIcon className="size-4" aria-hidden="true" />
    </Button>
  );
  const pills = (
    <>
      <AgentPill server={s} />
      <SshPill server={s} />
      {s.drift.length > 0 && (
        <button
          type="button"
          data-testid="drift-pill"
          onClick={() => setTab('profile')}
          title="Показать, что не совпадает с ожидаемым"
          className="inline-flex h-[22px] flex-none cursor-pointer items-center gap-1.5 rounded-full bg-warn-soft px-2.5 text-[11.5px] font-semibold whitespace-nowrap text-warn transition-opacity hover:opacity-80"
        >
          <TriangleAlertIcon className="size-3" aria-hidden="true" />
          Расхождения: {s.drift.length}
        </button>
      )}
    </>
  );
  const factsList = (
    <dl className={cn('grid grid-cols-1 gap-x-4 gap-y-2.5', phone && 'grid-cols-2')}>
      {facts.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-[11px] text-text-3">{k}</dt>
          <dd className="mt-px truncate text-[13px] font-medium">{v}</dd>
        </div>
      ))}
      {s.tags.length > 0 && (
        <div className={cn('min-w-0', phone && 'col-span-2')}>
          <dt className="text-[11px] text-text-3">Теги</dt>
          <dd className="mt-1 flex flex-wrap gap-1">
            {s.tags.map((t) => (
              <span
                key={t}
                className="rounded-[6px] border border-border bg-surface-2 px-2 py-[2px] text-[11px] font-medium text-text-2"
              >
                {t}
              </span>
            ))}
          </dd>
        </div>
      )}
    </dl>
  );

  return (
    <Dialog open modal={false} onOpenChange={(o) => !o && requestClose()}>
      {/* Свой блюр-фон: в неблокирующем режиме Radix не рисует overlay, а плавающий терминал (z-90)
          должен оставаться кликабельным. Сам фон (z-40 — под контентом модалки z-50 и терминалом)
          закрывает модалку по клику, как привычный overlay; клики по терминалу/меню/селектам лежат
          выше фона и до него не доходят — поэтому модалку не роняют. */}
      {createPortal(
        <button
          type="button"
          aria-label="Закрыть"
          tabIndex={-1}
          onClick={requestClose}
          className="fixed inset-0 z-40 cursor-default bg-black/10 supports-backdrop-filter:backdrop-blur-xs"
        />,
        document.body,
      )}
      <DialogContent
        showCloseButton={false}
        // Escape в маленьком поле внутри вкладки закрывает только поле, а не всю карточку с несохранённым.
        // Escape в окне терминала принадлежит терминалу (vim, less, mc): карточку он не закрывает и не
        // спрашивает «Закрыть без сохранения?» — иначе следующий Enter «в терминал» выбросил бы правки.
        onEscapeKeyDown={(e) => {
          if (e.target instanceof HTMLElement && e.target.closest(ESCAPE_LOCAL)) e.preventDefault();
        }}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        className={cn(
          'grid h-[min(780px,calc(100vh-56px))] w-[min(1120px,calc(100vw-40px))] grid-cols-[260px_minmax(0,1fr)] gap-0 overflow-hidden rounded-2xl border-border-2 bg-surface p-0 shadow-float ring-1 ring-(--ns-hairline) sm:max-w-[1120px]',
          // Телефон: лист на весь экран без центрирования. 100dvh — видимая высота в Safari с адресной
          // строкой (100vh там больше экрана, и центрированное окно уезжало верхом за край).
          'max-md:top-0 max-md:left-0 max-md:h-dvh max-md:w-screen max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none max-md:border-0 max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)] max-md:grid-cols-1 max-md:grid-rows-[auto_minmax(0,1fr)_auto]',
        )}
      >
        {phone ? (
          <>
            {/* Шапка: имя и закрыть, статусы, вкладки — всё, что нужно, сразу на экране */}
            <div className="flex flex-col border-b border-border bg-bg-2">
              <DialogHeader className="flex flex-row items-center gap-2.5 space-y-0 px-4 pt-3 pb-2">
                <HealthDot health={health} label={reason} />
                <DialogTitle className="min-w-0 flex-1 truncate text-left font-heading text-[17px] font-bold tracking-[-0.01em]">
                  {s.name}
                </DialogTitle>
                <DialogDescription className="sr-only">
                  Сервер {s.name}: метрики, журнал и подключение
                </DialogDescription>
                {closeButton}
              </DialogHeader>
              <div className="flex items-center gap-1.5 overflow-x-auto px-4 pb-2.5 [scrollbar-width:none]">
                {pills}
                {s.tags.length > 0 && (
                  <span className="ml-auto flex-none pl-2 text-[11.5px] text-text-3">
                    {s.tags.join(' · ')}
                  </span>
                )}
              </div>
              <div className="px-4 pb-3">{tabsBar}</div>
            </div>

            {/* Содержимое вкладки; факты свёрнуты сверху, чтобы не съедать экран */}
            <div className="flex min-h-0 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                {agentSilent(s) && (
                  <div className="mb-3">
                    <AgentWhy server={s} open={whyOpen} onToggle={() => setWhyOpen((v) => !v)} />
                  </div>
                )}
                <details className="group mb-3 rounded-2xl border border-border bg-surface">
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-[13px] [&::-webkit-details-marker]:hidden">
                    <span className="font-semibold">Подробнее о сервере</span>
                    <span className="min-w-0 flex-1 truncate text-right text-[12px] text-text-3">
                      адрес, система, аптайм
                    </span>
                    <ChevronDownIcon
                      className="size-4 flex-none text-text-3 transition-transform group-open:rotate-180"
                      aria-hidden="true"
                    />
                  </summary>
                  <div className="border-t border-border px-4 py-3">{factsList}</div>
                </details>
                {content}
              </div>
              {saveBar}
            </div>

            {/* Нижняя панель действий: под большим пальцем */}
            <div className="flex gap-2 border-t border-border bg-surface px-3 py-2.5">
              <PhoneAction
                label="Терминал"
                aria-label="SSH-терминал"
                icon={<TerminalIcon className="size-[17px]" aria-hidden="true" />}
                primary
                onClick={() =>
                  openTerminal({ id: s.id, name: s.name, host: s.host, port: s.port, sshUser: s.sshUser })
                }
              />
              <PhoneAction
                label="Проверить"
                icon={
                  <RefreshCwIcon
                    className={cn('size-[17px]', check.isPending && 'animate-spin')}
                    aria-hidden="true"
                  />
                }
                disabled={check.isPending}
                onClick={() => void doCheck()}
              />
              <PhoneAction
                label="Дублировать"
                icon={<CopyPlusIcon className="size-[17px]" aria-hidden="true" />}
                disabled={duplicate.isPending}
                onClick={() => void doDuplicate()}
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <PhoneAction
                    label="Ещё"
                    icon={<MoreHorizontalIcon className="size-[17px]" aria-hidden="true" />}
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="top" className="z-[60] min-w-[220px]">
                  <DropdownMenuItem onSelect={() => setInstallOpen(true)}>
                    <KeyRoundIcon className="size-4" aria-hidden="true" />
                    {s.agentStatus === 'not_installed' ? 'Установить агента' : 'Управление агентом'}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                    <Trash2Icon className="size-4" aria-hidden="true" />
                    Удалить сервер
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </>
        ) : (
          <>
            {/* Левая панель: состояние, факты, действия */}
            <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto border-r border-border bg-bg-2 p-5">
              <DialogHeader className="gap-1.5">
                <div className="flex items-center gap-2.5">
                  <HealthDot health={health} label={reason} />
                  <DialogTitle className="min-w-0 truncate font-heading text-[18px] font-bold tracking-[-0.01em]">
                    {s.name}
                  </DialogTitle>
                </div>
                <DialogDescription className="sr-only">
                  Сервер {s.name}: метрики, журнал и подключение
                </DialogDescription>
                <div className="flex flex-wrap items-center gap-1.5">{pills}</div>
              </DialogHeader>

              {factsList}
              <AgentWhy server={s} open={whyOpen} onToggle={() => setWhyOpen((v) => !v)} />

              <div className="mt-auto flex flex-col gap-1.5 border-t border-border pt-4">
                <Button
                  type="button"
                  variant="outline"
                  className={SIDE_BTN}
                  onClick={() =>
                    openTerminal({ id: s.id, name: s.name, host: s.host, port: s.port, sshUser: s.sshUser })
                  }
                >
                  <TerminalIcon className="size-4" aria-hidden="true" />
                  SSH-терминал
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={check.isPending}
                  onClick={() => void doCheck()}
                  className={SIDE_BTN}
                >
                  <RefreshCwIcon
                    className={cn('size-4', check.isPending && 'animate-spin')}
                    aria-hidden="true"
                  />
                  Проверить связь
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setInstallOpen(true)}
                  className={SIDE_BTN}
                >
                  <KeyRoundIcon className="size-4" aria-hidden="true" />
                  {s.agentStatus === 'not_installed' ? 'Установить агента' : 'Управление агентом'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={duplicate.isPending}
                  onClick={() => void doDuplicate()}
                  className={SIDE_BTN}
                >
                  <CopyPlusIcon className="size-4" aria-hidden="true" />
                  Дублировать
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDeleteOpen(true)}
                  className={cn(
                    SIDE_BTN,
                    'border-transparent bg-transparent text-crit hover:bg-crit-soft hover:text-crit',
                  )}
                >
                  <Trash2Icon className="size-4" aria-hidden="true" />
                  Удалить сервер
                </Button>
              </div>
            </aside>

            {/* Правая панель: вкладки и содержимое */}
            <div className="flex min-h-0 min-w-0 flex-col">
              <div className="flex flex-none items-center gap-3 border-b border-border px-5 py-3.5">
                {tabsBar}
                <div className="flex-1" />
                {closeButton}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{content}</div>
              {saveBar}
            </div>
          </>
        )}

        {dialogs}
      </DialogContent>
    </Dialog>
  );
}

/** Кнопка нижней панели на телефоне: иконка над подписью, одна ширина на всех. */
function PhoneAction({
  label,
  icon,
  primary,
  ...rest
}: { label: string; icon: ReactNode; primary?: boolean } & Omit<React.ComponentProps<'button'>, 'children'>) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        'flex h-12 flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-[12px] border text-[10.5px] font-medium transition-colors disabled:cursor-default disabled:opacity-50',
        primary
          ? 'border-transparent bg-brand text-(--ns-on-accent) hover:brightness-[1.07]'
          : 'border-border bg-surface-2 text-text-2 hover:bg-surface-3 hover:text-foreground',
        rest.className,
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * Панель «Сохранить» под вкладками «Профиль» и «Подключение»: вне прокрутки, поэтому видна всегда.
 * Сохраняет правки обеих вкладок одним запросом, откуда бы ни нажали.
 */
function SaveBar({ edit, tab }: { edit: ServerEdit; tab: ServerModalTab }) {
  const { connection: c, profile: p } = edit;
  const other = tab === 'profile' ? c.dirty : p.dirty;
  const hint = c.endpointChanged
    ? 'Смена адреса или пользователя сбросит отпечаток сервера: он запишется заново при первой проверке.'
    : c.authTab !== 'keep'
      ? 'Новые доступы проверяются настоящим подключением. Пароль не сохраняется.'
      : tab === 'connection'
        ? 'Название, теги и заметка на связь не влияют.'
        : 'Профиль читает Джарвис, на работу сервера он не влияет.';
  return (
    <div className="flex flex-none items-center gap-3 border-t border-border bg-surface px-4 py-3.5 max-sm:flex-col max-sm:items-stretch md:px-5">
      <div className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
        {edit.errors.form ? (
          <p role="alert" className="m-0 text-crit">
            {edit.errors.form}
          </p>
        ) : (
          <>
            {edit.dirty && (
              <p className="m-0 font-medium text-text-2">
                <span>Есть несохранённые изменения</span>
                {other && (
                  <span className="font-normal text-text-3">
                    {tab === 'profile' ? ' — и на вкладке «Подключение»' : ' — и на вкладке «Профиль»'}.
                    Сохранятся вместе.
                  </span>
                )}
              </p>
            )}
            <p className={cn('m-0', edit.dirty && 'max-sm:hidden')}>{hint}</p>
          </>
        )}
      </div>
      <div className="flex flex-none gap-2 max-sm:flex-row-reverse">
        {edit.dirty && (
          <Button
            type="button"
            variant="outline"
            disabled={edit.busy}
            onClick={edit.reset}
            className="h-10 rounded-[10px] px-4 max-sm:flex-1"
          >
            Отменить
          </Button>
        )}
        <DialogPrimaryButton
          type="button"
          disabled={!edit.dirty || edit.busy}
          onClick={() => void edit.save()}
          className="h-10 rounded-[10px] px-5 max-sm:max-w-none max-sm:flex-1 sm:max-w-[180px]"
        >
          {edit.busy && <Loader2Icon className="animate-spin" aria-hidden="true" />}
          Сохранить
        </DialogPrimaryButton>
      </div>
    </div>
  );
}

/** «Подключение»: общее и доступы SSH одним экраном; действия с сервером — в левой панели окна. */
function ConnectionTab({ server, edit }: { server: Server; edit: ServerEdit }) {
  const providers = useProviders();
  const tagCounts = useTagCounts(server.id);
  const {
    fields: form,
    setField,
    endpointChanged,
    countryPick,
    setCountryPick,
    authTab,
    setAuthTab,
    password,
    setPassword,
    privateKey,
    setPrivateKey,
    passphrase,
    setPassphrase,
  } = edit.connection;
  const errors = edit.errors;
  const set =
    (key: 'name' | 'host' | 'port' | 'sshUser' | 'tags' | 'notes') =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setField(key, e.target.value);
  const providerId = form.providerId;
  const busy = edit.busy;
  const chosenProvider = providerId ? (providers.data?.items.find((p) => p.id === providerId) ?? null) : null;

  return (
    <form
      // Enter в поле сохраняет всё, как кнопка «Сохранить» внизу окна.
      onSubmit={(e) => {
        e.preventDefault();
        void edit.save();
      }}
      noValidate
      className="mx-auto flex w-full max-w-[880px] flex-col gap-4"
    >
      {/* Общее */}
      <section className="rounded-2xl border border-border bg-surface-2/40 p-4">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h3 className="text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">Общее</h3>
          <span className="text-[12px] text-text-3">На связь не влияет</span>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="sm-name" label="Название" error={errors.name || undefined}>
            <Input
              id="sm-name"
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? 'sm-name-error' : undefined}
              value={form.name}
              onChange={set('name')}
              className="h-10 rounded-[10px] bg-surface-2"
            />
          </Field>
          <Field id="sm-tags" label="Теги" error={errors.tags || undefined}>
            <TagInput
              id="sm-tags"
              invalid={Boolean(errors.tags)}
              describedBy={errors.tags ? 'sm-tags-error' : undefined}
              value={splitTagList(form.tags)}
              onChange={(t) => setField('tags', t.join(', '))}
              counts={tagCounts}
            />
          </Field>
        </div>
      </section>

      {/* Хостинг: у кого куплен сервер и что важно помнить об оплате */}
      <section className="rounded-2xl border border-border bg-surface-2/40 p-4">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h3 className="text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">Хостинг</h3>
          <span className="text-[12px] text-text-3">Справочник — в меню «Серверы»</span>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-4">
            <Field id="sm-provider" label="Провайдер" error={errors.providerId || undefined}>
              <ProviderSelect
                id="sm-provider"
                value={providerId}
                disabled={busy}
                onChange={(id) => setField('providerId', id)}
                className="bg-surface-2"
              />
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium text-text-2">Сайт провайдера</span>
              {chosenProvider ? (
                <a
                  href={chosenProvider.siteUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex h-10 items-center gap-1.5 rounded-[10px] border border-border bg-surface-2 px-3 text-[13px] text-brand underline-offset-2 hover:underline"
                >
                  <ProviderIcon provider={chosenProvider} size="sm" />
                  <span className="truncate">{chosenProvider.siteHost}</span>
                  <ExternalLinkIcon className="size-3.5 flex-none" aria-hidden="true" />
                </a>
              ) : (
                <span className="inline-flex h-10 items-center rounded-[10px] border border-dashed border-border px-3 text-[12.5px] text-text-3">
                  появится после выбора провайдера
                </span>
              )}
            </div>
          </div>
          <CountryField
            id="sm-country"
            variant="server"
            country={server.country}
            picked={countryPick}
            onPick={setCountryPick}
            host={server.host}
            disabled={busy}
          />
        </div>
        <div className="mt-4">
          <Field id="sm-notes" label="Заметка" error={errors.notes || undefined}>
            <Input
              id="sm-notes"
              placeholder="Необязательно: срок оплаты, тариф, для чего сервер"
              aria-invalid={errors.notes ? true : undefined}
              aria-describedby={errors.notes ? 'sm-notes-error' : undefined}
              value={form.notes}
              onChange={set('notes')}
              className="h-10 rounded-[10px] bg-surface-2"
            />
          </Field>
        </div>
      </section>

      {/* Доступ по SSH */}
      <section className="rounded-2xl border border-border bg-surface-2/40 p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">Доступ по SSH</h3>
          <span className="text-[12px] text-text-3">
            {authTab !== 'keep'
              ? 'Новые доступы проверяются настоящим подключением, пароль не сохраняется'
              : endpointChanged
                ? 'Смена адреса или пользователя сбросит отпечаток сервера'
                : 'Адрес, пользователь и способ входа'}
          </span>
        </div>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_110px_200px]">
          <Field id="sm-host" label="IP или домен" error={errors.host || undefined}>
            <Input
              id="sm-host"
              aria-invalid={errors.host ? true : undefined}
              aria-describedby={errors.host ? 'sm-host-error' : undefined}
              value={form.host}
              onChange={set('host')}
              className="h-10 rounded-[10px] bg-surface-2 font-mono text-[13px]"
            />
          </Field>
          <Field id="sm-port" label="Порт" error={errors.port || undefined}>
            <Input
              id="sm-port"
              aria-invalid={errors.port ? true : undefined}
              aria-describedby={errors.port ? 'sm-port-error' : undefined}
              inputMode="numeric"
              value={form.port}
              onChange={set('port')}
              className="h-10 rounded-[10px] bg-surface-2 font-mono text-[13px]"
            />
          </Field>
          <Field id="sm-user" label="Пользователь SSH" error={errors.sshUser || undefined}>
            <Input
              id="sm-user"
              aria-invalid={errors.sshUser ? true : undefined}
              aria-describedby={errors.sshUser ? 'sm-user-error' : undefined}
              value={form.sshUser}
              onChange={set('sshUser')}
              className="h-10 rounded-[10px] bg-surface-2 font-mono text-[13px]"
            />
          </Field>
        </div>
        <div className="mt-4">
          <fieldset className="m-0 flex h-9 w-fit items-center rounded-[10px] border border-border bg-surface-2 p-[3px]">
            <legend className="sr-only">Доступы SSH</legend>
            {AUTH_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                aria-pressed={authTab === t.key}
                className={cn(
                  'h-full cursor-pointer rounded-[7px] px-3 text-[12px] font-medium text-text-3 transition-colors hover:text-foreground',
                  authTab === t.key && 'bg-surface text-foreground shadow-[0_1px_0_var(--ns-hairline)]',
                )}
                onClick={() => setAuthTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </fieldset>
          {authTab === 'password' && (
            <div className="mt-3 max-w-[420px]">
              <Field
                id="sm-password"
                aria-invalid={errors.password ? true : undefined}
                aria-describedby={errors.password ? 'sm-password-error' : undefined}
                label="Новый пароль SSH"
                hint="Нужен один раз: панель заново поставит свой ключ и продолжит ходить по нему."
                error={errors.password || undefined}
              >
                <PasswordField
                  id="sm-password"
                  autoComplete="off"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
            </div>
          )}
          {authTab === 'key' && (
            <div className="mt-3 flex max-w-[640px] flex-col gap-3.5">
              <Field
                id="sm-key"
                label="Приватный ключ (OpenSSH, PEM или RSA)"
                error={errors.privateKey || undefined}
              >
                <textarea
                  id="sm-key"
                  aria-invalid={errors.privateKey ? true : undefined}
                  aria-describedby={errors.privateKey ? 'sm-key-error' : undefined}
                  rows={4}
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  className="w-full resize-y rounded-[10px] border border-border bg-surface-2 px-3 py-2 font-mono text-[12px] outline-none focus-visible:border-brand/50"
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                />
              </Field>
              <Field id="sm-passphrase" label="Пароль от ключа (если есть)">
                <PasswordField
                  id="sm-passphrase"
                  autoComplete="off"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              </Field>
            </div>
          )}
          {authTab === 'panel-key' && (
            <p className="mt-3 text-[12.5px] text-text-2">
              Перейти на ключ панели (он уже должен быть в authorized_keys на сервере).
            </p>
          )}
        </div>
      </section>

      {/* Невидимая кнопка: без неё Enter в поле не отправляет форму (сама «Сохранить» — внизу окна) */}
      <button type="submit" hidden tabIndex={-1} />
    </form>
  );
}
