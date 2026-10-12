import {
  ASSISTANT_CHECK_LABELS,
  type AssistantAdvice,
  type AssistantCheck,
  integrationsStatusSchema,
} from '@nodeservice/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowUpRightIcon, CoinsIcon, PlugIcon, RadarIcon, WalletIcon } from 'lucide-react';
import { useContext } from 'react';
import { CountryFlag } from '@/components/country-flag';
import { NodeLinkContext } from '@/features/knowledge/markdown';
import { useNodes } from '@/features/nodes/nodes-api';
import { Pill } from '@/features/settings/settings-ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Что покажет проверка и куда ведёт кнопка — одними словами в чате и в боковой панели. */
const CHECKS: Record<
  AssistantCheck,
  { shows: string; opens: string; cost: { tone: 'ok' | 'warn' | 'muted'; label: string }; service?: string }
> = {
  tcp: {
    shows: 'Открыт ли порт из разных стран, в том числе из России.',
    opens: 'Откроется окно ноды, вкладка «Подключение».',
    cost: { tone: 'ok', label: 'Бесплатно' },
  },
  dpi: {
    shows: 'Открывается ли адрес ноды у домашних провайдеров в регионах России.',
    opens: 'Откроется DPI Checker с этой нодой в новой проверке.',
    cost: { tone: 'warn', label: 'Платно' },
    service: 'DPI Checker',
  },
  bs: {
    shows: 'Пропускает ли белый список мобильных операторов адрес ноды.',
    opens: 'Откроется BS Checker с адресом ноды.',
    cost: { tone: 'muted', label: 'Цена до запуска' },
    service: 'BS Checker',
  },
};
const PROVIDER: Partial<Record<AssistantCheck, 'dpi' | 'bschecker'>> = { dpi: 'dpi', bs: 'bschecker' };

/** Подключённые интеграции и их баланс: тот же запрос, что у страниц интеграций, из кэша. */
function useIntegrationsStatus() {
  return useQuery({
    queryKey: ['integrations'],
    queryFn: ({ signal }) => api.get('/integrations', integrationsStatusSchema, signal),
    staleTime: 30_000,
  });
}

function CheckTile({ check }: { check: AssistantCheck }) {
  const box = 'grid size-[38px] flex-none place-items-center rounded-[11px]';
  if (check === 'tcp')
    return (
      <span className={cn(box, 'bg-ai-soft text-ai')}>
        <RadarIcon className="size-[18px]" aria-hidden="true" />
      </span>
    );
  return (
    <span className={cn(box, 'bg-surface')}>
      <img
        src={check === 'dpi' ? '/integration-icons/dpi.ico' : '/integration-icons/bschecker.svg'}
        alt=""
        className="size-5 rounded-[5px]"
      />
    </span>
  );
}

