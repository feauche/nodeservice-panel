import {
  BLOCK_VERDICT_LABELS,
  type BlockCheckResult,
  type BlockProbeResult,
  type BlockUncheckedReason,
  SERVER_CHECK_AUTO_KEYS,
  SERVER_CHECK_KEYS,
  SERVER_CHECK_META,
  type Server,
  type ServerCheckKey,
  type ServerCheckRun,
} from '@nodeservice/shared';
import { ChevronRightIcon, Loader2Icon, PlayIcon, SparklesIcon } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { JarvisIcon } from '@/components/jarvis-icon';
import { Skeleton } from '@/components/ui/skeleton';
import { formatAgo, formatIn } from '@/features/security/security-format';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { useExplainServerCheck, useRunServerCheck, useServerChecks } from '../server-checks-api';

/** Свои проверки связи и процессора повторяются раз в сутки; сторонние скрипты запускаются вручную. */
const AUTO = SERVER_CHECK_AUTO_KEYS;
const SCRIPTS = SERVER_CHECK_KEYS.filter(
  (k) => SERVER_CHECK_META[k].thirdParty && !SERVER_CHECK_META[k].heavy,
);
const HEAVY = SERVER_CHECK_KEYS.filter((k) => SERVER_CHECK_META[k].heavy);

function StatusBadge({ check, run }: { check: ServerCheckKey; run: ServerCheckRun | undefined }) {
  const result = check === 'russia_access' ? run?.blockResult : null;
  const [cls, label] = !run
    ? ['bg-surface-3 text-text-3', 'Не запускалась']
    : run.status === 'running'
      ? ['bg-brand-soft text-brand', 'Идёт']
      : run.status === 'ok'
        ? result?.unchecked
          ? ['bg-warn-soft text-warn', 'Не проверено']
          : result?.verdict === 'ok'
            ? ['bg-ok-soft text-ok', 'Доступна']
            : result
              ? ['bg-warn-soft text-warn', 'Есть проблема']
              : ['bg-ok-soft text-ok', 'Готово']
        : // Скрипт не совпал с проверенной версией: панель его не запускала — это не ошибка проверки.
          run.status === 'cancelled'
          ? ['bg-warn-soft text-warn', 'Отменена']
          : ['bg-crit-soft text-crit', 'Ошибка'];
  return (
    <span
      className={cn(
        'inline-flex h-[22px] items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-semibold whitespace-nowrap',
        cls,
      )}
    >
      {run?.status === 'running' ? (
        <Loader2Icon className="size-3 animate-spin" aria-hidden="true" />
      ) : (
        <i className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      )}
      {label}
    </span>
  );
}

const UNCHECKED: Record<BlockUncheckedReason, string> = {
  no_port: 'В Remnawave не найден пользовательский порт этой ноды.',
  bad_address: 'Адрес, порт или имя маскировки ноды имеют недопустимый формат.',
  no_probers: 'В парке нет подходящих российских серверов, с которых можно выполнить проверку.',
  ssh: 'Панель не смогла войти ни на один российский проверяющий сервер.',
  no_answer: 'Проверяющие серверы не завершили команду проверки.',
  remnawave: 'Remnawave не ответила, поэтому порт ноды узнать не удалось.',
  gone: 'Проверяемый сервер или вход больше не найден.',
};

