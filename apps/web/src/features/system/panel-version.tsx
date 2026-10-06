import { CheckIcon, CopyIcon, ExternalLinkIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { usePanelRelease } from './panel-release-api';

const UPDATE_COMMAND = 'nodeservice update';

function releaseLines(notes: string | null | undefined): string[] {
  if (!notes) return [];
  return notes
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('```'))
    .map((line) =>
      line
        .replace(/^[-*]\s+/, '')
        .replace(/\[([^\]]+)]\(https?:\/\/[^)]+\)/g, '$1')
        .replace(/\*\*(.+?)\*\*/g, '$1'),
    )
    .filter((line) => !/^full changelog:?/i.test(line) && line !== UPDATE_COMMAND)
    .filter((line, index, all) => all.indexOf(line) === index);
}

function ruDate(value: string | null | undefined): string | null {
  if (!value) return null;
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(
    new Date(value),
  );
}

function ruBuildDate(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    ...(value.includes('T') ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(date);
}

export function PanelVersion({
  version,
  commit,
  builtAt,
}: {
  version: string;
  commit?: string;
  builtAt?: string;
}) {
  const release = usePanelRelease();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<'update' | 'commit' | null>(null);
  const available = release.data?.status === 'available' && release.data.latestVersion;
  const shownVersion = version === 'dev' ? (release.data?.currentVersion ?? version) : version;
  const lines = releaseLines(release.data?.release?.notes);
  const buildDate = ruBuildDate(builtAt);
  const shortCommit = commit && commit.length > 10 ? commit.slice(0, 7) : commit;
  const buildSummary = [shortCommit ? `сборка ${shortCommit}` : null, buildDate ? `от ${buildDate}` : null]
    .filter(Boolean)
    .join(' ');

  const copy = async (kind: 'update' | 'commit', value: string) => {
    await navigator.clipboard?.writeText(value);
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1_500);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button
        type="button"
        data-testid="panel-version"
        onClick={() => setOpen(true)}
        title={
          available
            ? `Установлена v${shownVersion} · доступна v${available}`
            : `NodeService v${shownVersion}${buildSummary ? ` · ${buildSummary}` : ''}`
        }
        className={cn(
          'inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-[10px] border px-2.5 font-mono text-[11px] font-semibold transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand',
          available
            ? 'border-warn/40 bg-warn-soft text-warn hover:border-warn/60 hover:bg-warn-soft/80'
            : 'border-border bg-surface text-text-3 hover:border-border-2 hover:text-text-2',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'size-1.5 rounded-full',
            available ? 'bg-warn shadow-[0_0_8px_var(--ns-warn)]' : 'bg-text-3/60',
          )}
        />
        {available ? <span className="font-sans">Доступна v{available}</span> : <span>v{shownVersion}</span>}
      </button>

      <DialogContent
        className={cn(
          'grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-2xl border-border bg-surface p-0 max-md:max-w-[calc(100%-16px)] sm:max-w-[620px]',
          available
            ? 'h-[620px] max-h-[calc(100dvh-40px)] max-md:h-[calc(100dvh-24px)] max-md:max-h-none'
            : 'max-h-[calc(100dvh-40px)] max-md:max-h-[calc(100dvh-16px-env(safe-area-inset-top)-env(safe-area-inset-bottom))]',
        )}
      >
        <DialogHeader className="border-b border-border px-5 py-4 pr-12">
          <DialogTitle className="font-heading text-[17px]">Версия NodeService</DialogTitle>
          <DialogDescription>Стабильные версии панели публикуются как GitHub Release.</DialogDescription>
        </DialogHeader>

        <div
          data-testid="panel-version-scroll"
          className="min-h-0 touch-pan-y overflow-y-auto overscroll-contain p-5 [-webkit-overflow-scrolling:touch]"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-border bg-surface-2/50 p-3.5">
              <div className="text-[11px] font-semibold tracking-[0.08em] text-text-3 uppercase">
                Установлена
              </div>
              <div className="mt-1.5 font-mono text-[17px] font-semibold text-foreground">
                v{shownVersion}
              </div>
              {buildDate && <div className="mt-1 text-[11.5px] text-text-3">Собрана {buildDate}</div>}
            </div>
            <div
              className={cn(
                'rounded-xl border p-3.5',
                available ? 'border-warn/35 bg-warn-soft/45' : 'border-border bg-surface-2/50',
              )}
            >
              <div className="text-[11px] font-semibold tracking-[0.08em] text-text-3 uppercase">
                Последний релиз
              </div>
              <div className={cn('mt-1.5 font-mono text-[17px] font-semibold', available && 'text-warn')}>
                {release.data?.latestVersion ? `v${release.data.latestVersion}` : '—'}
              </div>
              {release.data?.release?.publishedAt && (
                <div className="mt-1 text-[11.5px] text-text-3">
                  {ruDate(release.data.release.publishedAt)}
                </div>
              )}
            </div>
          </div>

          {commit && (
            <div className="mt-2 flex min-w-0 items-center gap-3 rounded-xl border border-border bg-surface-2/50 px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-[10.5px] font-semibold tracking-[0.08em] text-text-3 uppercase">
                  Сборка
                </div>
                <code className="mt-1 block break-all font-mono text-[11.5px] leading-relaxed text-text-2">
                  {commit}
                </code>
              </div>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="flex-none"
                title="Скопировать хэш сборки"
                aria-label="Скопировать хэш сборки"
                onClick={() => void copy('commit', commit)}
              >
                {copied === 'commit' ? <CheckIcon /> : <CopyIcon />}
              </Button>
            </div>
          )}

          {available ? (
            <div className="mt-4">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-warn">
                <span className="size-2 rounded-full bg-warn shadow-[0_0_10px_var(--ns-warn)]" />
                Доступна новая версия
              </div>
              {lines.length > 0 && (
                <ul className="mt-3 grid gap-2 pl-0 text-[12.5px] leading-relaxed text-text-2">
                  {lines.map((line) => (
                    <li key={line} className="flex gap-2">
                      <span className="mt-[7px] size-1 shrink-0 rounded-full bg-text-3" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-4 rounded-xl border border-border bg-[#0b0e14] p-3">
                <div className="mb-2 text-[11.5px] text-text-3">Обновить на сервере панели:</div>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-foreground">
                    {UPDATE_COMMAND}
                  </code>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void copy('update', UPDATE_COMMAND)}
                  >
                    {copied === 'update' ? <CheckIcon /> : <CopyIcon />}
                    {copied === 'update' ? 'Скопировано' : 'Копировать'}
                  </Button>
                </div>
              </div>
            </div>
          ) : release.data?.status === 'unavailable' || release.isError ? (
            <p className="mt-4 rounded-xl border border-border bg-surface-2/50 p-3 text-[12.5px] leading-relaxed text-text-2">
              Установленная версия известна, но GitHub сейчас не ответил. Панель повторит проверку сама.
            </p>
          ) : (
            <p className="mt-4 flex items-center gap-2 text-[12.5px] text-ok">
              <CheckIcon className="size-4" /> Установлена последняя стабильная версия.
            </p>
          )}
        </div>

        {release.data?.release?.url && (
          <div className="flex justify-end border-t border-border bg-surface-2/35 px-5 py-3.5">
            <Button asChild variant="outline">
              <a href={release.data.release.url} target="_blank" rel="noreferrer">
                <ExternalLinkIcon /> Открыть GitHub Release
              </a>
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
