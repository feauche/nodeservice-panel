import {
  ASSISTANT_MESSAGE_MAX,
  ASSISTANT_SUGGESTIONS,
  type AssistantCitation,
  type AssistantConversation,
  type AssistantMessage,
} from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';
import {
  AlertTriangleIcon,
  BookOpenIcon,
  FileClockIcon,
  HistoryIcon,
  Loader2Icon,
  MessageSquarePlusIcon,
  SendIcon,
  ServerIcon,
  XIcon,
} from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import {
  type ComponentType,
  type ReactNode,
  type SVGProps,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { JarvisIcon } from '@/components/jarvis-icon';
import { Markdown, ServerCountryContext, ServerHealthContext } from '@/features/knowledge/markdown';
import { type ServerHealth, serverHealth } from '@/features/servers/server-health';
import { openServer } from '@/features/servers/server-modal-store';
import { useServers } from '@/features/servers/servers-api';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { useMediaQuery } from '@/lib/use-media';
import { cn } from '@/lib/utils';
import { ActivityRow, useActivityStore, useLiveActivity } from './activity';
import {
  LAST_CONV_KEY,
  useAssistantStatus,
  useConversationHistory,
  useConversations,
  usePendingChats,
  useSendMessage,
} from './assistant-api';
import { ChangeCard } from './change-card';
import { linkifyServers } from './link-servers';
import { ProposalCard } from './proposal-card';
import { ReachabilityCard } from './reachability-card';

// Помним последнюю открытую беседу, чтобы вернуться и продолжить после ухода со страницы.

export function AssistantPage() {
  const status = useAssistantStatus();

  if (status.isPending)
    return <div className="grid h-full place-items-center text-[13px] text-text-3">Загрузка…</div>;

  if (!status.data?.enabled) return <AssistantDisabled />;

  return <AssistantChat />;
}

function AssistantDisabled() {
  return (
    <div className="grid min-h-[420px] place-items-center rounded-2xl border border-dashed border-border">
      <div className="flex max-w-[420px] flex-col items-center gap-3 text-center">
        <span className="grid size-12 place-items-center rounded-2xl bg-brand-soft text-brand">
          <JarvisIcon className="size-6" aria-hidden="true" />
        </span>
        <h2 className="font-heading text-[17px] font-bold">Джарвис выключен</h2>
        <p className="text-[13px] text-text-2">
          Добавьте ключ модели в Настройках, чтобы задавать вопросы о парке — Джарвис видит метрики, Журнал и
          базу знаний.
        </p>
        <Link
          to="/settings/assistant"
          className="mt-1 inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-cta px-4 text-[13px] font-semibold text-cta-foreground hover:bg-(--ns-cta-hover)"
        >
          Настройки → Джарвис
        </Link>
      </div>
    </div>
  );
}

/**
 * Высота окна = область контента оболочки минус верхний отступ и такой же нижний. Оболочка оставляет снизу
 * 60px, поэтому лишнее «съедаем» отрицательным полем: на десктопе и планшете верх и низ по 24px (лишние 36px),
 * на телефоне по 16px (лишние 44px). Так же устроена страница «База знаний».
 */
const PAGE =
  'grid -mb-11 h-[calc(100dvh-90px)] min-h-[440px] gap-4 md:-mb-9 md:h-[calc(100dvh-124px)] lg:min-h-[460px] lg:grid-cols-[236px_minmax(0,1fr)]';
/**
 * С этой ширины список бесед стоит колонкой слева. Запрос тот же, что у «lg:» в Tailwind (64rem), чтобы логика
 * и раскладка не разошлись. Уже — телефон и планшет: «Новый чат» и «История» в шапке чата.
 */
const WIDE = '(min-width: 64rem)';

function AssistantChat() {
  const [conversationId, setConversationId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LAST_CONV_KEY);
    } catch {
      return null;
    }
  });
  const conversations = useConversations();
  const history = useConversationHistory(conversationId);
  // В jsdom matchMedia нет — считаем экран широким.
  const wide = useMediaQuery(WIDE, true);
  const currentTitle = conversations.data?.items.find((c) => c.id === conversationId)?.title ?? null;
  const serversQuery = useServers();
  const healthById = useMemo(() => {
    const map: Record<string, ServerHealth> = {};
    for (const srv of serversQuery.data?.items ?? []) map[srv.id] = serverHealth(srv);
    return map;
  }, [serversQuery.data]);
  const countryById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const srv of serversQuery.data?.items ?? []) if (srv.country.code) map[srv.id] = srv.country.code;
    return map;
  }, [serversQuery.data]);
  const send = useSendMessage();
  const [input, setInput] = useState('');
  const chatRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const messages = history.data?.items ?? [];
  // «Думает» берём из кэша запросов, а не из состояния страницы: ушли в другой раздел и вернулись —
  // запрос всё ещё идёт, и индикатор должен остаться, а когда ответ готов, исчезнуть.
  const pendingHere = usePendingChats().filter((v) => (v.conversationId ?? null) === conversationId);
  const busy = pendingHere.length > 0;
  // Живые строки «Идёт проверка…»: с момента отправки; ответ пришёл — они уже сохранены в самом ответе.
  // Без состояния (лишняя перерисовка ломает показ вопроса, пока идёт ответ): отметка во время рендера.
  const busySinceRef = useRef(0);
  if (busy && busySinceRef.current === 0) busySinceRef.current = Date.now() - 1000;
  if (!busy) busySinceRef.current = 0;
  const busySince = busySinceRef.current;
  useEffect(() => {
    if (!busy) useActivityStore.getState().clear();
  }, [busy]);
  const live = useLiveActivity(conversationId, busySince);
  const isNewChat = conversationId === null;

  // Считаем по обрезанной длине, ровно как проверит сервер, и не даём отправить переполненное поле
  // (мгновенная обратная связь): в чат можно вставить целую статью, поэтому предел большой.
  const trimmedLen = input.trim().length;
  const maxLen = ASSISTANT_MESSAGE_MAX;
  const overLimit = trimmedLen > maxLen;
  // Счётчик показываем только когда текст уже длинный, чтобы не мозолил глаза при обычном вопросе.
  const showCounter = trimmedLen > maxLen * 0.7;

  // Оптимистично показываем своё сообщение сразу, до ответа модели.
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  // После возврата на страницу запрос нового чата ещё идёт, а беседы в истории пока нет: показываем его текст из кэша.
  const restoredPending =
    pendingUser === null && conversationId === null && pendingHere[0] ? pendingHere[0].message : null;
  const shownPending = pendingUser ?? restoredPending;
  // Новый чат дописался, пока страницы не было: переходим в созданную беседу (её запомнил сам запрос).
  // Смотрим только на запрос нового чата: если человек сам ушёл из беседы кнопкой «Новый чат», назад не возвращаем.
  const newChatBusy = conversationId === null && busy;
  const wasNewChatBusy = useRef(false);
  useEffect(() => {
    if (wasNewChatBusy.current && !newChatBusy && conversationId === null) {
      try {
        const id = localStorage.getItem(LAST_CONV_KEY);
        if (id) setConversationId(id);
      } catch {
        // приватный режим браузера: беседа есть в списке слева
      }
    }
    wasNewChatBusy.current = newChatBusy;
  }, [newChatBusy, conversationId]);
  // Сколько сообщений было в истории на момент отправки. Снимаем пузырь не по совпадению
  // текста (быстрый вопрос может дословно повторять прошлый — тогда он гас сразу),
  // а когда в истории реально прибавились сообщения — ответ пришёл.
  const pendingBaseCount = useRef(0);
  useEffect(() => {
    if (pendingUser !== null && messages.length > pendingBaseCount.current) setPendingUser(null);
  }, [messages.length, pendingUser]);

  // Помним выбранную беседу между заходами: ушёл со страницы и вернулся — продолжаешь с того же места.
  useEffect(() => {
    try {
      if (conversationId) localStorage.setItem(LAST_CONV_KEY, conversationId);
      else localStorage.removeItem(LAST_CONV_KEY);
    } catch {
      // приватный режим браузера — просто не помним
    }
  }, [conversationId]);
  // Восстановленной беседы могло уже не быть (удалили) — тогда откатываемся на новый чат.
  useEffect(() => {
    if (conversationId && history.isError && (history.error as { status?: number } | null)?.status === 404)
      setConversationId(null);
  }, [conversationId, history.isError, history.error]);

  // Автоскролл вниз при новых сообщениях / индикаторе набора.
  // biome-ignore lint/correctness/useExhaustiveDependencies: скроллим на изменение длины и busy
  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, busy]);

  // Поле ввода растёт под текст (до предела), потом прокрутка. Высоту меряем без подсказки: длинная
  // подсказка переносится на вторую строку и раздувала пустое поле, а с первой буквой оно схлопывалось
  // и весь чат подпрыгивал. Если список был прокручен до конца, после смены высоты остаётся внизу.
  // biome-ignore lint/correctness/useExhaustiveDependencies: высота пересчитывается при смене текста
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    const list = chatRef.current;
    const atBottom = list ? list.scrollHeight - list.scrollTop - list.clientHeight < 24 : false;
    const placeholder = el.placeholder;
    el.placeholder = '';
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    el.placeholder = placeholder;
    if (list && atBottom) list.scrollTop = list.scrollHeight;
  }, [input]);

  const submit = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    if (message.length > ASSISTANT_MESSAGE_MAX) return; // защита: кнопка уже заблокирована
    setInput('');
    pendingBaseCount.current = messages.length;
    setPendingUser(message);
    try {
      const res = await send.mutateAsync({ message, ...(conversationId ? { conversationId } : {}) });
      setConversationId(res.conversationId);
    } catch (err) {
      toast.error(apiErrorMessage(err));
      setInput(message);
      setPendingUser(null);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit(input);
    }
  };

  return (
    <div className={PAGE}>
      {/* История бесед: на широком экране колонкой слева, на узком — в шапке чата */}
      {wide && (
        <aside className="hidden min-h-0 flex-col gap-3 rounded-2xl border border-border bg-surface p-3.5 lg:flex">
          <ConversationsPanel
            items={conversations.data?.items}
            current={conversationId}
            onSelect={setConversationId}
          />
        </aside>
      )}

      {/* Диалог */}
      <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface">
        {!wide && (
          <div className="flex flex-none items-center gap-2 border-b border-border px-3 py-2.5">
            <HistorySheet
              items={conversations.data?.items}
              current={conversationId}
              onSelect={setConversationId}
            />
            <span
              data-testid={currentTitle ? 'assistant-conversation-title' : undefined}
              className="min-w-0 flex-1 truncate text-[12.5px] text-text-2"
            >
              {currentTitle}
            </span>
            <NewChatButton onClick={() => setConversationId(null)} />
          </div>
        )}
        <div
          ref={chatRef}
          data-testid="assistant-messages"
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5 sm:p-6"
        >
          {messages.length === 0 && !busy && !shownPending && <EmptyChat />}
          <ServerHealthContext.Provider value={healthById}>
            <ServerCountryContext.Provider value={countryById}>
              {messages.map((m, i) => (
                <MessageRow
                  key={m.id}
                  message={m}
                  grouped={m.role === 'assistant' && messages[i - 1]?.role === 'assistant'}
                  interim={m.role === 'assistant' && messages[i + 1]?.role === 'assistant'}
                />
              ))}
              {shownPending && (
                <MessageRow
                  message={{
                    id: 'pending-user',
                    role: 'user',
                    content: shownPending,
                    citations: [],
                    proposals: [],
                    reachability: [],
                    activity: [],
                    createdAt: '',
                  }}
                />
              )}
              {busy && live.length > 0 && (
                <div className="flex max-w-[92%] gap-3">
                  <span className="size-8 flex-none" aria-hidden="true" />
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    {live.map((a) => (
                      <ActivityRow key={a.id} activity={a} />
                    ))}
                  </div>
                </div>
              )}
              {busy && <TypingRow />}
            </ServerCountryContext.Provider>
          </ServerHealthContext.Provider>
        </div>

        {/* Композер: одно поле ввода, Джарвис сам понимает, что прислали: вопрос, статью, термины, вывод команды */}
        <div className="flex-none border-t border-border p-3 sm:p-3.5">
          {isNewChat && messages.length === 0 && !shownPending && (
            <div className="mb-2.5 flex flex-wrap gap-1.5 max-sm:[&>button:nth-child(n+4)]:hidden">
              {ASSISTANT_SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={busy}
                  onClick={() => void submit(s)}
                  className="rounded-full border border-border bg-surface-2 px-3 py-1 text-[12px] text-text-2 transition-colors hover:border-brand/40 hover:bg-surface-3 hover:text-foreground disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-2 rounded-[16px] border border-border bg-surface-2 p-2 transition-colors focus-within:border-brand/50">
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={busy}
              rows={1}
              aria-label="Сообщение Джарвису"
              placeholder="Спросите или вставьте текст…"
              className="max-h-[200px] w-full resize-none bg-transparent px-2 py-1 text-[13.5px] leading-relaxed outline-none placeholder:text-text-3"
            />
            <div className="flex items-center justify-end gap-2">
              <div className="flex items-center gap-2.5">
                {showCounter && (
                  <span
                    className={cn(
                      'text-[11px] tabular-nums transition-colors',
                      overLimit ? 'font-medium text-destructive' : 'text-text-3',
                    )}
                  >
                    {trimmedLen.toLocaleString('ru-RU')} / {maxLen.toLocaleString('ru-RU')}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void submit(input)}
                  disabled={busy || trimmedLen === 0 || overLimit}
                  aria-label="Отправить"
                  className="inline-flex size-9 flex-none items-center justify-center rounded-[10px] bg-cta text-cta-foreground transition-[filter,opacity] hover:brightness-105 disabled:opacity-40"
                >
                  {busy ? (
                    <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <SendIcon className="size-4" aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>
          </div>
          <p className={cn('mt-1.5 px-1 text-[11px]', overLimit ? 'text-destructive' : 'text-text-3')}>
            {overLimit
              ? 'Текст длиннее предела: разбейте его на части и отправьте по очереди.'
              : 'Enter — отправить, Shift+Enter — перенос строки. Статью Джарвис сохранит в базу знаний, термины добавит в «Пояснения».'}
          </p>
        </div>
      </div>
    </div>
  );
}

function NewChatButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex flex-none items-center justify-center gap-1.5 rounded-[10px] bg-brand-soft px-3 py-2 text-[12.5px] font-semibold text-brand transition-[filter] hover:brightness-105"
    >
      <MessageSquarePlusIcon className="size-4" aria-hidden="true" />
      Новый чат
    </button>
  );
}

interface ConversationsProps {
  items: AssistantConversation[] | undefined;
  current: string | null;
  /** Выбор беседы; null — новый чат. */
  onSelect: (id: string | null) => void;
}

/** Колонка бесед: «Новый чат» и «История». Одна и та же слева на широком экране и в выезжающей панели на узком. */
function ConversationsPanel({ items, current, onSelect, close }: ConversationsProps & { close?: ReactNode }) {
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-bold">Джарвис</span>
        <span className="inline-flex flex-none items-center gap-1.5 rounded-full bg-ok-soft px-2 py-0.5 text-[10px] font-semibold text-ok">
          <span className="size-1.5 rounded-full bg-ok" aria-hidden="true" />
          Включён
        </span>
        {close}
      </div>
      <NewChatButton onClick={() => onSelect(null)} />
      <div className="px-1 text-[10.5px] font-semibold tracking-[0.05em] text-text-3 uppercase">История</div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul className="flex flex-col gap-0.5">
          {(items ?? []).map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onSelect(c.id)}
                aria-current={current === c.id ? 'true' : undefined}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[8px] px-2.5 py-2 text-left text-[12.5px] transition-colors',
                  current === c.id
                    ? 'bg-brand-soft text-brand'
                    : 'text-text-2 hover:bg-surface-2 hover:text-foreground',
                )}
              >
                <FileClockIcon className="size-3.5 flex-none text-text-3" aria-hidden="true" />
                <span className="truncate">{c.title}</span>
              </button>
            </li>
          ))}
          {(items?.length ?? 0) === 0 && (
            <li className="px-2 py-3 text-[12px] text-text-3">Бесед пока нет.</li>
          )}
        </ul>
      </div>
    </>
  );
}

