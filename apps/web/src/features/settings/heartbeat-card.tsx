import {
  HEARTBEAT_EVERY_SECONDS,
  type HeartbeatAttempt,
  type HeartbeatTestResponse,
  type HeartbeatView,
  heartbeatUrlSchema,
} from '@nodeservice/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import {
  CircleAlertIcon,
  CircleCheckIcon,
  ExternalLinkIcon,
  HeartPulseIcon,
  Loader2Icon,
  SendIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { formatAgo } from '@/features/security/security-format';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { plural } from '@/lib/plural';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { useTestHeartbeat } from './heartbeat-api';
import { BarButton, LoadError, Pill, Segmented, SettingsCard, SettingsCardSkeleton } from './settings-ui';

type Tone = 'ok' | 'warn' | 'crit' | 'muted' | 'info';
export interface BeatState {
  tone: Tone;
  pill: string;
  title: string;
  text: string;
}

const PREFIX_HELD = /^не отправлен:\s*/;
/** Сервис не знает такую проверку или не пускает по этому адресу: 401, 403, 404, 410. */
const wrongAddress = (code: number | null) => code === 401 || code === 403 || code === 404 || code === 410;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** «12 с назад» в первую минуту, дальше — как везде в панели («5 мин назад»). */
export function agoShort(iso: string, now = Date.now()): string {
  const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return sec < 60 ? `${sec} с назад` : formatAgo(iso, now);
}

/** Что сейчас с сигналом — крупно наверху блока и пилюлей в шапке карточки. */
export function beatState(view: HeartbeatView, now = Date.now()): BeatState {
  const { status } = view;
  const r = status.lastResult;
  if (!view.url)
    return {
      tone: 'muted',
      pill: 'Выключен',
      title: 'Сигнал не настроен',
      text: 'Если сервер панели выключится, сейчас об этом никто не узнает. Укажите адрес сервиса проверки ниже.',
    };
  if (!r)
    return {
      tone: 'info',
      pill: 'Ждёт первого сигнала',
      title: 'Первый сигнал — в течение минуты',
      text: 'Адрес сохранён. Панель отправит сигнал при ближайшей проверке.',
    };
  if (r.ok)
    return {
      tone: 'ok',
      pill: 'Сигнал идёт',
      title: 'Сигнал идёт',
      text: `Последний — ${agoShort(r.at, now)}${r.ms !== null ? `, сервис принял за ${r.ms} мс` : ''}.`,
    };
  if (!r.sent)
    return {
      tone: 'warn',
      pill: 'Панель не следит',
      title: 'Сигнал придержан',
      text: `Панель отвечает, но ${(r.problem ?? '').replace(PREFIX_HELD, '')}. Сигнал не отправляется — так сервис проверки поднимет тревогу.`,
    };
  const n = status.consecutiveFailures;
  const why = wrongAddress(r.httpStatus)
    ? ' Скорее всего, проверку удалили или адрес скопирован не целиком.'
    : r.httpStatus === null
      ? ' С сервера панели сервис недоступен — проверьте адрес или попробуйте позже.'
      : '';
  const lastOk = status.lastOkAt ? ` Последний принятый — ${agoShort(status.lastOkAt, now)}.` : '';
  return {
    tone: 'crit',
    pill: 'Сервис не принимает',
    title: 'Сервис не принимает сигнал',
    text: `${capital(r.problem ?? 'сервис не принял сигнал')}${n > 1 ? ` — ${n} ${plural(n, 'раз', 'раза', 'раз')} подряд` : ''}.${why}${lastOk}`,
  };
}

type Slot = HeartbeatAttempt['outcome'] | 'none';
const SLOT_RANK: Record<Slot, number> = { none: 0, ok: 1, held: 2, failed: 3 };
const SLOT_TEXT: Record<Slot, string> = {
  ok: 'принят',
  held: 'придержан — панель не следила',
  failed: 'не принят',
  none: 'нет данных',
};
const SLOT_CLASS: Record<Slot, string> = {
  ok: 'bg-ok/85',
  held: 'bg-text-3/45',
  failed: 'bg-crit',
  none: 'bg-surface-3',
};
const SLOTS = 60;
const minuteFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

