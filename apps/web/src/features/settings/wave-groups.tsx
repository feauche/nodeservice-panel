import { type RemnawaveNode, WAVE_EXPLAIN, waveGroupOf } from '@nodeservice/shared';
import { CountryFlag } from '@/components/country-flag';
import { Skeleton } from '@/components/ui/skeleton';
import { useNodes } from '@/features/nodes/nodes-api';
import { RemnaProviderIcon } from '@/features/nodes/remna-providers-page';
import { cn } from '@/lib/utils';

/** «2 ноды», «5 нод». */
const nodesWord = (n: number) => {
  const m10 = n % 10,
    m100 = n % 100;
  return m10 === 1 && m100 !== 11
    ? 'нода'
    : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)
      ? 'ноды'
      : 'нод';
};

type Group = { key: string; label: string; cause: 'provider' | 'country'; nodes: RemnawaveNode[] };

/** Ноды по группам волны: провайдер, у нод без провайдера — страна; ноды без того и другого — отдельно. */
export function waveGroups(nodes: RemnawaveNode[]): { groups: Group[]; loose: RemnawaveNode[] } {
  const groups = new Map<string, Group>();
  const loose: RemnawaveNode[] = [];
  for (const n of nodes.filter((x) => !x.isDisabled)) {
    const g = waveGroupOf(n);
    if (!g) {
      loose.push(n);
      continue;
    }
    const item = groups.get(g.key) ?? { ...g, nodes: [] };
    item.nodes.push(n);
    groups.set(g.key, item);
  }
  // Сначала большие группы: в них волна вероятнее.
  return { groups: [...groups.values()].sort((a, b) => b.nodes.length - a.nodes.length), loose };
}

/**
 * Разбивка нод по группам в карточке «Волна» (витрина wave-maintenance-2026-10, раздел 6 — B): видно, у каких
 * нод не указан провайдер и какие ноды — одиночки, которые в волну не попадут; ниже пример на ваших нодах.
 */
export function WaveGroups({ minNodes, windowMinutes }: { minNodes: number; windowMinutes: number }) {
  const status = useNodes();
  const nodes = status.data?.nodes ?? [];
  const { groups, loose } = waveGroups(nodes);
  const single = groups.filter((g) => g.nodes.length < minNodes);
  const sample = groups.find((g) => g.cause === 'provider' && g.nodes.length >= 2) ?? groups[0];
  return (
    <div className="flex flex-col gap-3 border-t border-border py-4">
      <p className="text-[12.5px] leading-relaxed text-text-2">{WAVE_EXPLAIN}</p>
      <div>
        <div className="mb-2 text-[13px] font-semibold">
          Как сгруппированы ваши ноды{' '}
          <span className="font-normal text-text-3">· по данным Remnawave сейчас</span>
        </div>
        {status.isPending ? (
          <div className="flex flex-wrap gap-2" role="status" aria-label="Загружаем ноды">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-[34px] w-[120px] rounded-[10px]" />
            ))}
          </div>
        ) : status.isError ? (
          <p className="text-[12.5px] text-text-3">
            Ноды не прочитаны — разбивка появится, когда Remnawave ответит.
          </p>
        ) : !status.data?.connected ? (
          <p className="text-[12.5px] text-text-3">
            Подключите Remnawave — здесь появятся ваши ноды по группам.
          </p>
        ) : (
          <ul aria-label="Группы нод" className="m-0 flex list-none flex-wrap gap-2 p-0">
            {groups.map((g) => (
              <li
                key={g.key}
                title={g.nodes.map((n) => n.name).join(', ')}
                className={cn(
                  'inline-flex h-[34px] items-center gap-2 rounded-[10px] border bg-surface-2 px-3 text-[12.5px]',
                  g.nodes.length < minNodes ? 'border-dashed border-border-2 text-text-3' : 'border-border',
                )}
              >
                {g.cause === 'provider' ? (
                  <RemnaProviderIcon
                    src={g.nodes[0]?.providerIcon}
                    name={g.label}
                    className="size-4 flex-none rounded-[4px] [&_img]:size-3"
                  />
                ) : (
                  g.nodes[0]?.countryCode && <CountryFlag code={g.nodes[0].countryCode} size="sm" />
                )}
                <b className="font-semibold">{g.label}</b>
                <span className="text-text-3">
                  {g.nodes.length} {nodesWord(g.nodes.length)}
                  {g.cause === 'country' && ' без провайдера'}
                </span>
              </li>
            ))}
            {loose.length > 0 && (
              <li
                title={loose.map((n) => n.name).join(', ')}
                className="inline-flex h-[34px] items-center gap-2 rounded-[10px] border border-dashed border-border-2 bg-surface-2 px-3 text-[12.5px] text-text-3"
              >
                Без провайдера и страны: {loose.length}
              </li>
            )}
          </ul>
        )}
      </div>
      {status.data?.connected && (single.length > 0 || groups.some((g) => g.cause === 'country')) && (
        <p className="text-[12px] leading-relaxed text-text-3">
          {single.length > 0 && (
            <>
              Волна начинается с {minNodes} {nodesWord(minNodes)} одной группы.{' '}
              <b className="font-semibold text-text-2">{single.map((g) => g.label).join(', ')}</b> — меньше
              нод, в волну они не попадут.{' '}
            </>
          )}
          {groups.some((g) => g.cause === 'country') && 'Ноды без провайдера собраны по стране. '}
          Провайдер ноды задаётся в окне ноды на вкладке «Настройки».
        </p>
      )}
      {sample && sample.nodes.length >= 2 && (
        <p className="rounded-[12px] border border-border bg-bg-2 px-3.5 py-3 text-[12.5px] leading-relaxed text-text-2">
          <b className="font-semibold text-foreground">Пример:</b> за {windowMinutes} мин упали «
          {sample.nodes[0]?.name}» и «{sample.nodes[1]?.name}» (
          {sample.cause === 'provider' ? 'обе' : 'обе ноды'} {sample.label}). Будет одна волна «{sample.label}
          : 2 из {sample.nodes.length}» и одно сообщение в Telegram. Если следом упадёт ещё одна нода этой
          группы, она добавится в ту же волну.
        </p>
      )}
    </div>
  );
}