/** Узкий экран: «История» открывает ту же колонку бесед, выезжающую слева, как меню разделов на телефоне. */
function HistorySheet({ items, current, onSelect }: ConversationsProps) {
  const [open, setOpen] = useState(false);
  const pick = (id: string | null) => {
    onSelect(id);
    setOpen(false);
  };
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger className="inline-flex flex-none cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border border-border bg-surface-2 px-3 py-[7px] text-[12.5px] font-semibold text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-2">
        <HistoryIcon className="size-4" aria-hidden="true" />
        История
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-100 bg-black/45 backdrop-blur-[2px] duration-200 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 left-0 z-100 flex w-[272px] max-w-[85vw] flex-col gap-3 border-r border-border-2 bg-surface p-3.5 shadow-float outline-none duration-200 data-open:animate-in data-open:slide-in-from-left data-closed:animate-out data-closed:slide-out-to-left"
        >
          <DialogPrimitive.Title className="sr-only">История бесед</DialogPrimitive.Title>
          <ConversationsPanel
            items={items}
            current={current}
            onSelect={pick}
            close={
              <DialogPrimitive.Close
                aria-label="Закрыть историю"
                className="grid size-8 flex-none cursor-pointer place-items-center rounded-[8px] text-text-3 transition-colors hover:bg-surface-2 hover:text-foreground [&_svg]:size-4"
              >
                <XIcon aria-hidden="true" />
              </DialogPrimitive.Close>
            }
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function EmptyChat() {
  return (
    <div className="grid flex-1 place-items-center text-center">
      <div className="flex flex-col items-center gap-2">
        <span className="grid size-11 place-items-center rounded-2xl bg-brand-soft text-brand">
          <JarvisIcon className="size-5" aria-hidden="true" />
        </span>
        <p className="text-[14px] font-semibold">
          Спросите об инцидентах, серверах или о том, как что-то починить
        </p>
        <p className="max-w-[380px] text-[12.5px] text-text-3">
          Джарвис смотрит метрики, Журнал и базу знаний. Действия он только предлагает, запускаете их вы.
        </p>
      </div>
    </div>
  );
}

function TypingRow() {
  return (
    <div
      role="status"
      aria-label="Джарвис думает"
      className="flex max-w-[84%] gap-3 animate-in fade-in-0 duration-200"
    >
      <Avatar />
      <div className="flex items-center gap-1 py-3">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1.5 animate-[ns-typing_1.2s_ease-in-out_infinite] rounded-full bg-text-3"
            style={{ animationDelay: `${i * 0.18}s` }}
          />
        ))}
      </div>
    </div>
  );
}

