import '@xterm/xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { BookmarkIcon, MaximizeIcon, MinusIcon, SettingsIcon, SparklesIcon, XIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Rnd } from 'react-rnd';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSnippets } from '@/features/settings/settings-api';
import { cn } from '@/lib/utils';
import { SnippetsDialog } from './snippets-dialog';
import { HINT_LINES, TerminalHints } from './terminal-hints';
import type { TerminalTarget } from './terminal-store';
import { useTerminalSocket } from './use-terminal-socket';

const DEFAULT_W = 520;
const DEFAULT_H = 330;
const HINTS_W = 320;
const MIN_W = 420;
const HINTS_H = 460;
const HINTS_H_COMPACT = 520;

interface Geom {
  x: number;
  y: number;
  width: number;
  height: number;
}

function defaultGeom(): Geom {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const h = typeof window !== 'undefined' ? window.innerHeight : 800;
  // На телефоне окно не шире экрана: раньше оно вылезало за правый край.
  const width = Math.min(DEFAULT_W, w - 24);
  return {
    width,
    height: DEFAULT_H,
    x: Math.max(12, w - width - 28),
    y: Math.max(12, h - DEFAULT_H - 26),
  };
}

/** Тема xterm из наших токенов (getComputedStyle корня). */
function xtermTheme(): Record<string, string> {
  const read = (name: string, fallback: string) => {
    if (typeof window === 'undefined') return fallback;
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  };
  const surface = read('--ns-surface', '#0f1216');
  const text = read('--ns-text', '#e6e8eb');
  const accent = read('--ns-accent', '#6ea8fe');
  return {
    background: surface,
    foreground: text,
    cursor: accent,
    cursorAccent: surface,
    selectionBackground: 'rgba(110,168,254,0.28)',
  };
}

/**
 * Плавающее окно веб-терминала — хром 1:1 с демо (#term): react-rnd, шапка-ручка,
 * кнопки очистить / на весь экран / закрыть; тело — xterm. Esc закрывает.
 */
