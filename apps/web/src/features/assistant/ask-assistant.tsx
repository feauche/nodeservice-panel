import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowUpRightIcon, Loader2Icon, SendIcon, XIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { JarvisIcon } from '@/components/jarvis-icon';
import { type NodeDialogTab, NodeLinkContext } from '@/features/knowledge/markdown';
import { nodeState } from '@/features/nodes/node-card';
import { useNodes } from '@/features/nodes/nodes-api';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import {
  type ChatContext,
  LAST_CONV_KEY,
  useAssistantStatus,
  useConversationHistory,
  useSendMessage,
} from './assistant-api';
import { ContextChip, MessageRow, TypingRow } from './chat-messages';

/** Кнопка «Спросить Ассистента»: та же высота и рамка, что у соседних кнопок, фиолетовый тон Ассистента. */
export const ASK_BUTTON =
  'inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border border-ai/40 bg-ai-soft px-3.5 text-[12.5px] font-semibold whitespace-nowrap text-ai transition-[border-color,filter] hover:border-ai hover:brightness-105 focus-visible:outline-2 focus-visible:outline-ai';

export interface AskTarget {
  context: ChatContext;
  /** Метка над вопросом: «Событие: …» или «Нода: …». */
  label: string;
  /** Первый вопрос: уходит сам при открытии панели. */
  question: string;
  /** Подсказка в поле ввода: «Спросите про это событие…». */
  placeholder: string;
}

/**
 * «Спросить Ассистента» со страницы события или из окна ноды: панель справа поверх страницы.
 * Вопрос уже задан, ниже ответ и советы проверок; можно спросить дальше или открыть беседу в чате.
 */
export function AskAssistant({
  target,
  className,
  onOpenNode,
}: {
  target: AskTarget;
  className?: string;
  /** Ссылка на ноду в ответе: страница сама открывает окно ноды (на нужной вкладке). */
  onOpenNode?: (uuid: string, tab?: NodeDialogTab) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={cn(ASK_BUTTON, className)}>
        <JarvisIcon className="size-3.5" aria-hidden="true" />
        Спросить Ассистента
      </button>
      {open && <AskDrawer target={target} onClose={() => setOpen(false)} onOpenNode={onOpenNode} />}
    </>
  );
}