function Avatar() {
  return (
    <span
      data-testid="assistant-avatar"
      className="grid size-8 flex-none place-items-center rounded-[10px] bg-brand-soft text-brand"
    >
      <JarvisIcon className="size-4" aria-hidden="true" />
    </span>
  );
}

function MessageRow({
  message,
  grouped = false,
  interim = false,
}: {
  message: AssistantMessage;
  /** Сообщение идёт следом за другим ответом Джарвиса: значка нет, вместо него пустое место. */
  grouped?: boolean;
  /** За ним идёт ещё ответ: это «сейчас посмотрю», приглушаем и не выделяем. */
  interim?: boolean;
}) {
  const servers = useServers();
  if (message.role === 'user')
    return (
      <div className="flex max-w-[80%] flex-row-reverse gap-2.5 self-end animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
        <div className="rounded-[14px] border border-brand/30 bg-brand-soft px-3.5 py-2.5 text-[13px] leading-relaxed text-foreground">
          {message.content}
        </div>
      </div>
    );

  return (
    <div
      className={cn(
        'flex max-w-[92%] gap-3 animate-in fade-in-0 slide-in-from-bottom-1 duration-200',
        grouped && '-mt-2',
      )}
    >
      {grouped ? <span className="size-8 flex-none" aria-hidden="true" /> : <Avatar />}
      <div className={cn('min-w-0 flex-1', grouped && !interim && 'border-t border-border pt-2.5')}>
        {message.activity.length > 0 && (
          <div className="mb-2.5 flex flex-col gap-2">
            {message.activity.map((a) => (
              <ActivityRow key={a.id} activity={a} />
            ))}
          </div>
        )}
        <Markdown
          content={linkifyServers(message.content, servers.data?.items ?? [])}
          className={cn('-my-1 text-[13.5px]', interim && '[&_p]:text-text-3')}
        />
        {message.citations.length > 0 && <Sources citations={message.citations} />}
        {message.reachability.map((r) => (
          <ReachabilityCard key={`${r.target.name}:${r.ports.map((p) => p.port).join(',')}`} result={r} />
        ))}
        {message.proposals.map((p) =>
          p.kind === 'change' ? (
            <ChangeCard key={p.changeId} proposal={p} />
          ) : (
            <ProposalCard key={`${p.incidentId}:${p.preset}`} proposal={p} createdAt={message.createdAt} />
          ),
        )}
      </div>
    </div>
  );
}

