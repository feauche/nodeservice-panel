import {
  type Incident,
  type IncidentEvent,
  type RemnawaveNode,
  TCP_VERDICT_LABELS,
} from '@nodeservice/shared';
import {
  CircleCheckIcon,
  CircleXIcon,
  HourglassIcon,
  InfoIcon,
  ListChecksIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Pill } from '@/features/settings/settings-ui';
import { cn } from '@/lib/utils';
import { StepLink, type StepTone, TONE_CHIP, TONE_TEXT } from './incident-blocks';
import { hhmm } from './incident-format';

/** События о доступности ноды: у них есть шаги восстановления. Нагрузка и память — без карточки. */
export const RECOVERY_KINDS: Incident['kind'][] = ['node_blocked', 'server_down', 'node_down'];

type Step = {
  key: string;
  label: string;
  tone: StepTone;
  value: ReactNode;
  link?: IncidentEvent['link'] | undefined;
};
const STEP_ICON: Record<StepTone, typeof CircleCheckIcon> = {
  ok: CircleCheckIcon,
  wait: HourglassIcon,
  warn: TriangleAlertIcon,
  crit: CircleXIcon,
  change: CircleCheckIcon,
  info: InfoIcon,
};
const lastOf = (inc: Incident, step: NonNullable<IncidentEvent['step']>) =>
  [...inc.timeline].reverse().find((e) => e.step === step);
/** «94.183.152.24 → 45.12.8.77» → новый адрес. */
const newAddress = (e: IncidentEvent | undefined) => e?.detail?.split('→').at(-1)?.trim() ?? null;
const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const Word = ({ tone, children }: { tone: StepTone; children: ReactNode }) => (
  <span className={cn('font-semibold', TONE_TEXT[tone])}>{children}</span>
);

