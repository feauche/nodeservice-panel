import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CopyIcon,
  Loader2Icon,
  TriangleAlertIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { DialogPrimaryButton, DialogSecondaryButton } from '@/components/dialog-actions';
import { DialogHead, dialogBox, dialogFoot, footButton } from '@/components/dialog-parts';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { apiErrorMessage } from '@/lib/api';
import {
  CHANNEL_MBPS_MAX,
  CHANNEL_SPEED_COMMAND,
  CHANNEL_SPEEDTEST_COMMAND,
  type ChannelSpeed,
  parseChannelSpeed,
} from '@/lib/channel-speed';
import { cn } from '@/lib/utils';

/** «Мбит/с» без переноса по косой черте. */
const Mbit = () => <span className="whitespace-nowrap">Мбит/с</span>;
const mbitText = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 1 });

/** Команда в тёмном ящике с кнопкой «Копировать»: на телефоне кнопка под командой. */
function CommandBox({ command, what }: { command: string; what: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className="flex items-center gap-2 rounded-[10px] border border-border bg-bg-2 py-2 pr-2 pl-3 max-sm:flex-col max-sm:items-stretch max-sm:py-2.5">
      <code className="min-w-0 flex-1 font-mono text-[12px] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap text-foreground">
        {command}
      </code>
      <button
        type="button"
        aria-label={`Копировать: ${what}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1800);
          } catch {
            // Буфер обмена недоступен (не HTTPS или запрет браузера): команда видна, её можно выделить руками.
          }
        }}
        className={cn(
          'inline-flex h-8 flex-none cursor-pointer items-center justify-center gap-1.5 rounded-[9px] border border-border bg-surface px-2.5 text-[12px] font-medium whitespace-nowrap text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand max-sm:self-end',
          copied && 'border-ok/40 bg-ok/[0.1] text-ok hover:bg-ok/[0.1] hover:text-ok',
        )}
      >
        {copied ? (
          <CheckIcon className="size-3.5" aria-hidden="true" />
        ) : (
          <CopyIcon className="size-3.5" aria-hidden="true" />
        )}
        {copied ? 'Скопировано' : 'Копировать'}
      </button>
    </div>
  );
}

function Step({
  n,
  title,
  hint,
  children,
}: {
  n: number;
  title: string;
  hint: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[26px_minmax(0,1fr)] gap-3">
      <span
        aria-hidden="true"
        className="mt-px grid size-[26px] place-items-center rounded-full border border-border-2 bg-surface-2 text-[12.5px] font-semibold text-text-2"
      >
        {n}
      </span>
      <div className="min-w-0">
        <b className="mt-[3px] block text-[13.5px] font-semibold">{title}</b>
        <p className="mt-0.5 mb-2.5 text-[12px] leading-snug text-text-3">{hint}</p>
        {children}
      </div>
    </li>
  );
}

function Say({ tone, children }: { tone: 'ok' | 'warn'; children: ReactNode }) {
  const Icon = tone === 'ok' ? CircleCheckIcon : TriangleAlertIcon;
  return (
    <p
      role="status"
      className={cn(
        'mt-2.5 flex items-start gap-2 rounded-[10px] border px-3 py-2.5 text-[12.5px] leading-relaxed text-text-2',
        tone === 'ok' ? 'border-ok/35 bg-ok/[0.07]' : 'border-warn/35 bg-warn/[0.07]',
      )}
    >
      <Icon
        className={cn('mt-0.5 size-4 flex-none', tone === 'ok' ? 'text-ok' : 'text-warn')}
        aria-hidden="true"
      />
      <span>{children}</span>
    </p>
  );
}

/** Что панель поняла из вставленного текста — до сохранения, чтобы человек видел число, которое уйдёт. */
function Understood({ speed }: { speed: ChannelSpeed }) {
  switch (speed.kind) {
    case 'number':
      return (
        <Say tone="ok">
          <b className="font-semibold text-foreground">
            Лимит канала: {mbitText(speed.mbps)} <Mbit />.
          </b>
        </Say>
      );
    case 'measured': {
      const { download, upload } = speed;
      return (
        <Say tone="ok">
          <b className="font-semibold text-foreground">
            Лимит канала: {mbitText(speed.mbps)} <Mbit />.
          </b>{' '}
          {download != null && upload != null
            ? `Это меньшее из Download (${mbitText(Math.round(download))}) и Upload (${mbitText(Math.round(upload))}): канал считается по меньшему.`
            : `Найден только ${download != null ? 'Download' : 'Upload'}, берётся он.`}
        </Say>
      );
    }
    case 'unknown':
      return (
        <Say tone="warn">
          <b className="font-semibold text-foreground">Сервер скорость не сообщает.</b> Что делать дальше —
          ниже, в «Ошибка или −1 вместо числа?».
        </Say>
      );
    case 'range':
      return (
        <Say tone="warn">
          <b className="font-semibold text-foreground">Такая скорость не подходит.</b> Нужно число больше 0 и
          не больше {mbitText(CHANNEL_MBPS_MAX)} <Mbit />.
        </Say>
      );
    case 'unclear':
      return (
        <Say tone="warn">
          <b className="font-semibold text-foreground">Число не найдено.</b> Впишите скорость цифрами,
          например 1000, или вставьте вывод команды целиком.
        </Say>
      );
    default:
      return null;
  }
}

/**
 * «Лимит канала» окном по шагам (витрина channel-limit-2026-10, вариант C): команда с «Копировать», поле, в которое
 * вставляют вывод, и пояснение, что панель из него поняла. Панель сама на ноды ничего не отправляет — команду
 * запускает человек. Сохранение — на вызывающем: onSubmit получает число в Мбит/с (ошибка показывается в окне).
 */
export function ChannelLimitDialog({
  nodeName,
  submitLabel = 'Сохранить',
  hint = 'Лимит нужен только для расчёта запаса.',
  onSubmit,
  onClose,
}: {
  nodeName: string;
  submitLabel?: string;
  hint?: string;
  onSubmit: (mbps: number) => void | Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [fallback, setFallback] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const speed = useMemo(() => parseChannelSpeed(text), [text]);
  const mbps = speed.kind === 'number' || speed.kind === 'measured' ? speed.mbps : null;
  // Сервер не сообщает скорость — запасной способ сразу виден, искать его не нужно.
  useEffect(() => {
    if (speed.kind === 'unknown') setFallback(true);
  }, [speed.kind]);

  async function submit() {
    if (mbps == null) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(mbps);
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent showCloseButton={false} className={cn(dialogBox, 'sm:max-w-[580px]')}>
        <DialogHead
          title={`Лимит канала · ${nodeName}`}
          description="Нужен, чтобы посчитать, сколько ещё выдержит нода."
        />
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 max-sm:px-4">
          <ol aria-label="Шаги" className="flex flex-col gap-5">
            <Step
              n={1}
              title="Выполните на сервере ноды"
              hint={
                <>
                  Команда выведет скорость сетевой карты в <Mbit />, например 1000.
                </>
              }
            >
              <CommandBox command={CHANNEL_SPEED_COMMAND} what="команда скорости сетевой карты" />
            </Step>
            <Step
              n={2}
              title="Вставьте то, что вывела команда"
              hint="Подойдёт и число, и весь вывод замера скорости — число будет найдено само."
            >
              <textarea
                aria-label="Вывод команды или скорость канала"
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setError(null);
                }}
                rows={4}
                spellCheck={false}
                autoComplete="off"
                placeholder="Вставьте сюда вывод команды или впишите число"
                className="min-h-[84px] w-full resize-y rounded-[10px] border border-border bg-surface-2 px-3 py-2.5 font-mono text-[12.5px] leading-relaxed outline-none placeholder:font-sans placeholder:text-[13.5px] placeholder:text-text-3 focus:border-brand/60 focus-visible:ring-3 focus-visible:ring-brand/20"
              />
              <Understood speed={speed} />
            </Step>
          </ol>
          <div className="mt-5 flex flex-col gap-2.5">
            <button
              type="button"
              aria-expanded={fallback}
              onClick={() => setFallback((v) => !v)}
              className="inline-flex w-fit cursor-pointer items-center gap-1.5 text-[12.5px] font-medium text-brand hover:underline focus-visible:outline-2 focus-visible:outline-brand"
            >
              {fallback ? (
                <ChevronDownIcon className="size-3.5" aria-hidden="true" />
              ) : (
                <ChevronRightIcon className="size-3.5" aria-hidden="true" />
              )}
              Ошибка или −1 вместо числа?
            </button>
            {fallback && (
              <>
                <p
                  role="note"
                  className="flex items-start gap-2 rounded-[10px] border border-warn/35 bg-warn/[0.07] px-3 py-2.5 text-[12.5px] leading-relaxed text-text-2"
                >
                  <TriangleAlertIcon className="mt-0.5 size-4 flex-none text-warn" aria-hidden="true" />
                  <span>
                    Сервер скорость не сообщает — на виртуальных серверах так бывает. Возьмите её из тарифа
                    хостера или замерьте командой ниже и впишите меньшее из Download и Upload.
                  </span>
                </p>
                <CommandBox command={CHANNEL_SPEEDTEST_COMMAND} what="команда замера скорости" />
                <p className="text-[12px] leading-snug text-text-3">
                  Бывает и наоборот: виртуальная сетевая карта пишет 10000, а по тарифу у вас 1000. Тогда
                  верьте тарифу.
                </p>
              </>
            )}
          </div>
          {error && (
            <p
              role="alert"
              className="mt-4 rounded-[10px] border border-crit/30 bg-crit-soft px-3 py-2 text-[12.5px] text-crit"
            >
              {error}
            </p>
          )}
        </div>
        <div className={dialogFoot}>
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">{hint}</p>
          <div className="flex gap-2 max-sm:flex-col">
            <DialogSecondaryButton disabled={busy} onClick={onClose} className={footButton}>
              Отмена
            </DialogSecondaryButton>
            <DialogPrimaryButton
              disabled={busy || mbps == null}
              onClick={() => void submit()}
              className="h-10 min-w-[128px] flex-none rounded-[10px] px-4 whitespace-nowrap max-sm:w-full sm:w-auto sm:flex-none sm:max-w-none"
            >
              {busy && <Loader2Icon className="animate-spin" aria-hidden="true" />}
              {submitLabel}
            </DialogPrimaryButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
