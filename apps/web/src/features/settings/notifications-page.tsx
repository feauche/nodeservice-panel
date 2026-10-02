import {
  INCIDENT_KIND_META,
  isValidTelegramProxy,
  parseTelegramUrl,
  TELEGRAM_DESTINATIONS_MAX,
  TELEGRAM_EVENT_GROUPS,
  TELEGRAM_EVENT_HINTS,
  TELEGRAM_EVENT_LABELS,
  TELEGRAM_EVENT_TONE,
  TELEGRAM_KIND_GROUPS,
  TELEGRAM_KIND_HINTS,
  TELEGRAM_KIND_LABELS,
  TELEGRAM_REMIND_HOURS,
  type TelegramDelivery,
  type TelegramDestination,
  type TelegramEvents,
  type TelegramKinds,
  type TelegramQuiet,
  type TelegramSettings,
} from '@nodeservice/shared';
import { BellIcon, Loader2Icon, PlusIcon, SendIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { formatAgo } from '@/features/security/security-format';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { SaveBar, SectionHeader, SettingsCard, SettingsRow, Toggle } from './settings-ui';
import { useTelegramSettings, useTestTelegram, useUpdateTelegram } from './telegram-api';
import { timeZoneLabel } from './time-zones';
import { WatchdogCard } from './watchdog-card';

/** Строка чата: сохранённая (по id, токен только маской) или новая (ссылка целиком, пока не сохранили). */
type Row = { key: string; saved: TelegramDestination } | { key: string; url: string };

interface Draft {
  rows: Row[];
  events: TelegramEvents;
  quiet: TelegramQuiet;
  kinds: TelegramKinds;
  delivery: TelegramDelivery;
  /** Поле прокси как есть: сохранённый показывается маской; не трогали — не отправляем. */
  proxy: string;
}

/** Время тихих часов списком, всегда 24 часа: поле «время» в браузере может показать «11:00 PM». */
const HALF_HOURS = Array.from(
  { length: 48 },
  (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`,
);

let seq = 0;
const newKey = () => `new-${++seq}`;

function fromSettings(s: TelegramSettings): Draft {
  return {
    rows: s.destinations.map((d) => ({ key: d.id, saved: d })),
    events: { ...s.events },
    quiet: { ...s.quiet },
    kinds: { ...s.kinds },
    proxy: s.proxy ?? '',
    delivery: { ...s.delivery },
  };
}

const sameDraft = (a: Draft, b: Draft): boolean =>
  JSON.stringify({
    rows: a.rows.map((r) => ('saved' in r ? r.saved.id : r.url.trim())),
    events: a.events,
    quiet: { ...a.quiet, timeZone: '' },
    kinds: a.kinds,
    delivery: a.delivery,
    proxy: a.proxy.trim(),
  }) ===
  JSON.stringify({
    rows: b.rows.map((r) => ('saved' in r ? r.saved.id : r.url.trim())),
    events: b.events,
    quiet: { ...b.quiet, timeZone: '' },
    kinds: b.kinds,
    delivery: b.delivery,
    proxy: b.proxy.trim(),
  });

const TONE_BADGE = {
  crit: ['bg-crit-soft text-crit', 'крит'],
  warn: ['bg-warn-soft text-warn', 'внимание'],
  ok: ['bg-ok-soft text-ok', 'ок'],
} as const;

const ICON_BTN =
  'grid size-[38px] flex-none cursor-pointer place-items-center rounded-[10px] border border-border bg-surface-2 text-text-2 transition-colors disabled:cursor-default disabled:opacity-50';

function TelegramMark() {
  return (
    <span
      className="grid size-[18px] flex-none place-items-center rounded-full bg-[#2aabee] text-white"
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" fill="currentColor" className="size-[11px]" aria-hidden="true">
        <path d="M21 4L2.5 11.2c-1 .4-1 1.4 0 1.7l4.7 1.5 1.8 5.6c.2.7 1.1.9 1.6.4l2.6-2.4 4.8 3.5c.6.4 1.4.1 1.6-.6L22.9 5.3c.3-1-.7-1.8-1.9-1.3z" />
      </svg>
    </span>
  );
}

/** Ненавязчивая нумерация сохраняет привычные карточки, но объясняет, к какой задаче они относятся. */
function NotificationGroupHeader({ number, title, hint }: { number: number; title: string; hint: string }) {
  return (
    <header className={cn('flex items-center gap-2.5 px-0.5', number > 1 && 'mt-1.5')}>
      <span className="grid size-[22px] flex-none place-items-center rounded-[7px] bg-brand/12 text-[11px] font-bold text-brand">
        {number}
      </span>
      <div className="min-w-0">
        <h3 className="m-0 font-heading text-[13.5px] font-semibold tracking-[-0.01em]">{title}</h3>
        <p className="m-0 mt-px text-[11.5px] text-text-3 max-sm:hidden">{hint}</p>
      </div>
    </header>
  );
}

/**
 * «Настройки → Уведомления» (утверждённая витрина `telegram-notifications-0.47-variants.html`). Чат —
 * одна строка-ссылка `tgram://токен/чат:тема`; у строки «Отправить тест» и «Удалить», ниже
 * «Добавить чат». После сохранения токен виден только маской.
 */
export function NotificationsPage() {
  const q = useTelegramSettings();
  const update = useUpdateTelegram();
  const test = useTestTelegram();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; detail: string; who: string | null }>>(
    {},
  );

  useEffect(() => {
    if (q.data && !draft) setDraft(fromSettings(q.data));
  }, [q.data, draft]);

  const base = useMemo(() => (q.data ? fromSettings(q.data) : null), [q.data]);
  const dirty = Boolean(draft && base && !sameDraft(draft, base));

  if (q.isPending || !draft)
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-[260px] rounded-2xl" />
        <Skeleton className="h-[360px] rounded-2xl" />
      </div>
    );
  if (q.isError)
    return (
      <p
        role="alert"
        className="rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px] text-crit"
      >
        {apiErrorMessage(q.error)}
      </p>
    );

  const badUrl = (r: Row) => !('saved' in r) && r.url.trim() !== '' && parseTelegramUrl(r.url) === null;
  const proxyChanged = draft.proxy.trim() !== (q.data?.proxy ?? '');
  // Маску с *** отправить нельзя: прокси с паролем нужно ввести целиком заново.
  const badProxy = proxyChanged && draft.proxy.trim() !== '' && !isValidTelegramProxy(draft.proxy.trim());
  const invalid = draft.rows.some(badUrl) || badProxy;
  const setRows = (rows: Row[]) => setDraft({ ...draft, rows });
  const deliveries = q.data.destinations
    .map((destination) => destination.lastDelivery)
    .filter((mark): mark is NonNullable<typeof mark> => mark !== null);
  const latestDelivery = deliveries.reduce<(typeof deliveries)[number] | null>(
    (latest, mark) => (!latest || mark.at > latest.at ? mark : latest),
    null,
  );
  const failedDeliveries = q.data.destinations.filter(
    (destination) => destination.lastDelivery?.ok === false,
  ).length;
  const failedDestinations = q.data.destinations.filter((destination) => {
    const { lastDelivery, lastTest } = destination;
    const latest = lastDelivery && (!lastTest || lastDelivery.at > lastTest.at) ? lastDelivery : lastTest;
    return latest?.ok === false;
  }).length;
  const freshTestFailed = Object.values(results).some((result) => !result.ok);
  const telegramState =
    q.data.destinations.length === 0
      ? { label: 'Telegram не подключён', dot: 'bg-text-3', tone: 'text-text-3' }
      : failedDestinations > 0 || freshTestFailed
        ? { label: 'Есть ошибка доставки', dot: 'bg-crit', tone: 'text-crit' }
        : latestDelivery?.ok
          ? { label: 'Telegram работает', dot: 'bg-ok', tone: 'text-text-2' }
          : { label: 'Telegram настроен', dot: 'bg-brand', tone: 'text-text-2' };

  const runTest = async (r: Row) => {
    setTesting(r.key);
    try {
      const res = await test.mutateAsync({
        ...('saved' in r ? { id: r.saved.id } : { url: r.url.trim() }),
        ...(proxyChanged && !badProxy ? { proxy: draft.proxy.trim() } : {}),
        // Как в переключателе сейчас, даже несохранённом: так образец можно посмотреть до включения.
        rich: draft.delivery.rich,
      });
      setResults((m) => ({
        ...m,
        [r.key]: {
          ok: res.ok,
          detail: res.detail,
          who: [res.botName, res.chatTitle].filter(Boolean).join(' → ') || null,
        },
      }));
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } finally {
      setTesting(null);
    }
  };

  const save = async () => {
    try {
      const saved = await update.mutateAsync({
        destinations: draft.rows
          .filter((r) => 'saved' in r || r.url.trim() !== '')
          .map((r) => ('saved' in r ? { id: r.saved.id } : { url: r.url.trim() })),
        events: draft.events,
        kinds: draft.kinds,
        ...(proxyChanged ? { proxy: draft.proxy.trim() } : {}),
        delivery: draft.delivery,
        quiet: {
          ...draft.quiet,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || draft.quiet.timeZone,
        },
      });
      setDraft(fromSettings(saved));
      setResults({});
      toast.success('Уведомления сохранены.');
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  return (
    <div className="flex flex-col gap-3.5">
      <SectionHeader
        icon={BellIcon}
        title="Уведомления"
        description="Куда и что присылать в Telegram. Колокольчик в панели получает всё, как и раньше."
        aside={
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-[11.5px] font-semibold',
              telegramState.tone,
            )}
          >
            <span className={cn('size-[7px] rounded-full', telegramState.dot)} aria-hidden="true" />
            {telegramState.label}
          </span>
        }
      />
      <NotificationGroupHeader
        number={1}
        title="Подключение Telegram"
        hint="Чаты, бот и сетевой доступ к Telegram"
      />
      <SettingsCard
        title="Чаты Telegram"
        hint="Одна строка — один чат. Можно разные боты и разные чаты, в том числе темы в группах."
        footer={
          <div className="grid w-full grid-cols-3 divide-x divide-border max-sm:grid-cols-1 max-sm:divide-x-0 max-sm:divide-y">
            <div className="px-3 py-0.5 first:pl-0 max-sm:px-0 max-sm:py-2">
              <span className="block text-[10.5px] text-text-3">Последняя доставка</span>
              <b className="text-[12px] font-semibold">
                {latestDelivery ? formatAgo(latestDelivery.at) : 'ещё не было'}
              </b>
            </div>
            <div className="px-3 py-0.5 max-sm:px-0 max-sm:py-2">
              <span className="block text-[10.5px] text-text-3">Ошибки доставки</span>
              <b className={cn('text-[12px] font-semibold', failedDeliveries ? 'text-crit' : 'text-ok')}>
                {failedDeliveries || 'нет'}
              </b>
            </div>
            <div className="px-3 py-0.5 max-sm:px-0 max-sm:py-2">
              <span className="block text-[10.5px] text-text-3">Расширенный формат</span>
              <b className="text-[12px] font-semibold">{draft.delivery.rich ? 'включён' : 'выключен'}</b>
            </div>
          </div>
        }
      >
        <div className="flex flex-col gap-2 py-3">
          {draft.rows.map((r) => {
            const res = results[r.key];
            const saved = 'saved' in r ? r.saved : null;
            const last = saved?.lastTest ?? null;
            // Настоящая доставка — из свежего ответа сервера: она меняется сама, без сохранения страницы.
            const delivery =
              (saved && q.data?.destinations.find((d) => d.id === saved.id)?.lastDelivery) || null;
            // Точка — по самому свежему из двух: давний удачный тест не должен гореть зелёным, когда
            // сегодняшнее сообщение не дошло.
            const latest = delivery && (!last || delivery.at > last.at) ? delivery : last;
            const statusOk = res ? res.ok : latest ? latest.ok : null;
            return (
              <div key={r.key} data-testid="tg-row">
                <div className="flex items-center gap-2">
                  <div
                    className={cn(
                      'flex h-[38px] min-w-0 flex-1 items-center gap-2 rounded-[10px] border bg-surface-2 px-3 font-mono text-[12.5px]',
                      badUrl(r) ? 'border-crit' : 'border-border focus-within:border-brand',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'size-[7px] flex-none rounded-full',
                        statusOk === null ? 'bg-text-3' : statusOk ? 'bg-ok' : 'bg-crit',
                      )}
                    />
                    {saved ? (
                      <span
                        className="truncate"
                        title="Токен скрыт. Чтобы сменить — удалите строку и добавьте заново."
                      >
                        {saved.masked}
                      </span>
                    ) : (
                      <input
                        aria-label="Ссылка на чат Telegram"
                        value={'url' in r ? r.url : ''}
                        onChange={(e) =>
                          setRows(
                            draft.rows.map((x) =>
                              x.key === r.key ? { key: r.key, url: e.target.value } : x,
                            ),
                          )
                        }
                        placeholder="tgram://токен_бота/id_чата:тема"
                        spellCheck={false}
                        autoComplete="off"
                        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-text-3"
                      />
                    )}
                  </div>
                  <button
                    type="button"
                    title="Отправить тестовое сообщение"
                    aria-label="Отправить тестовое сообщение"
                    disabled={
                      testing !== null || (!saved && parseTelegramUrl('url' in r ? r.url : '') === null)
                    }
                    onClick={() => void runTest(r)}
                    className={cn(ICON_BTN, 'hover:border-brand/50 hover:text-brand')}
                  >
                    {testing === r.key ? (
                      <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <SendIcon className="size-4" aria-hidden="true" />
                    )}
                  </button>
                  <button
                    type="button"
                    title="Удалить — отправка в этот чат прекратится после сохранения"
                    aria-label="Удалить чат"
                    onClick={() => setRows(draft.rows.filter((x) => x.key !== r.key))}
                    className={cn(ICON_BTN, 'hover:border-crit/50 hover:text-crit')}
                  >
                    <Trash2Icon className="size-4" aria-hidden="true" />
                  </button>
                </div>
                <p className="m-0 mt-1 mb-1 pl-0.5 text-[11.5px] text-text-3">
                  {badUrl(r) ? (
                    <span className="text-crit">
                      Не похоже на ссылку: нужен вид tgram://токен_бота/id_чата или …:тема.
                    </span>
                  ) : (
                    <>
                      {(res?.who || saved?.botName || saved?.chatTitle) && (
                        <b className="font-medium text-text-2">
                          {res?.who || [saved?.botName, saved?.chatTitle].filter(Boolean).join(' → ')}
                        </b>
                      )}
                      {saved?.topic !== undefined && saved?.topic !== null && ` · тема ${saved.topic}`}
                      {(res || last) && ' · '}
                      {res ? (
                        <span className={res.ok ? 'text-ok' : 'text-crit'}>{res.detail}</span>
                      ) : last ? (
                        <span className={last.ok ? 'text-ok' : 'text-crit'}>
                          {last.ok ? `тест доставлен ${formatAgo(last.at)}` : last.detail}
                        </span>
                      ) : saved ? (
                        ' · тест ещё не отправляли'
                      ) : (
                        'Новый чат — сохраните, чтобы начать отправку. Проверить можно сразу.'
                      )}
                      {delivery && (
                        <>
                          {' · '}
                          <span className={delivery.ok ? 'text-ok' : 'text-crit'}>
                            {delivery.ok
                              ? `последнее сообщение доставлено ${formatAgo(delivery.at)}`
                              : `последнее сообщение не дошло ${formatAgo(delivery.at)}: ${delivery.detail}`}
                          </span>
                        </>
                      )}
                    </>
                  )}
                </p>
              </div>
            );
          })}
          <div>
            <button
              type="button"
              disabled={draft.rows.length >= TELEGRAM_DESTINATIONS_MAX}
              onClick={() => setRows([...draft.rows, { key: newKey(), url: '' }])}
              className="inline-flex h-[34px] cursor-pointer items-center gap-1.5 rounded-[10px] border border-dashed border-border-2 px-3 text-[12.5px] font-medium text-text-2 transition-colors hover:border-brand/60 hover:text-foreground disabled:opacity-50"
            >
              <PlusIcon className="size-3.5" aria-hidden="true" />
              Добавить чат
            </button>
          </div>
          <details className="group/help mt-2 rounded-[10px] border border-border bg-bg-2 text-[12px] text-text-3">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 font-medium text-text-2 marker:hidden">
              <TelegramMark />
              Как подключить бота, группу или тему
              <span
                className="ml-auto text-text-3 transition-transform group-open/help:rotate-180"
                aria-hidden="true"
              >
                ⌄
              </span>
            </summary>
            <div className="border-t border-border px-3 py-2.5">
              <span className="block">
                Формат:{' '}
                <code className="font-mono text-[11.5px] break-all text-text-2">
                  tgram://токен_бота/id_чата
                </code>
                , для темы в группе — <code className="font-mono text-[11.5px] text-text-2">:номер_темы</code>{' '}
                в конце.
              </span>
              <span className="mt-1 block">
                Личный чат — ваш id (положительное число), группа — начинается с -100. Токен даёт @BotFather,
                id чата — @userinfobot или ссылка на любое сообщение. В личном чате сначала нажмите у бота
                «Старт».
              </span>
            </div>
          </details>
        </div>
        <SettingsRow
          stack
          label={
            <>
              Прокси
              <span className="ml-1.5 rounded-full bg-surface-3 px-1.5 py-px align-[1px] text-[10.5px] font-medium text-text-3">
                необязательно
              </span>
            </>
          }
          htmlFor="tg-proxy"
          hint={
            badProxy ? (
              <span className="text-crit">
                Нужен вид socks5://логин:пароль@адрес:порт или http://адрес:порт. Прокси с паролем введите
                целиком заново.
              </span>
            ) : (
              'Нужен, только если сервер панели в России и Telegram с него недоступен. Пусто — напрямую. Проверяется той же кнопкой «Отправить тест» у чата; пароль после сохранения скрыт.'
            )
          }
        >
          <input
            id="tg-proxy"
            value={draft.proxy}
            onChange={(e) => setDraft({ ...draft, proxy: e.target.value })}
            placeholder="socks5://логин:пароль@1.2.3.4:1080 или http://1.2.3.4:3128"
            spellCheck={false}
            autoComplete="off"
            className={cn(
              'h-9 w-full rounded-[9px] border bg-surface-2 px-3 font-mono text-[12.5px] outline-none placeholder:text-text-3 focus:border-brand',
              badProxy ? 'border-crit' : 'border-border',
            )}
          />
        </SettingsRow>
      </SettingsCard>
      <NotificationGroupHeader
        number={2}
        title="Какие сообщения отправлять"
        hint="Сначала общие события, затем отдельные виды инцидентов"
      />
      <SettingsCard title="Что присылать" hint="Одинаково для всех чатов.">
        {TELEGRAM_EVENT_GROUPS.map((g) => (
          <div key={g.title} className="pt-2">
            <h4 className="m-0 pt-1 text-[10.5px] font-semibold tracking-[0.07em] text-text-3 uppercase">
              {g.title}
            </h4>
            <div>
              {g.keys.map((k) => {
                const tone = TELEGRAM_EVENT_TONE[k];
                return (
                  <SettingsRow
                    key={k}
                    htmlFor={`tg-ev-${k}`}
                    label={
                      <>
                        {TELEGRAM_EVENT_LABELS[k]}
                        {tone && (
                          <span
                            className={cn(
                              'ml-1.5 inline-flex h-[18px] items-center rounded-[5px] px-1.5 align-[1px] text-[10.5px] font-semibold',
                              TONE_BADGE[tone][0],
                            )}
                          >
                            {TONE_BADGE[tone][1]}
                          </span>
                        )}
                      </>
                    }
                    hint={TELEGRAM_EVENT_HINTS[k]}
                  >
                    <Toggle
                      id={`tg-ev-${k}`}
                      checked={draft.events[k]}
                      onChange={(v) => setDraft({ ...draft, events: { ...draft.events, [k]: v } })}
                    />
                  </SettingsRow>
                );
              })}
            </div>
          </div>
        ))}
      </SettingsCard>

      <SettingsCard
        title="Какие инциденты"
        hint={
          'Выключенный вид не присылается совсем — ни открытие, ни «ждёт "Да"», ни «починилось». В колокольчике панели всё остаётся.'
        }
      >
        {TELEGRAM_KIND_GROUPS.map((g) => (
          <div key={g.title} className="pt-2">
            <h4 className="m-0 pt-1 text-[10.5px] font-semibold tracking-[0.07em] text-text-3 uppercase">
              {g.title}
            </h4>
            <div>
              {g.keys.map((k) => {
                const crit = INCIDENT_KIND_META[k].severity === 'crit';
                return (
                  <SettingsRow
                    key={k}
                    htmlFor={`tg-kind-${k}`}
                    label={
                      <>
                        {TELEGRAM_KIND_LABELS[k]}
                        <span
                          className={cn(
                            'ml-1.5 inline-flex h-[18px] items-center rounded-[5px] px-1.5 align-[1px] text-[10.5px] font-semibold',
                            crit ? TONE_BADGE.crit[0] : TONE_BADGE.warn[0],
                          )}
                        >
                          {crit ? TONE_BADGE.crit[1] : TONE_BADGE.warn[1]}
                        </span>
                      </>
                    }
                    hint={TELEGRAM_KIND_HINTS[k]}
                  >
                    <Toggle
                      id={`tg-kind-${k}`}
                      checked={draft.kinds[k]}
                      onChange={(v) => setDraft({ ...draft, kinds: { ...draft.kinds, [k]: v } })}
                    />
                  </SettingsRow>
                );
              })}
            </div>
          </div>
        ))}
      </SettingsCard>
      <NotificationGroupHeader
        number={3}
        title="Как доставлять сообщения"
        hint="Оформление, звук, повторы и ночной режим"
      />
      <SettingsCard title="Как присылать" hint="Звук, склейка сбоев и напоминания.">
        <SettingsRow
          label="Один сбой сервера — одно уведомление со звуком"
          htmlFor="tg-group"
          hint="Второй сбой того же сервера за 10 минут («агент» + «SSH») приходит ответом на первый и без звука. Критичный сбой после предупреждения всё равно приходит со звуком."
        >
          <Toggle
            id="tg-group"
            checked={draft.delivery.groupPerServer}
            onChange={(v) => setDraft({ ...draft, delivery: { ...draft.delivery, groupPerServer: v } })}
          />
        </SettingsRow>
        <SettingsRow
          label="Предупреждения без звука"
          htmlFor="tg-silent"
          hint={
            'Звук только у критичных, «ждёт "Да"», входа в панель и напоминаний; остальное приходит тихо.'
          }
        >
          <Toggle
            id="tg-silent"
            checked={draft.delivery.silentWarnings}
            onChange={(v) => setDraft({ ...draft, delivery: { ...draft.delivery, silentWarnings: v } })}
          />
        </SettingsRow>
        <SettingsRow
          label="Расширенное оформление"
          htmlFor="tg-rich"
          hint="Необязательно. Сообщения с заголовками и таблицами — например, итоги проверки порта ноды с разных серверов. Их показывают только свежие приложения Telegram: в старом вместо сообщения будет надпись «не поддерживается». Перед включением нажмите «Отправить тестовое сообщение» у чата — придёт образец. Если Telegram такое оформление не примет, сообщение сразу уйдёт в обычном виде."
        >
          <Toggle
            id="tg-rich"
            checked={draft.delivery.rich}
            onChange={(v) => setDraft({ ...draft, delivery: { ...draft.delivery, rich: v } })}
          />
        </SettingsRow>
        <SettingsRow
          label="Напоминать о нерешённом критичном"
          htmlFor="tg-remind"
          hint="Если критичный инцидент всё ещё открыт — напоминание ответом на исходное сообщение."
        >
          <select
            aria-label="Как часто напоминать"
            disabled={!draft.events.reminder}
            value={draft.delivery.remindHours}
            onChange={(e) =>
              setDraft({ ...draft, delivery: { ...draft.delivery, remindHours: Number(e.target.value) } })
            }
            className={cn(
              'h-[34px] cursor-pointer rounded-[9px] border border-border bg-surface-2 px-2.5 text-[13px] disabled:cursor-default',
              !draft.events.reminder && 'opacity-50',
            )}
          >
            {TELEGRAM_REMIND_HOURS.map((h) => (
              <option key={h} value={h}>
                каждые {h} ч
              </option>
            ))}
          </select>
          <Toggle
            id="tg-remind"
            checked={draft.events.reminder}
            onChange={(v) => setDraft({ ...draft, events: { ...draft.events, reminder: v } })}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard
        title="Тихие часы"
        hint="Ночью сразу приходят только критичные инциденты и события входа в панель, остальное — утренней сводкой одним сообщением."
      >
        <SettingsRow
          label="Тихие часы"
          htmlFor="tg-quiet"
          hint={
            q.data.timeZoneChosen
              ? `С ${draft.quiet.from} до ${draft.quiet.to} по часовому поясу панели (${timeZoneLabel(q.data.timeZone)}). Пояс выбирается в «Настройки → Внешний вид».`
              : `С ${draft.quiet.from} до ${draft.quiet.to} по поясу браузера, из которого в последний раз сохраняли эту страницу (${timeZoneLabel(q.data.timeZone)}). Чтобы тихие часы не зависели от браузера, выберите часовой пояс панели в «Настройки → Внешний вид».`
          }
        >
          <span className={cn('flex items-center gap-2', !draft.quiet.enabled && 'opacity-50')}>
            <select
              aria-label="Начало тихих часов"
              disabled={!draft.quiet.enabled}
              value={draft.quiet.from}
              onChange={(e) => setDraft({ ...draft, quiet: { ...draft.quiet, from: e.target.value } })}
              className="h-[34px] cursor-pointer rounded-[9px] border border-border bg-surface-2 px-2.5 font-mono text-[13px] disabled:cursor-default"
            >
              {HALF_HOURS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <span className="text-[12px] text-text-3">—</span>
            <select
              aria-label="Конец тихих часов"
              disabled={!draft.quiet.enabled}
              value={draft.quiet.to}
              onChange={(e) => setDraft({ ...draft, quiet: { ...draft.quiet, to: e.target.value } })}
              className="h-[34px] cursor-pointer rounded-[9px] border border-border bg-surface-2 px-2.5 font-mono text-[13px] disabled:cursor-default"
            >
              {HALF_HOURS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </span>
          <Toggle
            id="tg-quiet"
            checked={draft.quiet.enabled}
            onChange={(v) => setDraft({ ...draft, quiet: { ...draft.quiet, enabled: v } })}
          />
        </SettingsRow>
      </SettingsCard>
      <NotificationGroupHeader
        number={4}
        title="Резервная тревога"
        hint="Сообщит о полном падении панели независимо от самой панели"
      />
      <WatchdogCard />
      <SaveBar
        dirty={dirty}
        pending={update.isPending}
        onSave={() => void save()}
        onReset={() => base && setDraft(base)}
        error={invalid ? 'Исправьте поле, отмеченное красным.' : undefined}
        note="Изменения попадают в Журнал. Токены после сохранения скрыты."
      />
    </div>
  );
}
