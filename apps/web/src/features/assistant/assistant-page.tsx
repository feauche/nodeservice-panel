import {
  ASSISTANT_MESSAGE_MAX,
  ASSISTANT_SUGGESTIONS,
  type AssistantCitation,
  type AssistantMessage,
} from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';
import {
  AlertTriangleIcon,
  BookOpenIcon,
  FileClockIcon,
  Loader2Icon,
  MessageSquarePlusIcon,
  SendIcon,
  ServerIcon,
} from 'lucide-react';
import { type ComponentType, type SVGProps, useEffect, useMemo, useRef, useState } from 'react';
import { JarvisIcon } from '@/components/jarvis-icon';
import { Markdown, ServerHealthContext } from '@/features/knowledge/markdown';
import { type ServerHealth, serverHealth } from '@/features/servers/server-health';
import { openServer } from '@/features/servers/server-modal-store';
import { useServers } from '@/features/servers/servers-api';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import {
  useAssistantStatus,
  useConversationHistory,
  useConversations,
  useSendMessage,
} from './assistant-api';
import { linkifyServers } from './link-servers';
import { ProposalCard } from './proposal-card';
import { ReachabilityCard } from './reachability-card';

// Помним последнюю открытую беседу, чтобы вернуться и продолжить после ухода со страницы.
const LAST_CONV_KEY = 'ns.assistant.conversation';

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
  const serversQuery = useServers();
  const healthById = useMemo(() => {
    const map: Record<string, ServerHealth> = {};
    for (const srv of serversQuery.data?.items ?? []) map[srv.id] = serverHealth(srv);
    return map;
  }, [serversQuery.data]);
  const send = useSendMessage();
  const [input, setInput] = useState('');
  const chatRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const messages = history.data?.items ?? [];
  const busy = send.isPending;
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

  // Поле ввода растёт под текст (до предела), потом прокрутка.
  // biome-ignore lint/correctness/useExhaustiveDependencies: высота пересчитывается при смене текста
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
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
      {/* История бесед */}
      <aside className="hidden min-h-0 flex-col gap-3 rounded-2xl border border-border bg-surface p-3.5 lg:flex">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] font-bold">Джарвис</span>
          <span className="inline-flex flex-none items-center gap-1.5 rounded-full bg-ok-soft px-2 py-0.5 text-[10px] font-semibold text-ok">
            <span className="size-1.5 rounded-full bg-ok" aria-hidden="true" />
            Включён
          </span>
        </div>
        <button
          type="button"
          onClick={() => setConversationId(null)}
          className="inline-flex items-center justify-center gap-1.5 rounded-[10px] bg-brand-soft px-3 py-2 text-[12.5px] font-semibold text-brand transition-[filter] hover:brightness-105"
        >
          <MessageSquarePlusIcon className="size-4" aria-hidden="true" />
          Новый чат
        </button>
        <div className="px-1 text-[10.5px] font-semibold tracking-[0.05em] text-text-3 uppercase">
          История
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ul className="flex flex-col gap-0.5">
            {(conversations.data?.items ?? []).map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setConversationId(c.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-[8px] px-2.5 py-2 text-left text-[12.5px] transition-colors',
                    conversationId === c.id
                      ? 'bg-brand-soft text-brand'
                      : 'text-text-2 hover:bg-surface-2 hover:text-foreground',
                  )}
                >
                  <FileClockIcon className="size-3.5 flex-none text-text-3" aria-hidden="true" />
                  <span className="truncate">{c.title}</span>
                </button>
              </li>
            ))}
            {(conversations.data?.items.length ?? 0) === 0 && (
              <li className="px-2 py-3 text-[12px] text-text-3">Бесед пока нет.</li>
            )}
          </ul>
        </div>
      </aside>

      {/* Диалог */}
      <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface">
        <div
          ref={chatRef}
          data-testid="assistant-messages"
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5 sm:p-6"
        >
          {messages.length === 0 && !busy && !pendingUser && <EmptyChat />}
          <ServerHealthContext.Provider value={healthById}>
            {messages.map((m, i) => (
              <MessageRow
                key={m.id}
                message={m}
                grouped={m.role === 'assistant' && messages[i - 1]?.role === 'assistant'}
                interim={m.role === 'assistant' && messages[i + 1]?.role === 'assistant'}
              />
            ))}
            {pendingUser && (
              <MessageRow
                message={{
                  id: 'pending-user',
                  role: 'user',
                  content: pendingUser,
                  citations: [],
                  proposals: [],
                  reachability: [],
                  createdAt: '',
                }}
              />
            )}
            {busy && <TypingRow />}
          </ServerHealthContext.Provider>
        </div>

        {/* Композер: одно поле ввода, Джарвис сам понимает, что прислали: вопрос, статью, термины, вывод команды */}
        <div className="flex-none border-t border-border p-3 sm:p-3.5">
          {isNewChat && messages.length === 0 && !pendingUser && (
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
              placeholder="Спросите о парке или вставьте статью, термины, вывод команды: Джарвис сам поймёт, что с этим сделать…"
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
    <div className="flex max-w-[84%] gap-3 animate-in fade-in-0 duration-200">
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
        <Markdown
          content={linkifyServers(message.content, servers.data?.items ?? [])}
          className={cn('-my-1 text-[13.5px]', interim && '[&_p]:text-text-3')}
        />
        {message.citations.length > 0 && <Sources citations={message.citations} />}
        {message.reachability.map((r) => (
          <ReachabilityCard key={`${r.target.name}:${r.ports.map((p) => p.port).join(',')}`} result={r} />
        ))}
        {message.proposals.map((p) => (
          <ProposalCard key={`${p.incidentId}:${p.preset}`} proposal={p} createdAt={message.createdAt} />
        ))}
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
