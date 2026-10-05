import type { RemnawaveTopology, RemnawaveTopologyProfile } from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';
import {
  ArrowRightIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleDotIcon,
  NetworkIcon,
  RouteIcon,
  ServerIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { ASSISTANT_DRAFT_KEY } from '@/features/assistant/assistant-api';

const protocolName = (value: string | null): string => {
  if (!value) return 'не указан';
  const known: Record<string, string> = {
    freedom: 'Прямой интернет',
    direct: 'Прямой интернет',
    blackhole: 'Блокировка',
    socks: 'SOCKS-прокси',
    http: 'HTTP-прокси',
    vless: 'VLESS',
    vmess: 'VMess',
    trojan: 'Trojan',
    wireguard: 'WireGuard',
    balancer: 'Балансировщик',
  };
  return known[value.toLowerCase()] ?? value;
};

function StatusIcon({ status }: { status: RemnawaveTopologyProfile['status'] }) {
  if (status === 'ok') return <CheckCircle2Icon className="size-4 text-ok" aria-hidden="true" />;
  return <TriangleAlertIcon className="size-4 text-warn" aria-hidden="true" />;
}

function Definition({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof NetworkIcon;
  title: string;
  children: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface-2 px-3.5 py-3">
      <div className="flex items-center gap-2 text-[12.5px] font-semibold">
        <Icon className="size-4 text-brand" aria-hidden="true" />
        {title}
      </div>
      <p className="mt-1 text-[11.5px] leading-5 text-text-3">{children}</p>
    </div>
  );
}

function ProfileReview({
  profile,
  topology,
}: {
  profile: RemnawaveTopologyProfile;
  topology: RemnawaveTopology;
}) {
  const hosts = topology.hosts.filter((host) => profile.hostIds.includes(host.id));
  const nodes = topology.nodes.filter((node) => profile.nodeUuids.includes(node.id));
  const routes = topology.routes.filter((route) => route.profileUuid === profile.id);
  return (
    <details
      className="group overflow-hidden rounded-2xl border border-border bg-surface"
      open={profile.status !== 'ok'}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-4 hover:bg-surface-2/55">
        <StatusIcon status={profile.status} />
        <div className="min-w-0 flex-1">
          <div className="break-words text-[13.5px] font-semibold">{profile.name}</div>
          <div className="mt-0.5 text-[11.5px] text-text-3">{profile.summary}</div>
        </div>
        <span className="hidden text-[11px] text-text-3 sm:block">
          {hosts.length} хостов · {nodes.length} нод
        </span>
        <ChevronDownIcon className="size-4 flex-none text-text-3 transition-transform group-open:rotate-180" />
      </summary>

      <div className="border-t border-border p-4">
        <div className="grid gap-3 lg:grid-cols-2">
          <section className="rounded-xl border border-border bg-surface-2/55 p-3.5">
            <h3 className="flex items-center gap-2 text-[12px] font-semibold">
              <NetworkIcon className="size-4 text-brand" /> Инбаунды — как трафик входит
            </h3>
            <div className="mt-2.5 space-y-2">
              {profile.inbounds.length === 0 && (
                <p className="text-[11.5px] text-warn">В конфигурации нет инбаундов.</p>
              )}
              {profile.inbounds.map((inbound) => (
                <div key={inbound.tag} className="rounded-lg border border-border bg-surface px-3 py-2.5">
                  <div className="break-words font-mono text-[11.5px] font-semibold">{inbound.tag}</div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-text-3">
                    <span>{protocolName(inbound.protocol)}</span>
                    {inbound.port && <span>порт {inbound.port}</span>}
                    {inbound.network && <span>транспорт {inbound.network}</span>}
                    {inbound.security && <span>защита {inbound.security}</span>}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-border bg-surface-2/55 p-3.5">
            <h3 className="flex items-center gap-2 text-[12px] font-semibold">
              <ServerIcon className="size-4 text-brand" /> Выходы — куда Xray отправляет трафик
            </h3>
            <div className="mt-2.5 space-y-2">
              {profile.outbounds.length === 0 && (
                <p className="text-[11.5px] text-crit">В конфигурации нет ни одного outbound.</p>
              )}
              {profile.outbounds.map((outbound, index) => (
                <div
                  key={`${outbound.tag ?? 'untagged'}:${outbound.protocol ?? ''}:${outbound.address ?? ''}`}
                  className="rounded-lg border border-border bg-surface px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="break-words font-mono text-[11.5px] font-semibold">
                      {outbound.tag ?? `Без тега · выход ${index + 1}`}
                    </span>
                    <span className="text-[10.5px] text-text-3">{protocolName(outbound.protocol)}</span>
                  </div>
                  <p className="mt-1 text-[11.5px] font-medium text-text-2">{outbound.purpose}</p>
                  <p className="mt-1 text-[11px] leading-4 text-text-3">{outbound.note}</p>
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10.5px] text-text-3">
                    {outbound.address && <span>адрес: {outbound.address}</span>}
                    {outbound.dialerProxy && <span>dialerProxy: {outbound.dialerProxy}</span>}
                    <span>явных правил: {outbound.usedByRules}</span>
                    {index === 0 && <span className="font-sans text-brand">выход по умолчанию</span>}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        <section className="mt-3 rounded-xl border border-border bg-surface-2/55 p-3.5">
          <h3 className="flex items-center gap-2 text-[12px] font-semibold">
            <RouteIcon className="size-4 text-brand" /> Правила routing — что куда направляется
          </h3>
          <div className="mt-2.5 space-y-2">
            {routes.map((route) => (
              <div
                key={route.id}
                className="grid gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 md:grid-cols-[150px_minmax(0,1fr)]"
              >
                <div>
                  <div className="text-[11px] font-semibold text-text-2">
                    {route.isDefault ? 'Маршрут по умолчанию' : `Правило ${route.order + 1}`}
                  </div>
                  <div className="mt-1 break-words font-mono text-[10.5px] text-text-3">
                    {route.outboundTag}
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
                    <span className="text-text-3">Если:</span>
                    <span className="font-medium">{route.match.join(' · ')}</span>
                    <ArrowRightIcon className="size-3.5 text-text-3" />
                    <span className="font-semibold">{route.targetLabel}</span>
                  </div>
                  <p className="mt-1 text-[11px] leading-4 text-text-3">{route.explanation}</p>
                  {route.note && <p className="mt-1 text-[11px] leading-4 text-warn">{route.note}</p>}
                </div>
              </div>
            ))}
          </div>
        </section>

        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10.5px] text-text-3">
          <span>Хосты: {hosts.map((host) => host.name).join(', ') || 'нет'}</span>
          <span>Ноды: {nodes.map((node) => node.name).join(', ') || 'нет'}</span>
        </div>
      </div>
    </details>
  );
}

export function RemnawaveConfigReview({ topology }: { topology: RemnawaveTopology }) {
  const askJarvis = () => {
    try {
      localStorage.setItem(
        ASSISTANT_DRAFT_KEY,
        'Проверь все конфигурации Xray в Remnawave. Объясни простыми словами, как идёт трафик, найди только подтверждённые ошибки и предложи, что стоит изменить. Сначала прочитай карту и нужные профили через инструменты Remnawave.',
      );
    } catch {
      // Переход всё равно работает; пользователь сможет написать вопрос вручную.
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-[760px]">
            <h2 className="font-heading text-[15px] font-bold">Как читать конфигурацию Xray</h2>
            <p className="mt-1 text-[12px] leading-5 text-text-3">
              NodeService показывает безопасный разбор конфигов Remnawave. Ключи, UUID пользователей,
              сертификаты и токены сюда не попадают.
            </p>
          </div>
          <Link
            to="/assistant"
            onClick={askJarvis}
            className="inline-flex h-9 items-center gap-2 rounded-[10px] bg-cta px-3.5 text-[12.5px] font-semibold text-cta-foreground hover:brightness-105"
          >
            <BotIcon className="size-4" /> Проверить с Джарвисом
          </Link>
        </div>
        <div className="mt-4 grid gap-2.5 md:grid-cols-3">
          <Definition icon={NetworkIcon} title="1. Инбаунд">
            Порт и протокол, через которые клиент входит на ноду.
          </Definition>
          <Definition icon={RouteIcon} title="2. Routing">
            Правила идут сверху вниз и выбирают выход по домену, IP, порту или протоколу.
          </Definition>
          <Definition icon={ServerIcon} title="3. Outbound">
            Куда уйдёт соединение: прямо в интернет, в Psiphon, блокировку или другой сервер.
          </Definition>
        </div>
        <p className="mt-3 flex items-start gap-2 rounded-xl border border-brand/20 bg-brand-soft px-3.5 py-3 text-[11.5px] leading-5 text-text-2">
          <CircleDotIcon className="mt-0.5 size-4 flex-none text-brand" />
          Если ни одно правило не подошло, Xray использует первый outbound в списке. Ниже он прямо отмечен как
          «выход по умолчанию» — больше никаких непонятных подписей «первый выход».
        </p>
      </section>

      {topology.profiles.map((profile) => (
        <ProfileReview key={profile.id} profile={profile} topology={topology} />
      ))}
      {topology.profiles.length === 0 && (
        <section className="rounded-2xl border border-border bg-surface px-4 py-12 text-center">
          <TriangleAlertIcon className="mx-auto size-5 text-warn" />
          <p className="mt-2 text-[13px] font-semibold">Remnawave не вернула конфигурационные профили</p>
          <p className="mt-1 text-[11.5px] text-text-3">
            Проверьте права API-токена на чтение config-profiles.
          </p>
        </section>
      )}
    </div>
  );
}