const CITE_META: Record<
  AssistantCitation['type'],
  { label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }
> = {
  kb: { label: 'База знаний', icon: BookOpenIcon },
  incident: { label: 'Инцидент', icon: AlertTriangleIcon },
  audit: { label: 'Журнал', icon: FileClockIcon },
  server: { label: 'Сервер', icon: ServerIcon },
  metric: { label: 'Метрика', icon: JarvisIcon },
};

/** Одна строка «Основано на:» — на чём построен ответ; чипы тихие, чтобы не спорить с текстом. */
function Sources({ citations }: { citations: AssistantCitation[] }) {
  return (
    <div data-testid="assistant-sources" className="mt-2.5 flex flex-wrap items-center gap-1.5">
      <span className="text-[11.5px] font-medium text-text-3">Основано на:</span>
      {citations.map((c) => (
        <SourceChip key={`${c.type}:${c.id}`} citation={c} />
      ))}
    </div>
  );
}

function SourceChip({ citation }: { citation: AssistantCitation }) {
  const meta = CITE_META[citation.type];
  const Icon = meta.icon;
  const base =
    'inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-[3px] text-[11.5px] text-text-2';
  const interactive = 'cursor-pointer transition-colors hover:border-border-2 hover:text-foreground';
  const inner = (
    <>
      <Icon className="size-3 flex-none text-text-3" aria-hidden="true" />
      <span className="max-w-[220px] truncate">{citation.label}</span>
    </>
  );
  const title = `${meta.label}: ${citation.label}`;
  if (citation.type === 'kb')
    return (
      <Link to="/knowledge" search={{ open: citation.id }} title={title} className={cn(base, interactive)}>
        {inner}
      </Link>
    );
  if (citation.type === 'incident')
    return (
      <Link to="/incidents" title={title} className={cn(base, interactive)}>
        {inner}
      </Link>
    );
  if (citation.type === 'server')
    return (
      <button
        type="button"
        title={title}
        onClick={() => openServer(citation.id)}
        className={cn(base, interactive)}
      >
        {inner}
      </button>
    );
  return (
    <span title={title} className={base}>
      {inner}
    </span>
  );
}