export function TerminalWindow({ server, onClose }: { server: TerminalTarget; onClose: () => void }) {
  const socket = useTerminalSocket(server);
  const { status, error, bindSink, sendInput, sendResize, reopen } = socket;

  const bodyRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [geom, setGeom] = useState<Geom>(() => defaultGeom());
  const [fullscreen, setFullscreen] = useState(false);
  const prevGeom = useRef<Geom | null>(null);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [hintsOpen, setHintsOpen] = useState(false);
  /** На сколько окно расширили под панель подсказок, чтобы при закрытии вернуть прежнюю ширину. */
  const hintsGrow = useRef({ w: 0, h: 0 });
  const snippets = useSnippets();

  /** Вставить команду в строку ввода (без Enter) и вернуть фокус в терминал. */
  const insertSnippet = useCallback(
    (command: string) => {
      sendInput(command);
      termRef.current?.focus();
    },
    [sendInput],
  );

  /** Последние строки экрана терминала для подсказки (то, что видит администратор). */
  const readRecent = useCallback((): string => {
    const term = termRef.current;
    if (!term) return '';
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = Math.max(0, buf.length - HINT_LINES); i < buf.length; i += 1)
      lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n').trimEnd();
  }, []);

  /**
   * Панель подсказок расширяет окно вправо, а не отнимает ширину у терминала; на узком экране она
   * ложится поверх низа окна, и окно только вытягивается вверх, чтобы хватило места.
   */
  const toggleHints = useCallback(() => {
    setHintsOpen((open) => {
      const next = !open;
      if (!fullscreen)
        setGeom((g) => {
          const compact = window.innerWidth < 768;
          if (next) {
            const width = compact ? g.width : Math.min(window.innerWidth - 24, g.width + HINTS_W);
            const height = Math.min(
              window.innerHeight - 24,
              Math.max(g.height, compact ? HINTS_H_COMPACT : HINTS_H),
            );
            hintsGrow.current = { w: width - g.width, h: height - g.height };
            return {
              ...g,
              width,
              height,
              x: Math.max(12, Math.min(g.x, window.innerWidth - 12 - width)),
              y: Math.max(12, Math.min(g.y, window.innerHeight - 12 - height)),
            };
          }
          const grow = hintsGrow.current;
          hintsGrow.current = { w: 0, h: 0 };
          return {
            ...g,
            width: Math.max(Math.min(MIN_W, window.innerWidth - 24), g.width - grow.w),
            height: Math.max(260, g.height - grow.h),
          };
        });
      return next;
    });
  }, [fullscreen]);

  const connected = status === 'connected';

  // xterm — один раз на монтирование окна.
  // biome-ignore lint/correctness/useExhaustiveDependencies: инициализация один раз
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    let term: Terminal;
    let fit: FitAddon;
    try {
      term = new Terminal({
        fontFamily:
          '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.35,
        cursorBlink: true,
        theme: xtermTheme(),
        scrollback: 5000,
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.open(el);
      fit.fit();
    } catch {
      // В jsdom/без DOM-метрик xterm может не инициализироваться — окно и статусы работают без него.
      return;
    }
    termRef.current = term;
    fitRef.current = fit;
    bindSink({ write: (d) => term.write(d) });
    const disp = term.onData((d) => sendInput(d));

    const refit = () => {
      try {
        fit.fit();
        sendResize(term.cols, term.rows);
        // После смены размера xterm может остаться прокрученным не до конца — держим последнюю строку видимой.
        term.scrollToBottom();
      } catch {
        /* размер ещё не готов */
      }
    };
    const ro = new ResizeObserver(refit);
    ro.observe(el);
    // Первый fit считает строки по метрикам запасного шрифта: моноширинный ещё грузится, строк выходит
    // больше, чем влезает, и низ обрезается до первого ввода. Пересчитываем, когда шрифты готовы и
    // когда закончилась анимация появления окна.
    const fontsReady = document.fonts?.ready;
    let alive = true;
    void fontsReady?.then(() => alive && refit());
    const onAnimEnd = () => refit();
    el.parentElement?.parentElement?.addEventListener('animationend', onAnimEnd);
    const late = setTimeout(refit, 350);

    return () => {
      alive = false;
      clearTimeout(late);
      el.parentElement?.parentElement?.removeEventListener('animationend', onAnimEnd);
      ro.disconnect();
      disp.dispose();
      bindSink(null);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Фокус в терминал, как только сессия готова.
  useEffect(() => {
    if (connected) {
      try {
        fitRef.current?.fit();
        termRef.current?.scrollToBottom();
        termRef.current?.focus();
      } catch {
        /* нет метрик */
      }
    }
  }, [connected]);

  // Esc закрывает окно.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleFullscreen = useCallback(() => {
    setFullscreen((f) => {
      if (!f) {
        prevGeom.current = geom;
        setGeom({ x: 12, y: 12, width: window.innerWidth - 24, height: window.innerHeight - 24 });
        return true;
      }
      if (prevGeom.current) setGeom(prevGeom.current);
      return false;
    });
  }, [geom]);

  return (
    <Rnd
      size={{ width: geom.width, height: geom.height }}
      position={{ x: geom.x, y: geom.y }}
      minWidth={Math.min(MIN_W, typeof window !== 'undefined' ? window.innerWidth - 24 : MIN_W)}
      minHeight={260}
      bounds="window"
      dragHandleClassName="ns-term-drag"
      onDragStop={(_e, d) => setGeom((g) => ({ ...g, x: d.x, y: d.y }))}
      onResizeStop={(_e, _dir, ref, _delta, pos) =>
        setGeom({ width: ref.offsetWidth, height: ref.offsetHeight, x: pos.x, y: pos.y })
      }
      enableResizing={!fullscreen}
      disableDragging={fullscreen}
      style={{ position: 'fixed' }}
      className="z-90"
    >
      <div
        role="dialog"
        data-terminal-window=""
        aria-label={`Терминал ${server.name}`}
        className="animate-[ns-term-in_0.24s_ease] flex h-full w-full flex-col overflow-hidden rounded-[14px] border border-border-2 bg-surface shadow-float"
        // Скрытое поле ввода xterm при фокусе «подтягивает» себя в видимую область и прокручивает
        // окно вместе с шапкой. Окно прокручиваться не должно никогда.
        onScroll={(e) => {
          e.currentTarget.scrollTop = 0;
          e.currentTarget.scrollLeft = 0;
        }}
      >
        {/* Шапка-ручка */}
        <div className="ns-term-drag flex flex-none cursor-grab touch-none items-center gap-2.5 border-b border-border bg-surface-2 px-[13px] py-2.5 select-none active:cursor-grabbing">
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-2">
            SSH ·{' '}
            <b className="font-semibold text-foreground">
              {server.sshUser}@{server.host}:{server.port}
            </b>
          </span>
          <div className="flex flex-none gap-[3px]">
            <button
              type="button"
              title="Подсказки ассистента"
              aria-label="Подсказки ассистента"
              aria-pressed={hintsOpen}
              disabled={!connected}
              onClick={toggleHints}
              className={cn(
                'grid size-[26px] cursor-pointer place-items-center rounded-[6px] text-text-3 transition-colors hover:bg-surface-3 hover:text-ai disabled:cursor-default disabled:opacity-40',
                hintsOpen && 'bg-surface-3 text-ai',
              )}
            >
              <SparklesIcon className="size-3.5" aria-hidden="true" />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                title="Сниппеты"
                aria-label="Сниппеты"
                disabled={!connected}
                className="grid size-[26px] cursor-pointer place-items-center rounded-[6px] text-text-3 transition-colors hover:bg-surface-3 hover:text-foreground disabled:cursor-default disabled:opacity-40 aria-expanded:bg-surface-3 aria-expanded:text-foreground"
              >
                <BookmarkIcon className="size-3.5" aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                sideOffset={6}
                className="z-[110] w-[300px] rounded-[12px] border border-border-2 p-1.5 shadow-float"
              >
                <DropdownMenuLabel className="px-2.5 pt-1.5 pb-1 text-[10.5px] font-semibold tracking-[0.1em] text-text-3 uppercase">
                  Сниппеты
                </DropdownMenuLabel>
                {(snippets.data?.items.length ?? 0) === 0 ? (
                  <div className="px-2.5 py-2 text-[12.5px] text-text-3">
                    Пока пусто. Добавьте команды, которые вводите чаще всего.
                  </div>
                ) : (
                  snippets.data?.items.map((sn) => (
                    <DropdownMenuItem
                      key={sn.id}
                      onSelect={() => insertSnippet(sn.command)}
                      className="flex-col items-start gap-0.5 rounded-[9px] px-2.5 py-2"
                    >
                      <span className="text-[13px] font-medium">{sn.name}</span>
                      <span className="max-w-full truncate font-mono text-[11.5px] text-text-3">
                        {sn.command}
                      </span>
                    </DropdownMenuItem>
                  ))
                )}
                <DropdownMenuSeparator className="my-1" />
                <DropdownMenuItem
                  onSelect={() => setSnippetsOpen(true)}
                  className="gap-2 rounded-[9px] px-2.5 py-2 text-[12.5px] text-text-2 [&_svg]:size-3.5"
                >
                  <SettingsIcon aria-hidden="true" />
                  Настроить сниппеты
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              title="Очистить"
              aria-label="Очистить"
              onClick={() => termRef.current?.clear()}
              className="grid size-[26px] place-items-center rounded-[6px] text-text-3 transition-colors hover:bg-surface-3 hover:text-foreground"
            >
              <MinusIcon className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              title={fullscreen ? 'Свернуть окно' : 'На весь экран'}
              aria-label={fullscreen ? 'Свернуть окно' : 'На весь экран'}
              onClick={toggleFullscreen}
              className="grid size-[26px] place-items-center rounded-[6px] text-text-3 transition-colors hover:bg-surface-3 hover:text-foreground"
            >
              <MaximizeIcon className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              title="Закрыть"
              aria-label="Закрыть"
              onClick={onClose}
              className="grid size-[26px] place-items-center rounded-[6px] text-text-3 transition-colors hover:bg-crit-soft hover:text-crit"
            >
              <XIcon className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Тело: xterm + оверлеи состояний; справа, если открыта, панель подсказок */}
        <div className="relative flex min-h-0 flex-1 bg-surface">
          <div className="relative min-w-0 flex-1">
            <div ref={bodyRef} className="absolute inset-0 overflow-hidden px-[15px] py-[13px]" />
            {(status === 'auth' || status === 'connecting') && <ConnectingOverlay server={server} />}
            {(status === 'closed' || status === 'error') && <EndedOverlay error={error} onReopen={reopen} />}
          </div>
          {hintsOpen && (
            <TerminalHints
              serverId={server.id}
              readRecent={readRecent}
              onInsert={insertSnippet}
              onClose={toggleHints}
              className={cn(
                'w-[320px] flex-none border-l border-border',
                'max-md:absolute max-md:inset-x-0 max-md:bottom-0 max-md:h-[62%] max-md:w-auto max-md:border-t max-md:border-l-0',
              )}
            />
          )}
        </div>
      </div>
      <SnippetsDialog open={snippetsOpen} onOpenChange={setSnippetsOpen} />
    </Rnd>
  );
}

