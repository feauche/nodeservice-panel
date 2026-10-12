import type { AssistantCitation, AssistantMessage } from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';
import { AlertTriangleIcon, BookOpenIcon, FileClockIcon, ServerIcon } from 'lucide-react';
import { type ComponentType, type SVGProps, useContext } from 'react';
import { JarvisIcon } from '@/components/jarvis-icon';
import { Markdown, NodeLinkContext } from '@/features/knowledge/markdown';
import { useNodes } from '@/features/nodes/nodes-api';
import { cn } from '@/lib/utils';
import { AdviceList } from './advice-card';
import { linkifyNodes } from './link-nodes';

/** Строки переписки с Ассистентом: общие для страницы «Ассистент» и боковой панели «Спросить Ассистента». */
export function TypingRow() {
  return (
    <div
      role="status"
      aria-label="Ассистент думает"
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

export function Avatar() {
  return (
    <span
      data-testid="assistant-avatar"
      className="grid size-8 flex-none place-items-center rounded-[10px] bg-brand-soft text-brand"
    >
      <JarvisIcon className="size-4" aria-hidden="true" />
    </span>
  );
}

export function MessageRow({
  message,
  grouped = false,
  interim = false,
  searchMatch = false,
  searchActive = false,
}: {
  message: AssistantMessage;
  /** Сообщение идёт следом за другим ответом Ассистента: значка нет, вместо него пустое место. */
  grouped?: boolean;
  /** За ним идёт ещё ответ: это «сейчас посмотрю», приглушаем и не выделяем. */
  interim?: boolean;
  /** Сообщение содержит поисковый запрос; активное дополнительно выделяется и прокручивается в центр. */
  searchMatch?: boolean;
  searchActive?: boolean;
}) {
  const nodes = useNodes();
  if (message.role === 'user')
    return (
      <div
        data-assistant-message-id={message.id}
        data-search-current={searchActive ? 'true' : undefined}
        className="flex max-w-[80%] flex-col items-end gap-1.5 self-end animate-in fade-in-0 slide-in-from-bottom-1 duration-200"
      >
        {message.context && <ContextChip label={message.context.label} kind={message.context.kind} />}
        <div
          data-testid="assistant-user-message"
          className={cn(
            'rounded-[14px] border border-brand/30 bg-brand-soft px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap break-words text-foreground transition-shadow',
            searchMatch && 'ring-1 ring-warn/45',
            searchActive && 'ring-2 ring-brand ring-offset-2 ring-offset-surface',
          )}
        >
          {message.content}
        </div>
      </div>
    );

  return (
    <div
      data-assistant-message-id={message.id}
      data-search-current={searchActive ? 'true' : undefined}
      className={cn(
        'flex max-w-[92%] gap-3 rounded-xl px-1 py-1 animate-in fade-in-0 slide-in-from-bottom-1 duration-200',
        grouped && '-mt-2',
        searchMatch && 'bg-warn-soft/45 ring-1 ring-warn/35',
        searchActive && 'bg-brand-soft ring-2 ring-brand/55',
      )}
    >
      {grouped ? <span className="size-8 flex-none" aria-hidden="true" /> : <Avatar />}
      <div className={cn('min-w-0 flex-1', grouped && !interim && 'border-t border-border pt-2.5')}>
        {/* В старых беседах у ответа бывают карточки действий, проверок и хода работы: их больше нет,
            остаётся текст ответа и источники. */}
        <Markdown
          content={linkifyNodes(message.content, nodes.data?.nodes ?? [])}
          className={cn('-my-1 text-[13.5px]', interim && '[&_p]:text-text-3')}
        />
        {message.citations.length > 0 && <Sources citations={message.citations} />}
        <AdviceList advice={message.advice ?? []} />
      </div>
    </div>
  );
}

const CITE_META: Record<
  AssistantCitation['type'],
  { label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }
> = {
  kb: { label: 'База знаний', icon: BookOpenIcon },
  incident: { label: 'Событие', icon: AlertTriangleIcon },
  audit: { label: 'Журнал', icon: FileClockIcon },
  server: { label: 'Прежняя нода', icon: ServerIcon },
  node: { label: 'Нода', icon: ServerIcon },
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
  const nodeContext = useContext(NodeLinkContext);
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
  if (citation.type === 'node')
    return (
      <button
        type="button"
        title={title}
        disabled={!nodeContext.nodes[citation.id]}
        onClick={() => nodeContext.open(citation.id)}
        className={cn(base, interactive, 'disabled:cursor-default disabled:opacity-60')}
      >
        {inner}
      </button>
    );
  // Старые серверы, метрики и журнал — простая метка без перехода.
  return (
    <span title={title} className={base}>
      {inner}
    </span>
  );
}

/** Метка над вопросом: задан со страницы события или из окна ноды. */
export function ContextChip({ label, kind }: { label: string; kind: 'incident' | 'node' }) {
  const Icon = kind === 'incident' ? AlertTriangleIcon : ServerIcon;
  return (
    <span
      data-testid="assistant-context"
      className="inline-flex max-w-full items-center gap-1.5 rounded-[10px] border border-ai/35 bg-ai-soft px-2.5 py-1 text-[12px] font-semibold text-ai"
    >
      <Icon className="size-3.5 flex-none" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  );
}