function ProbeTable({
  title,
  probes,
  empty,
}: {
  title: string;
  probes: BlockProbeResult[];
  empty: string | null;
}) {
  const probeLabel = (probe: BlockProbeResult): string => {
    if (probe.verdict === 'ok') return 'Доступна';
    if (probe.verdict === 'partial') return 'С перебоями';
    if (probe.verdict === 'tspu') return 'Признаки ТСПУ';
    if (probe.verdict === 'block_16_20') return 'Обрыв данных';
    return 'Не отвечает';
  };
  return (
    <div>
      <h4 className="m-0 mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-text-3 uppercase">
        {title}
      </h4>
      {probes.length > 0 ? (
        <div className="overflow-hidden rounded-[10px] border border-border">
          <div className="grid grid-cols-[minmax(110px,0.7fr)_minmax(110px,0.55fr)_minmax(180px,1.5fr)] bg-surface-2 px-3 py-2 text-[10.5px] font-semibold tracking-[0.05em] text-text-3 uppercase max-sm:grid-cols-[1fr_auto]">
            <span>Откуда</span>
            <span>Результат</span>
            <span className="max-sm:hidden">Что увидел сервер</span>
          </div>
          {probes.map((probe) => (
            <div
              key={probe.from}
              className="grid grid-cols-[minmax(110px,0.7fr)_minmax(110px,0.55fr)_minmax(180px,1.5fr)] border-t border-border px-3 py-2.5 text-[12px] max-sm:grid-cols-[1fr_auto]"
            >
              <span className="font-medium">{probe.from}</span>
              <span
                className={cn(
                  'font-medium',
                  probe.verdict === 'ok'
                    ? 'text-ok'
                    : probe.verdict === 'partial'
                      ? 'text-warn'
                      : 'text-crit',
                )}
              >
                {probeLabel(probe)}
              </span>
              <span className="text-text-2 max-sm:col-span-2 max-sm:mt-1">{probe.detail}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="m-0 rounded-[10px] border border-warn/30 bg-warn-soft px-3 py-2.5 text-[12px] text-warn">
          {empty ?? 'Подходящих проверяющих серверов нет.'}
        </p>
      )}
    </div>
  );
}

function RussiaAccessResult({ result }: { result: BlockCheckResult }) {
  const mainReason = result.unchecked ? UNCHECKED[result.unchecked] : null;
  const foreignReason = result.foreignUnchecked ? UNCHECKED[result.foreignUnchecked] : null;
  return (
    <div className="flex flex-col gap-3 rounded-[12px] border border-border bg-bg-2 p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={cn(
            'text-[13.5px] font-semibold',
            result.unchecked ? 'text-warn' : result.verdict === 'ok' ? 'text-ok' : 'text-crit',
          )}
        >
          {result.unchecked
            ? 'Проверить не удалось'
            : result.verdict === 'unreachable'
              ? 'Порт ноды не отвечает'
              : BLOCK_VERDICT_LABELS[result.verdict]}
        </span>
        <span className="text-[12px] text-text-3">
          {result.nodeName} · {result.address}
        </span>
      </div>
      <ProbeTable title="Из России" probes={result.probes} empty={mainReason} />
      <ProbeTable title="Контроль из других стран" probes={result.foreign} empty={foreignReason} />
      <p className="m-0 text-[11.5px] text-text-3">
        {result.sniUsed
          ? `Глубокая проверка выполнена с именем маскировки ${result.sniUsed}.`
          : 'Имя маскировки не найдено: проверена доступность TCP-порта, глубокая TLS/DPI-проверка недоступна.'}
      </p>
    </div>
  );
}

function CheckRow({
  check,
  run,
  busy,
  onRun,
  onExplain,
  explaining,
}: {
  check: ServerCheckKey;
  run: ServerCheckRun | undefined;
  busy: boolean;
  onRun: () => void;
  onExplain: (runId: string) => void;
  explaining: boolean;
}) {
  const meta = SERVER_CHECK_META[check];
  const [open, setOpen] = useState(false);
  const running = run?.status === 'running';
  const canOpen = Boolean(run);
  return (
    <li className="border-t border-border px-4 py-3 first:border-t-0" data-testid={`check-${check}`}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 md:grid-cols-[minmax(0,1fr)_130px_100px_172px]">
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold">{meta.label}</div>
          <div className="text-[12px] text-text-3">{meta.what}</div>
        </div>
        <div className="max-md:hidden">
          <StatusBadge check={check} run={run} />
        </div>
        <div className="text-[12px] text-text-3 max-md:hidden">{run ? formatAgo(run.startedAt) : '—'}</div>
        <div className="flex items-center justify-end gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={onRun}
            title={busy ? 'На сервере уже идёт проверка' : meta.heavy ? meta.duration : undefined}
            className={cn(
              'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[9px] border bg-surface-2 px-3 text-[12.5px] font-medium whitespace-nowrap transition-colors disabled:cursor-default disabled:opacity-50',
              meta.heavy
                ? 'border-warn/40 text-warn hover:border-warn/70'
                : 'border-border text-text-2 hover:border-border-2 hover:text-foreground',
            )}
          >
            <PlayIcon className="size-3.5" aria-hidden="true" />
            {meta.heavy ? 'Запустить…' : run ? 'Заново' : 'Запустить'}
          </button>
          {canOpen ? (
            <button
              type="button"
              aria-expanded={open}
              aria-label={open ? `Свернуть «${meta.label}»` : `Подробнее: «${meta.label}»`}
              onClick={() => setOpen((v) => !v)}
              className="grid size-8 cursor-pointer place-items-center rounded-[8px] text-text-3 hover:bg-surface-3 hover:text-foreground"
            >
              <ChevronRightIcon
                className={cn('size-4 transition-transform', open && 'rotate-90')}
                aria-hidden="true"
              />
            </button>
          ) : (
            <span className="size-8" aria-hidden="true" />
          )}
        </div>
      </div>
      {/* На телефоне статус и время — под названием. */}
      <div className="mt-1.5 flex items-center gap-2 md:hidden">
        <StatusBadge check={check} run={run} />
        {run && <span className="text-[12px] text-text-3">{formatAgo(run.startedAt)}</span>}
      </div>
      {open && run && (
        <div className="mt-3 flex flex-col gap-2.5">
          {run.error && (
            <p className={cn('m-0 text-[12.5px]', run.status === 'cancelled' ? 'text-warn' : 'text-crit')}>
              {run.error}
            </p>
          )}
          {!running && check !== 'russia_access' && (
            <div className="rounded-[10px] border border-ai/30 bg-ai-soft px-3 py-2.5 text-[12.5px]">
              <div className="mb-1 flex items-center gap-1.5 text-[11.5px] font-semibold text-ai">
                <JarvisIcon className="size-3.5" aria-hidden="true" />
                Джарвис
              </div>
              {run.explanation ? (
                <p className="m-0 whitespace-pre-line">{run.explanation}</p>
              ) : (
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="text-text-3">
                    Прочитает вывод и перескажет простыми словами, что он значит для сервера.
                  </span>
                  <button
                    type="button"
                    disabled={explaining}
                    onClick={() => onExplain(run.id)}
                    className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[9px] border border-ai/35 bg-surface-2 px-3 text-[12.5px] font-medium text-ai disabled:opacity-60"
                  >
                    {explaining ? (
                      <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <SparklesIcon className="size-3.5" aria-hidden="true" />
                    )}
                    {explaining ? 'Читаю вывод…' : 'Объяснить'}
                  </button>
                </div>
              )}
            </div>
          )}
          {check === 'russia_access' ? (
            run.blockResult ? (
              <RussiaAccessResult result={run.blockResult} />
            ) : (
              <p className="m-0 rounded-[10px] border border-border bg-bg-2 px-3 py-2.5 text-[12.5px] text-text-3">
                {running
                  ? 'Проверяю с серверов парка…'
                  : run.error
                    ? 'Результата нет.'
                    : 'Результат не удалось прочитать.'}
              </p>
            )
          ) : (
            <pre
              data-testid="check-output"
              className="m-0 max-h-[260px] overflow-auto rounded-[10px] border border-border bg-bg-2 px-3 py-2.5 font-mono text-[11.5px] leading-[1.55] text-text-2"
            >
              {run.output || (running ? 'Ждём первые строки вывода…' : 'Вывода нет.')}
            </pre>
          )}
          <p className="m-0 text-[11.5px] text-text-3">Источник: {meta.source}.</p>
        </div>
      )}
    </li>
  );
}

/**
 * Вкладка «Проверки» (R5/J9): своя проверка доступности из России — отдельной строкой по варианту C;
 * доступность и процессор панель повторяет раз в сутки, сторонние скрипты — по кнопке, тяжёлые — с подтверждением.
 */
export function ChecksTab({ server }: { server: Server }) {
  const checks = useServerChecks(server.id);
  const run = useRunServerCheck(server.id);
  const explain = useExplainServerCheck(server.id);
  const [confirm, setConfirm] = useState<ServerCheckKey | null>(null);
  const [explainingId, setExplainingId] = useState<string | null>(null);

  if (checks.isPending)
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-2/3 rounded-md" />
        <Skeleton className="h-[280px] rounded-2xl" />
        <Skeleton className="h-[120px] rounded-2xl" />
      </div>
    );
  if (checks.isError)
    return (
      <p
        role="alert"
        className="rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px] text-crit"
      >
        {apiErrorMessage(checks.error)}
      </p>
    );

  const byKey = new Map(checks.data.items.map((r) => [r.check, r]));
  const busy = run.isPending || checks.data.items.some((r) => r.status === 'running');
  const start = async (check: ServerCheckKey, confirmHeavy = false) => {
    try {
      await run.mutateAsync({ check, confirmHeavy });
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };
  const onExplain = async (runId: string) => {
    setExplainingId(runId);
    try {
      await explain.mutateAsync(runId);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } finally {
      setExplainingId(null);
    }
  };
  const row = (k: ServerCheckKey) => (
    <CheckRow
      key={k}
      check={k}
      run={byKey.get(k)}
      busy={busy}
      onRun={() => (SERVER_CHECK_META[k].heavy ? setConfirm(k) : void start(k))}
      onExplain={(id) => void onExplain(id)}
      explaining={explainingId !== null && explainingId === byKey.get(k)?.id}
    />
  );
  const next = checks.data.nextAutoAt;
  const autoOn = checks.data.autoEnabled;
  const autoTitle = autoOn ? 'Каждый день, автоматически' : 'Своя проверка — по кнопке';

  return (
    <div className="flex flex-col gap-2">
      {autoOn ? (
        <p className="m-0 mb-2 text-[12.5px] text-text-2">
          Доступность из России и процессор панель проверяет сама{' '}
          <b className="text-foreground">раз в сутки</b>
          {next
            ? `, следующий замер — ${formatIn(next) === 'уже истекла' ? 'в ближайшие минуты' : formatIn(next)}`
            : ', первый — в ближайшее время'}
          . Сторонние скрипты запускаются только по кнопке. На одном сервере одновременно идёт одна проверка.
        </p>
      ) : (
        <p className="m-0 mb-2 text-[12.5px] text-text-2">
          Суточные проверки доступности и процессора выключены в «Настройки → Автопроверки» — все проверки
          запускаются по кнопке. На одном сервере одновременно идёт одна проверка.
        </p>
      )}
      <h3 className="m-0 px-0.5 text-[10.5px] font-semibold tracking-[0.07em] text-text-3 uppercase">
        {autoTitle}
      </h3>
      <ul
        aria-label={autoTitle}
        className="m-0 list-none overflow-hidden rounded-2xl border border-border bg-surface p-0"
      >
        {AUTO.map(row)}
      </ul>
      <h3 className="m-0 mt-3 flex items-baseline gap-2 px-0.5 text-[10.5px] font-semibold tracking-[0.07em] text-text-3 uppercase">
        Сторонние скрипты — по кнопке
        <span className="text-[11.5px] font-normal tracking-normal normal-case">
          версия закреплена и сверяется перед запуском
        </span>
      </h3>
      <ul
        aria-label="Сторонние скрипты — по кнопке"
        className="m-0 list-none overflow-hidden rounded-2xl border border-border bg-surface p-0"
      >
        {SCRIPTS.map(row)}
      </ul>
      <h3 className="m-0 mt-3 flex items-baseline gap-2 px-0.5 text-[10.5px] font-semibold tracking-[0.07em] text-text-3 uppercase">
        Тяжёлые — только вручную
        <span className="text-[11.5px] font-normal tracking-normal normal-case">долго и тратят трафик</span>
      </h3>
      <ul className="m-0 list-none overflow-hidden rounded-2xl border border-border bg-surface p-0">
        {HEAVY.map(row)}
      </ul>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        kind="warn"
        title={confirm ? `Запустить «${SERVER_CHECK_META[confirm].label}» на «${server.name}»?` : ''}
        description={
          confirm
            ? `Тяжёлая проверка: ${SERVER_CHECK_META[confirm].duration}. Пока она идёт, скорость у пользователей этого сервера может просесть. Остановить её из панели нельзя — она закончится сама.`
            : ''
        }
        yesLabel="Запустить"
        loading={run.isPending}
        onConfirm={async () => {
          const k = confirm;
          setConfirm(null);
          if (k) await start(k, true);
        }}
      />
    </div>
  );
}