/** Карточка «Рекомендую проверить» под ответом: проверка, нода, зачем, что покажет, цена и кнопка. */
export function AdviceCard({ advice }: { advice: AssistantAdvice }) {
  const meta = CHECKS[advice.check];
  const nodes = useNodes();
  const integrations = useIntegrationsStatus();
  const navigate = useNavigate();
  const nodeLinks = useContext(NodeLinkContext);
  const node = nodes.data?.nodes.find((n) => n.uuid === advice.nodeUuid);
  // «Ноды нет» говорим только по загруженному списку, иначе на секунду мелькнула бы неактивная кнопка.
  const gone = Boolean(nodes.data) && !node;
  const provider = PROVIDER[advice.check];
  const status = provider ? integrations.data?.items.find((i) => i.provider === provider) : undefined;
  const off = Boolean(provider) && Boolean(integrations.data) && !status?.connected;
  const balance =
    status?.balance && !off
      ? advice.check === 'dpi'
        ? `${status.balance} USD`
        : `${status.balance} Cred`
      : null;
  const costPill = off ? (
    <Pill tone="muted">Не подключён</Pill>
  ) : (
    <Pill tone={meta.cost.tone}>{meta.cost.label}</Pill>
  );

  const open = () => {
    if (advice.check === 'tcp') nodeLinks.open(advice.nodeUuid, 'connection');
    else if (advice.check === 'dpi')
      void navigate({ to: '/integrations/dpi', search: { node: advice.nodeUuid } });
    else void navigate({ to: '/integrations/bschecker', search: { node: advice.nodeUuid } });
  };
  const connect = () =>
    void navigate({ to: advice.check === 'dpi' ? '/integrations/dpi' : '/integrations/bschecker' });

  const hint = gone
    ? 'Ноду удалили из Remnawave, открыть проверку нельзя.'
    : off
      ? `${meta.service} не подключён. Откроется его раздел, там «Подключение».`
      : `Запускаете вы. ${meta.opens}`;

  return (
    <div
      data-testid="assistant-advice"
      className="@container mt-3.5 max-w-[640px] overflow-hidden rounded-[14px] border border-border bg-surface-2"
    >
      <div className="flex items-center gap-3 px-3.5 py-3">
        <CheckTile check={advice.check} />
        <div className="min-w-0 flex-1">
          <div className="text-[10.5px] font-bold tracking-[0.08em] text-ai uppercase">
            Рекомендую проверить
          </div>
          <div className="mt-px font-heading text-[15px] leading-tight font-bold">
            {ASSISTANT_CHECK_LABELS[advice.check]}
          </div>
          <div className="mt-1.5 @min-[521px]:hidden">{costPill}</div>
        </div>
        <span className="hidden @min-[521px]:block">{costPill}</span>
      </div>
      <dl className="m-0 grid grid-cols-1 gap-0.5 border-t border-border px-3.5 py-3 text-[13px] leading-normal @min-[521px]:grid-cols-[86px_minmax(0,1fr)] @min-[521px]:gap-x-3.5 @min-[521px]:gap-y-2">
        <dt className="text-text-3">Нода</dt>
        <dd className="mb-2 flex min-w-0 items-center gap-1.5 @min-[521px]:mb-0">
          {node?.countryCode && <CountryFlag code={node.countryCode} size="sm" />}
          <span className="truncate">{advice.nodeName}</span>
          {advice.address && <span className="truncate text-text-3">· {advice.address}</span>}
        </dd>
        <dt className="text-text-3">Зачем</dt>
        <dd className="mb-2 @min-[521px]:mb-0">{advice.reason}</dd>
        <dt className="text-text-3">Покажет</dt>
        <dd>{meta.shows}</dd>
      </dl>
      <div className="flex flex-col items-stretch gap-3 border-t border-border bg-surface/45 px-3.5 py-2.5 @min-[521px]:flex-row @min-[521px]:items-center">
        <span className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
          {balance && (
            <span className="mr-1 inline-flex items-center gap-1 text-text-2">
              {advice.check === 'dpi' ? (
                <WalletIcon className="size-3.5" aria-hidden="true" />
              ) : (
                <CoinsIcon className="size-3.5" aria-hidden="true" />
              )}
              На балансе {balance} ·
            </span>
          )}
          {hint}
        </span>
        {gone ? (
          <button type="button" disabled className={BTN}>
            Ноды нет в Remnawave
          </button>
        ) : off ? (
          <button type="button" onClick={connect} className={BTN}>
            <PlugIcon className="size-3.5" aria-hidden="true" />
            Подключить {meta.service}
          </button>
        ) : (
          <button
            type="button"
            onClick={open}
            className={cn(BTN, 'border-transparent bg-brand-soft text-brand')}
          >
            <ArrowUpRightIcon className="size-3.5" aria-hidden="true" />
            Открыть проверку
          </button>
        )}
      </div>
    </div>
  );
}

const BTN =
  'inline-flex h-9 flex-none cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border border-border bg-surface px-3.5 text-[12.5px] font-semibold whitespace-nowrap text-text-2 transition-[background-color,color,filter] hover:brightness-105 disabled:cursor-default disabled:opacity-50';

export function AdviceList({ advice }: { advice: AssistantAdvice[] }) {
  if (advice.length === 0) return null;
  return (
    <div className="flex flex-col gap-2.5">
      {advice.map((a) => (
        <AdviceCard key={`${a.check}:${a.nodeUuid}`} advice={a} />
      ))}
    </div>
  );
}