/** Шаги восстановления из хронологии события и живого состояния ноды. */
export function recoverySteps(inc: Incident, node: RemnawaveNode | undefined): Step[] {
  const resolved = inc.status === 'resolved';
  const address = lastOf(inc, 'address'),
    port = lastOf(inc, 'port'),
    dns = lastOf(inc, 'dns'),
    back = lastOf(inc, 'node'),
    close = lastOf(inc, 'close');
  const steps: Step[] = [];
  const moved = newAddress(address);
  if (address && moved)
    steps.push({
      key: 'address',
      label: 'Новый адрес',
      tone: 'ok',
      value: (
        <>
          <span className="font-mono text-[12px] text-foreground">{moved}</span> · изменён в Remnawave в{' '}
          {hhmm(address.at)}
        </>
      ),
    });
  // Порт: последняя проверка из хронологии; её ещё не было — проверка в момент обнаружения.
  const report = inc.diagnostics?.report;
  const portNumber = (port?.action.match(/Порт (\d+)/) ?? report?.target.match(/:(\d+)$/))?.[1];
  if (port)
    steps.push({
      key: 'port',
      label: `Порт ${portNumber ?? ''}${address ? ' на новом адресе' : ''}`.replace('  ', ' '),
      tone: port.tone ?? 'info',
      value: (
        <>
          <Word tone={port.tone ?? 'info'}>
            {lowerFirst(port.action.replace(/^Порт \d+( на новом адресе)?:?\s*/, ''))}
          </Word>
          {port.detail ? ` · ${lowerFirst(port.detail.replace(/\.$/, ''))}` : ''}
        </>
      ),
      link: port.link,
    });
  else if (report && inc.kind !== 'node_down') {
    const tone: StepTone =
      report.verdict === 'reachable'
        ? 'ok'
        : report.verdict === 'unknown' || (report.verdict === 'russia_partial' && !report.confirmed)
          ? 'warn'
          : 'crit';
    steps.push({
      key: 'port',
      label: `Порт ${portNumber ?? ''}`.trim(),
      tone: resolved ? 'ok' : tone,
      value: resolved ? (
        <Word tone="ok">доступен</Word>
      ) : (
        <>
          <Word tone={tone}>{lowerFirst(TCP_VERDICT_LABELS[report.verdict])}</Word> · при обнаружении, проверю
          снова, когда онлайн вернётся
        </>
      ),
    });
  }
  if (dns) {
    const name = dns.action.match(/DNS-запись (\S+)/)?.[1];
    const word = name ? dns.action.replace(/^.*?DNS-запись \S+\s*/, '') : dns.action;
    steps.push({
      key: 'dns',
      label: name ? `DNS-запись ${name}` : 'DNS-записи',
      tone: dns.tone ?? 'info',
      value: (
        <>
          <Word tone={dns.tone ?? 'info'}>
            {dns.action.startsWith('Не удалось') ? 'не удалось обновить' : lowerFirst(word)}
          </Word>
          {dns.tone === 'warn' && dns.link ? ' · автозамена не включена — замените вручную' : ''}
          {dns.tone === 'crit' && dns.detail ? ` · ${dns.detail.split('.')[0] ?? ''}` : ''}
        </>
      ),
      link: dns.tone === 'warn' || dns.tone === 'crit' ? dns.link : undefined,
    });
  }
  // Связь и онлайн — живые, пока событие открыто; у закрытого — итог.
  const connected = resolved || Boolean(node?.isConnected);
  steps.push({
    key: 'node',
    label: 'Связь с Remnawave',
    tone: connected ? 'ok' : 'crit',
    value: connected ? (
      <>
        <Word tone="ok">на связи</Word>
        {back ? ` с ${hhmm(back.at)}` : ''}
      </>
    ) : (
      <Word tone="crit">нет связи</Word>
    ),
  });
  if (inc.kind !== 'node_down') {
    const online = node?.usersOnline ?? null,
      goal = inc.recovery ?? null;
    if (resolved) {
      const closed = close?.action.match(/онлайн (\d+)/)?.[1];
      steps.push({
        key: 'online',
        label: 'Онлайн',
        tone: 'ok',
        value: <Word tone="ok">{closed ? `вернулся: ${closed}` : 'вернулся'}</Word>,
      });
    } else if (online !== null) {
      const tone: StepTone = goal && online >= goal.target ? 'ok' : 'wait';
      steps.push({
        key: 'online',
        label: 'Онлайн',
        tone,
        value: (
          <>
            <Word tone={tone}>{online}</Word>
            {goal
              ? ` · жду не ниже ${goal.target}${goal.usual !== null ? `, обычно около ${goal.usual}` : `, до падения было ${goal.before}`}`
              : inc.diagnostics?.online
                ? ` · до падения было ${inc.diagnostics.online.before}`
                : ''}
          </>
        ),
      });
    }
  }
  return steps;
}

/**
 * Карточка «Восстановление» (витрина incident-recovery-2026-10, вариант B): шаги с отметками — что готово, чего ждём,
 * что нужно сделать (кнопка у этого шага). Ниже на странице — полная хронология.
 */