function ConnectingOverlay({ server }: { server: TerminalTarget }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-surface px-[15px] py-[13px]">
      <div className="w-full max-w-[420px]">
        <div className="mb-3 flex items-center gap-2.5 font-mono text-[12px] text-text-2">
          <span
            className="size-[15px] flex-none animate-[ns-spin_0.7s_linear_infinite] rounded-full border-2 border-border-2 border-t-brand"
            aria-hidden="true"
          />
          Подключение по SSH к {server.sshUser}@{server.host} …
        </div>
        {[68, 84, 52, 73, 40].map((w) => (
          <div
            key={w}
            className="my-2 h-[11px] rounded-[6px] bg-gradient-to-r from-surface-2 via-surface-3 to-surface-2 bg-[length:200%_100%] animate-[ns-shimmer_1.15s_linear_infinite]"
            style={{ width: `${w}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function EndedOverlay({ error, onReopen }: { error: string | null; onReopen: () => void }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-surface px-6 text-center">
      <div className="flex flex-col items-center gap-2">
        <p className={cn('text-[13.5px] font-semibold', error ? 'text-crit' : 'text-foreground')}>
          {error ? 'Терминал не открылся' : 'Сессия завершена'}
        </p>
        {error && <p className="max-w-[360px] text-[12px] text-text-3">{error}</p>}
        <button
          type="button"
          onClick={onReopen}
          className="mt-1 inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-cta px-4 text-[13px] font-semibold text-cta-foreground hover:bg-(--ns-cta-hover)"
        >
          Открыть заново
        </button>
      </div>
    </div>
  );
}