/** Последний час по минутам: в минуте несколько попыток (проверка из настроек) — показываем худшую. */
export function minuteSlots(recent: HeartbeatAttempt[], now = Date.now()): Slot[] {
  const slots: Slot[] = Array.from({ length: SLOTS }, () => 'none');
  for (const a of recent) {
    const ago = Math.floor((now - Date.parse(a.at)) / 60_000);
    const i = SLOTS - 1 - ago;
    const cur = slots[i];
    if (cur !== undefined && SLOT_RANK[a.outcome] > SLOT_RANK[cur]) slots[i] = a.outcome;
  }
  return slots;
}

function Ticks({ recent, now }: { recent: HeartbeatAttempt[]; now: number }) {
  const slots = minuteSlots(recent, now);
  const count = (s: Slot) => slots.filter((x) => x === s).length;
  const legend = (['ok', 'held', 'failed', 'none'] as const).filter((s) => s !== 'none' || count('none') > 0);
  const label = `За последний час: принято ${count('ok')}, придержано ${count('held')}, не принято ${count('failed')}, без данных ${count('none')}.`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-[11.5px] text-text-3">
        <span className="max-sm:hidden">Последний час — по минуте на полоску</span>
        <span className="sm:hidden">Последние 30 минут — по минуте на полоску</span>
        <span>сейчас</span>
      </div>
      <div
        role="img"
        aria-label={label}
        className="grid h-[26px] grid-cols-[repeat(60,minmax(0,1fr))] gap-[2px] max-sm:grid-cols-[repeat(30,minmax(0,1fr))]"
      >
        {slots.map((s, i) => {
          const at = now - (SLOTS - 1 - i) * 60_000;
          return (
            <i
              // biome-ignore lint/suspicious/noArrayIndexKey: полоски — минуты по порядку, их место и есть ключ
              key={i}
              title={`${minuteFmt.format(at)} — ${SLOT_TEXT[s]}`}
              className={cn('rounded-[2px]', SLOT_CLASS[s], i < SLOTS / 2 && 'max-sm:hidden')}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[11.5px] text-text-3">
        {legend.map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <i className={cn('size-[9px] rounded-[2px]', SLOT_CLASS[s])} aria-hidden="true" />
            {SLOT_TEXT[s]}
          </span>
        ))}
      </div>
    </div>
  );
}

const LIVE_ICON: Record<Tone, ReactNode> = {
  ok: <HeartPulseIcon className="size-[22px] motion-safe:animate-beat" />,
  info: <HeartPulseIcon className="size-[22px]" />,
  muted: <HeartPulseIcon className="size-[22px]" />,
  warn: <TriangleAlertIcon className="size-[22px]" />,
  crit: <CircleAlertIcon className="size-[22px]" />,
};
const LIVE_BOX: Record<Tone, string> = {
  ok: 'bg-ok-soft text-ok',
  info: 'bg-brand-soft text-brand',
  muted: 'bg-surface-3 text-text-3',
  warn: 'bg-warn-soft text-warn',
  crit: 'bg-crit-soft text-crit',
};
const PILL_TONE: Record<Tone, 'ok' | 'warn' | 'crit' | 'muted' | 'info'> = {
  ok: 'ok',
  info: 'info',
  muted: 'muted',
  warn: 'warn',
  crit: 'crit',
};

type Service = 'hc' | 'kuma' | 'bs' | 'other';
const PLACEHOLDER: Record<Service, string> = {
  hc: 'https://hc-ping.com/ваш-ключ',
  kuma: 'https://ваш-сервер/api/push/ключ?status=up&msg=OK&ping=',
  bs: 'https://uptime.betterstack.com/api/v1/heartbeat/ключ',
  other: 'https://адрес-сигнала',
};
const Code = ({ children }: { children: ReactNode }) => (
  <code className="rounded-[5px] bg-surface-3 px-[5px] py-px font-mono text-[11.5px] text-foreground">
    {children}
  </code>
);
const B = ({ children }: { children: ReactNode }) => (
  <b className="font-semibold text-foreground">{children}</b>
);
const SERVICES: Record<Service, { head: ReactNode; link?: [string, string]; steps: ReactNode[] }> = {
  hc: {
    head: (
      <>
        Сервис <Code>healthchecks.io</Code> — бесплатно до 20 проверок, тревоги присылает в Telegram.
      </>
    ),
    link: ['healthchecks.io', 'https://healthchecks.io/'],
    steps: [
      'Зарегистрируйтесь на сайте сервиса.',
      <>
        Нажмите <Code>Add Check</Code> (добавить проверку) и задайте: <Code>Period</Code> (как часто ждать
        сигнал) — <B>1 минута</B>, <Code>Grace</Code> (запас) — <B>3 минуты</B>.
      </>,
      <>
        В разделе <Code>Integrations</Code> (оповещения) подключите <B>Telegram</B> — сервис даст ссылку на
        своего бота.
      </>,
      <>
        Скопируйте адрес <Code>Ping URL</Code> — он начинается с https://hc-ping.com/ — и вставьте ниже.
      </>,
    ],
  },
  kuma: {
    head: 'Uptime Kuma — своя программа проверки на вашем сервере.',
    steps: [
      <>
        <B>Нужен другой сервер</B>, не тот, где стоит панель: если они на одном сервере, то и упадут вместе, и
        тревогу прислать будет некому. Адрес должен быть открыт в интернет — адреса внутренней сети панель не
        принимает.
      </>,
      <>
        «Добавить монитор» → тип <Code>Push</Code>. Интервал — <B>60 секунд</B>, повторы — <B>2</B>.
      </>,
      <>
        В уведомлениях монитора включите <B>Telegram</B>.
      </>,
      <>
        Скопируйте <Code>Push URL</Code> и вставьте ниже. Хвост <Code>?status=up&amp;msg=OK&amp;ping=</Code>{' '}
        не убирайте.
      </>,
    ],
  },
  bs: {
    head: (
      <>
        Better Stack — раздел <Code>Heartbeats</Code> (сигналы).
      </>
    ),
    link: ['betterstack.com', 'https://betterstack.com/'],
    steps: [
      <>
        Откройте <Code>Heartbeats</Code> → <Code>Create heartbeat</Code>.
      </>,
      <>
        <Code>Expect a heartbeat every</Code> (ждать сигнал каждые) — <B>1 минута</B>,{' '}
        <Code>Grace period</Code> (запас) — <B>3 минуты</B>.
      </>,
      <>
        В <Code>Escalation</Code> (кого оповещать) выберите почту или приложение Better Stack на телефоне.
      </>,
      'Скопируйте адрес сигнала и вставьте ниже.',
    ],
  },
  other: {
    head: 'Подойдёт любой сервис, который принимает «сигнал по адресу» и тревожит, если сигнал перестал приходить.',
    steps: [
      'Панель раз в минуту открывает адрес обычным запросом — без пароля и без данных о нодах.',
      <>
        В сервисе задайте ожидание <B>1 минута</B> и запас <B>3–5 минут</B>: одна пропущенная минута не должна
        будить вас ночью.
      </>,
      'Вставьте адрес ниже и нажмите «Отправить проверку».',
    ],
  },
};

function HowTo({ service, onService }: { service: Service; onService: (s: Service) => void }) {
  const s = SERVICES[service];
  return (
    <div className="flex flex-col gap-3 border-t border-border px-3.5 py-3.5">
      <Segmented
        label="Где принимать сигнал"
        value={service}
        onChange={onService}
        items={[
          {
            key: 'hc',
            label: (
              <>
                Healthchecks <span className="text-[11px] font-medium text-ok max-sm:hidden">бесплатно</span>
              </>
            ),
          },
          { key: 'kuma', label: 'Uptime Kuma' },
          { key: 'bs', label: 'Better Stack' },
          { key: 'other', label: 'Другой' },
        ]}
      />
      <p className="m-0 text-[12.5px] leading-relaxed text-text-3">
        {s.head}
        {s.link && (
          <>
            {' '}
            <a
              href={s.link[1]}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-brand hover:underline"
            >
              {s.link[0]}
              <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
            </a>
          </>
        )}
      </p>
      <ol className="m-0 flex list-none flex-col gap-2 rounded-[12px] bg-surface-2 p-3.5">
        {s.steps.map((step, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: шаги — постоянный текст по порядку
          <li key={i} className="flex gap-2.5 text-[12.5px] leading-relaxed text-text-2">
            <span className="mt-px grid size-5 flex-none place-items-center rounded-[6px] bg-surface-3 font-heading text-[11px] font-bold text-foreground">
              {i + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function TestResult({ res }: { res: HeartbeatTestResponse }) {
  return (
    <div className="flex flex-col gap-2">
      {res.ok ? (
        <p className="m-0 flex gap-2 rounded-[10px] bg-ok-soft px-3 py-2.5 text-[12.5px] leading-snug text-ok">
          <CircleCheckIcon className="mt-px size-4 flex-none" aria-hidden="true" />
          Сервис принял сигнал за {res.ms} мс. Откройте его страницу — проверка должна стать зелёной.
        </p>
      ) : (
        <p className="m-0 flex gap-2 rounded-[10px] bg-crit-soft px-3 py-2.5 text-[12.5px] leading-snug text-crit">
          <CircleAlertIcon className="mt-px size-4 flex-none" aria-hidden="true" />
          {capital(res.problem ?? 'сервис не принял сигнал')}.
          {wrongAddress(res.httpStatus) && ' Проверьте адрес: скопируйте его заново со страницы проверки.'}
        </p>
      )}
      {!res.ready && (
        <p className="m-0 flex gap-2 rounded-[10px] bg-warn-soft px-3 py-2.5 text-[12.5px] leading-snug text-warn">
          <TriangleAlertIcon className="mt-px size-4 flex-none" aria-hidden="true" />
          Проверочный сигнал ушёл, но обычные сейчас не отправляются: {res.notReady.join('; ')}. Значит,
          панель не следит за нодами, и тревога от сервиса придёт по делу.
        </p>
      )}
    </div>
  );
}

/**
 * «Настройки → Уведомления → Если перестанет работать сама панель» (витрина heartbeat-dns-2026-10, вариант C):
 * состояние крупно, полоса за последний час, адрес с проверкой и свёрнутая инструкция по сервисам. Адрес —
 * часть черновика страницы: сохраняется общей кнопкой «Сохранить».
 */
export function HeartbeatCard({
  query,
  url,
  onUrl,
  fieldError,
}: {
  query: UseQueryResult<HeartbeatView>;
  url: string;
  onUrl: (v: string) => void;
  /** Ошибка поля от сервера при сохранении (например, адрес во внутренней сети). */
  fieldError?: string | undefined;
}) {
  const test = useTestHeartbeat();
  const [service, setService] = useState<Service>('hc');
  const [result, setResult] = useState<{ url: string; res: HeartbeatTestResponse } | null>(null);
  const view = query.data;
  const now = useNow(Boolean(view?.url), 5000);

  if (query.isError && !view)
    return (
      <SettingsCard title="Сигнал «панель работает»">
        <LoadError message={apiErrorMessage(query.error)} onRetry={() => void query.refetch()} />
      </SettingsCard>
    );
  if (!view) return <SettingsCardSkeleton rows={3} />;

  const trimmed = url.trim();
  const parsed = heartbeatUrlSchema.safeParse(trimmed);
  const localError = parsed.success ? undefined : parsed.error.issues[0]?.message;
  const error = localError ?? fieldError;
  const st = beatState(view, now);
  const shownResult = result && result.url === trimmed ? result.res : null;

  const runTest = async () => {
    try {
      const res = await test.mutateAsync({ url: trimmed });
      setResult({ url: trimmed, res });
    } catch (err) {
      setResult(null);
      toast.error(apiErrorMessage(err));
    }
  };

  return (
    <SettingsCard
      title="Сигнал «панель работает»"
      hint={`Раз в ${HEARTBEAT_EVERY_SECONDS === 60 ? 'минуту' : `${HEARTBEAT_EVERY_SECONDS} с`} панель отправляет короткий сигнал внешнему сервису проверки, пока сама работает и следит за нодами. Сигналы пропали — сервис сам пришлёт вам тревогу, даже если сервер панели выключен целиком.`}
      aside={
        <Pill tone={PILL_TONE[st.tone]}>
          <span className="mr-1.5 size-1.5 rounded-full bg-current" aria-hidden="true" />
          {st.pill}
        </Pill>
      }
    >
      <div className="flex flex-col gap-3.5 py-4">
        <div className="flex items-center gap-3.5 rounded-[14px] bg-surface-2 p-4" data-testid="hb-live">
          <span className={cn('grid size-11 flex-none place-items-center rounded-[12px]', LIVE_BOX[st.tone])}>
            {LIVE_ICON[st.tone]}
          </span>
          <div className="min-w-0">
            <b className="block font-heading text-[15px] font-semibold">{st.title}</b>
            <span className="text-[12.5px] leading-snug text-text-3">{st.text}</span>
          </div>
        </div>
        <Ticks recent={view.status.recent} now={now} />
        <div className="flex flex-col gap-2">
          <label htmlFor="hb-url" className="font-heading text-[13.5px] font-semibold">
            Адрес сигнала
            <span className="ml-1.5 rounded-full bg-surface-3 px-1.5 py-px align-[1px] font-sans text-[10.5px] font-medium text-text-3">
              необязательно
            </span>
          </label>
          <div className="flex items-center gap-2.5 max-sm:flex-col max-sm:items-stretch">
            <input
              id="hb-url"
              value={url}
              onChange={(e) => onUrl(e.target.value)}
              placeholder={PLACEHOLDER[service]}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={Boolean(error) || undefined}
              aria-describedby="hb-url-hint"
              className={cn(
                'h-10 min-w-0 flex-1 rounded-[10px] border bg-surface-2 px-3 font-mono text-[12.5px] outline-none placeholder:text-text-3 focus:border-brand',
                error ? 'border-crit' : 'border-border',
              )}
            />
            <BarButton
              className="w-[200px] max-sm:w-full"
              disabled={!trimmed || Boolean(localError) || test.isPending}
              onClick={() => void runTest()}
            >
              {test.isPending ? (
                <Loader2Icon className="animate-spin" aria-hidden="true" />
              ) : (
                <SendIcon aria-hidden="true" />
              )}
              Отправить проверку
            </BarButton>
          </div>
          {shownResult && <TestResult res={shownResult} />}
          <p id="hb-url-hint" className="m-0 text-[12px] leading-relaxed text-text-3">
            {error ? (
              <span className="text-crit">{error}</span>
            ) : (
              <>
                Пусто — сигнал не отправляется. В адресе ключ вашей проверки, он работает как пароль, поэтому
                в Журнал попадает только имя сервиса, например hc-ping.com.
              </>
            )}
          </p>
        </div>
        <details
          className="group/how rounded-[12px] border border-border"
          // Пока адреса нет, инструкция раскрыта: без неё непонятно, откуда его взять.
          open={!view.url || undefined}
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-3 text-[13px] font-semibold marker:hidden">
            Как настроить сервис проверки
            <span
              className="ml-auto text-text-3 transition-transform group-open/how:rotate-180"
              aria-hidden="true"
            >
              ⌄
            </span>
          </summary>
          <HowTo service={service} onService={setService} />
        </details>
      </div>
    </SettingsCard>
  );
}