export function RecoveryCard({ inc, node }: { inc: Incident; node: RemnawaveNode | undefined }) {
  const steps = recoverySteps(inc, node);
  const resolved = inc.status === 'resolved';
  const done = steps.filter((s) => s.tone === 'ok').length;
  const state = resolved
    ? { tone: 'ok' as const, label: 'Готово' }
    : steps.some((s) => s.tone === 'crit' && s.link)
      ? { tone: 'crit' as const, label: 'Ошибка автозамены' }
      : steps.some((s) => s.tone === 'warn' && s.link)
        ? { tone: 'warn' as const, label: 'Нужно ваше действие' }
        : { tone: 'info' as const, label: 'Идёт' };
  return (
    <section aria-label="Восстановление" className="overflow-hidden rounded-[14px] border border-border">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3">
        <ListChecksIcon className="size-4 text-text-3" aria-hidden="true" />
        <h3 className="font-heading text-[14.5px] font-semibold">Восстановление</h3>
        <Pill tone={state.tone}>{state.label}</Pill>
        <span className="ml-auto text-[12px] whitespace-nowrap text-text-3 tabular-nums">
          {done} из {steps.length}
        </span>
      </div>
      <ul>
        {steps.map((s) => {
          const Icon = STEP_ICON[s.tone];
          return (
            <li
              key={s.key}
              className={cn(
                'grid grid-cols-[26px_minmax(0,190px)_minmax(0,1fr)_auto] items-center gap-3 border-t border-border px-4 py-[11px] text-[12.5px] first:border-t-0 max-sm:grid-cols-[26px_minmax(0,1fr)] max-sm:gap-x-3 max-sm:gap-y-1',
                s.link && s.tone === 'warn' && 'bg-warn/5',
                s.link && s.tone === 'crit' && 'bg-crit/5',
              )}
            >
              <span className={cn('grid size-6 place-items-center rounded-[8px]', TONE_CHIP[s.tone])}>
                <Icon className="size-[13px]" aria-hidden="true" />
              </span>
              <span className="font-semibold">{s.label}</span>
              <span className="leading-snug text-text-2 max-sm:col-start-2">{s.value}</span>
              {s.link ? (
                <span className="max-sm:col-start-2">
                  <StepLink link={s.link} label={s.link.href ? 'Отчёт' : 'Открыть запись'} />
                </span>
              ) : (
                <span className="max-sm:hidden" />
              )}
            </li>
          );
        })}
      </ul>
      <p className="border-t border-border bg-bg-2 px-4 py-[11px] text-[12.5px] text-text-3">
        {resolved
          ? `Все шаги выполнены — событие закрыто ${inc.resolvedBy === 'manual' ? 'вручную' : 'автоматически'}${inc.resolvedAt ? ` в ${hhmm(inc.resolvedAt)}` : ''}.`
          : 'Событие закроется само, когда все шаги будут выполнены.'}
      </p>
    </section>
  );
}

/** «Нода сейчас» — справа вместо снимка от агентов: связь, адрес, онлайн и DNS-запись прямо сейчас. */
export function NodeNow({ inc, node }: { inc: Incident; node: RemnawaveNode | undefined }) {
  const address = lastOf(inc, 'address'),
    dns = lastOf(inc, 'dns');
  const was = address?.detail?.split('→')[0]?.trim();
  return (
    <section>
      <h3 className="mb-2.5 text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">
        Нода сейчас
      </h3>
      {node ? (
        <dl className="text-[12.5px]">
          <Kv k="Связь с Remnawave">
            <span className={node.isConnected ? 'text-ok' : 'text-crit'}>
              {node.isDisabled ? 'выключена' : node.isConnected ? 'на связи' : 'нет связи'}
            </span>
          </Kv>
          <Kv k="Адрес" sub={address && was ? `с ${hhmm(address.at)}, был ${was}` : undefined}>
            <span className="font-mono text-[12px]">{node.address}</span>
          </Kv>
          <Kv k="Онлайн" sub={inc.recovery?.usual != null ? `обычно около ${inc.recovery.usual}` : undefined}>
            {node.usersOnline ?? '—'}
          </Kv>
          {dns && (
            <Kv k="DNS-запись" sub={dns.action.match(/DNS-запись (\S+)/)?.[1]}>
              <span className={TONE_TEXT[dns.tone ?? 'info']}>
                {dns.tone === 'ok' ? 'новый адрес' : dns.tone === 'info' ? 'нет записей' : 'старый адрес'}
              </span>
            </Kv>
          )}
        </dl>
      ) : (
        <p className="text-[12.5px] leading-snug text-text-3">Этой ноды больше нет в Remnawave.</p>
      )}
    </section>
  );
}

function Kv({ k, sub, children }: { k: string; sub?: string | undefined; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-border py-2 first:border-t-0">
      <dt className="flex-none whitespace-nowrap text-text-3">{k}</dt>
      <dd className="m-0 min-w-0 text-right font-semibold tabular-nums">
        {children}
        {sub && <small className="block text-[11.5px] font-normal text-text-3">{sub}</small>}
      </dd>
    </div>
  );
}