function AskDrawer({
  target,
  onClose,
  onOpenNode,
}: {
  target: AskTarget;
  onClose: () => void;
  onOpenNode?: (uuid: string, tab?: NodeDialogTab) => void;
}) {
  const status = useAssistantStatus();
  const send = useSendMessage();
  const nodes = useNodes();
  const navigate = useNavigate();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [pending, setPending] = useState<{ text: string; first: boolean } | null>(null);
  const [input, setInput] = useState('');
  const history = useConversationHistory(conversationId);
  const listRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const messages = history.data?.items ?? [];
  const enabled = status.data?.enabled === true;

  const ask = async (text: string, first: boolean) => {
    const message = text.trim();
    if (!message || send.isPending) return;
    setPending({ text: message, first });
    try {
      const res = await send.mutateAsync({
        message,
        ...(conversationId ? { conversationId } : {}),
        ...(first ? { context: target.context } : {}),
      });
      setConversationId(res.conversationId);
    } catch (err) {
      toast.error(apiErrorMessage(err));
      if (!first) setInput(message);
    } finally {
      setPending(null);
    }
  };

  // Первый вопрос уходит сам, как только известно, что Ассистент включён.
  // biome-ignore lint/correctness/useExhaustiveDependencies: запускаем ровно один раз при включённом Ассистенте
  useEffect(() => {
    if (enabled && !started.current) {
      started.current = true;
      void ask(target.question, true);
    }
  }, [enabled]);

  // Новые сообщения и «думает» — прокрутка вниз.
  // biome-ignore lint/correctness/useExhaustiveDependencies: прокручиваем на смену длины и ожидания
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending]);

  const nodeLinks = useMemo(
    () => ({
      nodes: Object.fromEntries(
        (nodes.data?.nodes ?? []).map((node) => {
          const state = nodeState(node);
          return [node.uuid, { country: node.countryCode, state: state.label, tone: state.tone }];
        }),
      ),
      open: (uuid: string, tab?: NodeDialogTab) => {
        onClose();
        onOpenNode?.(uuid, tab);
      },
    }),
    [nodes.data, onClose, onOpenNode],
  );

  const openInChat = () => {
    if (!conversationId) return;
    try {
      localStorage.setItem(LAST_CONV_KEY, conversationId);
    } catch {
      // приватный режим браузера: беседа всё равно есть в истории
    }
    void navigate({ to: '/assistant' });
  };

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-100 bg-black/45 backdrop-blur-[2px] duration-200 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 right-0 z-100 flex w-[440px] max-w-full flex-col border-l border-border-2 bg-surface shadow-float outline-none duration-300 data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right"
        >
          <div className="flex flex-none items-center gap-2.5 border-b border-border py-3 pr-3 pl-4">
            <span className="grid size-7 flex-none place-items-center rounded-[9px] bg-ai-soft text-ai">
              <JarvisIcon className="size-[15px]" aria-hidden="true" />
            </span>
            <DialogPrimitive.Title className="min-w-0 flex-1 font-heading text-[15px] font-bold">
              Ассистент
            </DialogPrimitive.Title>
            <button
              type="button"
              onClick={openInChat}
              disabled={!conversationId}
              className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[10px] border border-border bg-surface px-3 text-[12.5px] font-medium text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground disabled:cursor-default disabled:opacity-50"
            >
              <ArrowUpRightIcon className="size-3.5" aria-hidden="true" />
              Открыть в чате
            </button>
            <DialogPrimitive.Close
              aria-label="Закрыть"
              className="grid size-9 flex-none cursor-pointer place-items-center rounded-[10px] border border-border text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground"
            >
              <XIcon className="size-4" aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>

          <NodeLinkContext.Provider value={nodeLinks}>
            <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 py-3.5">
              {status.isPending ? (
                <div className="flex flex-col gap-2.5" aria-hidden="true">
                  <span className="h-7 w-56 animate-pulse rounded-[10px] bg-surface-2" />
                  <span className="ml-auto h-10 w-64 animate-pulse rounded-[14px] bg-surface-2" />
                </div>
              ) : !enabled ? (
                <div className="mt-6 flex flex-col items-center gap-3 text-center">
                  <span className="grid size-11 place-items-center rounded-2xl bg-ai-soft text-ai">
                    <JarvisIcon className="size-5" aria-hidden="true" />
                  </span>
                  <p className="text-[14px] font-semibold">Ассистент выключен</p>
                  <p className="max-w-[300px] text-[12.5px] text-text-3">
                    Добавьте ключ модели в настройках, и Ассистент разберёт это сам.
                  </p>
                  <Link
                    to="/settings/assistant"
                    className="inline-flex h-9 items-center rounded-[10px] bg-cta px-4 text-[13px] font-semibold text-cta-foreground"
                  >
                    Настройки → Ассистент
                  </Link>
                </div>
              ) : (
                <>
                  {messages.map((m, i) => (
                    <MessageRow
                      key={m.id}
                      message={m}
                      grouped={m.role === 'assistant' && messages[i - 1]?.role === 'assistant'}
                      interim={m.role === 'assistant' && messages[i + 1]?.role === 'assistant'}
                    />
                  ))}
                  {pending && (
                    <div className="flex max-w-[86%] flex-col items-end gap-1.5 self-end">
                      {pending.first && <ContextChip label={target.label} kind={target.context.kind} />}
                      <div className="rounded-[14px] border border-brand/30 bg-brand-soft px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap break-words">
                        {pending.text}
                      </div>
                    </div>
                  )}
                  {pending && <TypingRow />}
                </>
              )}
            </div>
          </NodeLinkContext.Provider>

          {enabled && (
            <form
              className="flex-none border-t border-border p-3"
              onSubmit={(e) => {
                e.preventDefault();
                const text = input;
                setInput('');
                void ask(text, false);
              }}
            >
              <div className="flex items-end gap-2 rounded-[16px] border border-border bg-surface-2 p-2 transition-colors focus-within:border-brand/50">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                  rows={2}
                  aria-label="Вопрос Ассистенту"
                  placeholder={target.placeholder}
                  className="max-h-[160px] min-w-0 flex-1 resize-none bg-transparent px-2 py-1 text-[13.5px] leading-relaxed outline-none placeholder:text-text-3"
                />
                <button
                  type="submit"
                  aria-label="Отправить"
                  disabled={!input.trim() || Boolean(pending)}
                  className="inline-flex size-9 flex-none cursor-pointer items-center justify-center rounded-[10px] bg-cta text-cta-foreground transition-[filter,opacity] hover:brightness-105 disabled:opacity-40"
                >
                  {pending ? (
                    <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <SendIcon className="size-4" aria-hidden="true" />
                  )}
                </button>
              </div>
            </form>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
