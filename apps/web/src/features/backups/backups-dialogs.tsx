import {
  BACKUP_RESTORE_CONFIRM,
  BACKUP_STAGE_LABELS,
  BACKUP_STAGES,
  type BackupInspect,
  type BackupItem,
  type BackupStage,
  type BackupsResponse,
} from '@nodeservice/shared';
import { useQuery } from '@tanstack/react-query';
import {
  CheckIcon,
  DownloadIcon,
  Loader2Icon,
  RotateCcwIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UploadIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { DialogActions, DialogPrimaryButton, DialogSecondaryButton } from '@/components/dialog-actions';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { StepUpCancelledError } from '@/features/security/step-up';
import { apiErrorMessage, isApiError } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { backupsApi, uploadBackup, useDeleteBackup, useRestoreBackup, useRunBackup } from './backups-api';
import { formatSize, formatWhen } from './backups-format';

/* ─────────── общее ─────────── */

function Shell({
  open,
  onOpenChange,
  icon,
  tone,
  title,
  description,
  children,
  lock,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  icon: ReactNode;
  tone: 'brand' | 'warn' | 'crit';
  title: string;
  description: ReactNode;
  children: ReactNode;
  /** Идёт необратимое действие — окно не закрывается. */
  lock?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !lock && onOpenChange(o)}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => lock && e.preventDefault()}
        onPointerDownOutside={(e) => lock && e.preventDefault()}
        className="max-h-[calc(100vh-48px)] overflow-y-auto rounded-2xl border-border-2 bg-surface p-6 sm:max-w-[540px]"
      >
        <DialogHeader className="flex-row items-start gap-3 text-left">
          <span
            className={cn(
              'grid size-10 flex-none place-items-center rounded-[11px] [&_svg]:size-[18px]',
              tone === 'brand' && 'bg-brand-soft text-brand',
              tone === 'warn' && 'bg-warn-soft text-warn',
              tone === 'crit' && 'bg-crit-soft text-crit',
            )}
          >
            {icon}
          </span>
          <div className="min-w-0">
            <DialogTitle className="font-heading text-[17px] leading-snug">{title}</DialogTitle>
            <DialogDescription className="mt-1 text-[12.5px] text-text-3">{description}</DialogDescription>
          </div>
        </DialogHeader>
        <div className="mt-4 flex flex-col gap-3.5 text-[13px]">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

function WarnBox({ tone = 'warn', children }: { tone?: 'warn' | 'crit'; children: ReactNode }) {
  return (
    <div
      className={cn(
        'flex gap-2.5 rounded-[11px] border px-3.5 py-3 text-[12.5px] leading-relaxed',
        tone === 'warn' ? 'border-warn/30 bg-warn-soft' : 'border-crit/30 bg-crit-soft',
      )}
    >
      <TriangleAlertIcon
        className={cn('mt-0.5 size-4 flex-none', tone === 'warn' ? 'text-warn' : 'text-crit')}
        aria-hidden="true"
      />
      <div>{children}</div>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[12.5px] font-semibold">
        {label}
      </label>
      {children}
      {hint && <div className="text-[11.5px] text-text-3">{hint}</div>}
    </div>
  );
}

const inputClass = 'h-10 rounded-[10px] bg-surface-2 text-[13.5px]';

/* ─────────── «Сделать копию сейчас» ─────────── */

const VISIBLE_STAGES: BackupStage[] = BACKUP_STAGES.filter((s) => s !== 'cleanup');

/** Копия, за ходом которой следит окно. */
interface Watch {
  /** Имена копий, которые были до неё: готовая копия — та, чьего имени среди них нет. */
  known: ReadonlySet<string>;
  /** Отметка списка копий на момент запуска: перечитанный после неё список уже знает об этой копии. */
  since: number;
  /** Копию застали уже идущей (по расписанию или свою после «Свернуть»), а не запустили из этого окна. */
  found: boolean;
}

/**
 * Имена копий, которые были до запуска, начавшегося в `startedAt`. Оба времени — с сервера: файл идущей
 * копии появляется в списке раньше её конца (перед отправкой в Telegram), и «прежним» он считаться не должен.
 */
function namesBefore(items: BackupItem[], startedAt: string | null): Set<string> {
  const from = startedAt ? Date.parse(startedAt) : Number.NaN;
  return new Set(items.filter((i) => !(Date.parse(i.createdAt) >= from)).map((i) => i.name));
}

export function RunDialog({
  open,
  onOpenChange,
  data,
  updatedAt,
  telegramReady,
  telegramDefault,
  telegramWhere,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  data: BackupsResponse | undefined;
  /** Отметка списка копий: когда он перечитан в последний раз. */
  updatedAt: number;
  /** Отправка в Telegram настроена (чат выбран). */
  telegramReady: boolean;
  telegramDefault: boolean;
  telegramWhere: string | null;
}) {
  const run = useRunBackup();
  const [send, setSend] = useState(telegramDefault);
  const [watch, setWatch] = useState<Watch | null>(null);
  useEffect(() => {
    if (open) setSend(telegramDefault && telegramReady);
  }, [open, telegramDefault, telegramReady]);
  // Окно открыли заново — за прошлой копией больше не следим.
  useEffect(() => {
    if (open) setWatch(null);
  }, [open]);

  const live = data?.run.mode === 'backup' && data.run.stage ? data.run : null;
  // Копия уже идёт (по расписанию или своя после «Свернуть») — окно показывает её ход. Форма запуска —
  // только когда ничего не идёт: иначе «Сделать копию» упирается в «Копия уже делается».
  if (open && data && live && !watch && !run.isPending)
    setWatch({ known: namesBefore(data.items, live.startedAt), since: 0, found: true });

  const stage = live?.stage ?? null;
  // Пока список не перечитан после запуска, в кэше прежний: копии в нём ещё нет, а ошибка — от прошлой
  // попытки. По нему итог не объявляем — показываем «Начинаю…».
  const aware = watch !== null && updatedAt !== watch.since;
  const finished = aware && !stage;
  const failed = finished ? (data?.run.lastError ?? null) : null;
  const made = watch && finished && !failed ? data?.items.find((i) => !watch.known.has(i.name)) : undefined;

  const start = async () => {
    // Готовую копию узнаём по имени, которого до запуска не было. Время копии с часами компьютера не
    // сравниваем: если они спешат, удачная копия выглядела бы проваленной.
    const known = new Set(data?.items.map((i) => i.name));
    try {
      const since = await run.mutateAsync(send);
      setWatch({ known, since, found: false });
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      icon={<DownloadIcon aria-hidden="true" />}
      tone="brand"
      title={watch?.found ? 'Ход копии' : 'Сделать копию сейчас'}
      description="Как по расписанию: всё, что отмечено в «Что входит в копию», с паролем, если он задан."
    >
      {!watch ? (
        <label
          htmlFor="run-telegram"
          className={cn(
            'flex cursor-pointer items-start gap-3 rounded-[11px] border border-border bg-surface-2 px-3.5 py-3',
            !telegramReady && 'cursor-default opacity-60',
          )}
        >
          <Checkbox
            id="run-telegram"
            checked={send}
            disabled={!telegramReady}
            onCheckedChange={(v) => setSend(v === true)}
            className="mt-0.5"
          />
          <span>
            <b className="block text-[13px]">Отправить в Telegram</b>
            <span className="text-[12px] text-text-3">
              {telegramReady
                ? `Файлом${telegramWhere ? ` в «${telegramWhere}»` : ''}. Больше 50 МБ — придёт сообщение, что копия готова.`
                : 'Чат для копий не выбран — настройте «Отправку в Telegram» ниже на странице.'}
            </span>
          </span>
        </label>
      ) : (
        <Progress stage={stage} finished={finished} ok={Boolean(made)} />
      )}
      {made && (
        <p className="m-0 rounded-[11px] border border-ok/30 bg-ok-soft px-3.5 py-3 text-[12.5px]">
          <b>Готово:</b> {formatSize(made.size)}
          {made.verified ? ', проверена' : ''}
          {made.telegram
            ? made.telegram.ok
              ? ', отправлена в Telegram'
              : `. Telegram: ${made.telegram.note}`
            : ''}
          .
        </p>
      )}
      {failed && (
        <WarnBox tone="crit">
          <b>Копия не получилась:</b> {failed}
        </WarnBox>
      )}
      <DialogActions>
        {!watch ? (
          <>
            <DialogSecondaryButton onClick={() => onOpenChange(false)}>Отмена</DialogSecondaryButton>
            <DialogPrimaryButton disabled={run.isPending || !data?.available} onClick={() => void start()}>
              {run.isPending ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
              Сделать копию
            </DialogPrimaryButton>
          </>
        ) : (
          <DialogSecondaryButton onClick={() => onOpenChange(false)}>
            {finished ? 'Закрыть' : 'Свернуть'}
          </DialogSecondaryButton>
        )}
      </DialogActions>
    </Shell>
  );
}

function Progress({ stage, finished, ok }: { stage: BackupStage | null; finished: boolean; ok: boolean }) {
  const at = stage ? VISIBLE_STAGES.indexOf(stage) : -1;
  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      <b className="text-[13px]">
        {finished
          ? ok
            ? 'Копия готова'
            : 'Остановлено'
          : stage
            ? `${BACKUP_STAGE_LABELS[stage]}…`
            : 'Начинаю…'}
      </b>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500',
            ok || !finished ? 'bg-brand' : 'bg-crit',
          )}
          style={{ width: `${finished ? 100 : Math.max(8, ((at + 1) / VISIBLE_STAGES.length) * 100)}%` }}
        />
      </div>
      <p className="m-0 text-[11.5px] text-text-3">
        Панель при этом работает. Окно можно свернуть — ход виден в строке «Последняя копия».
      </p>
    </div>
  );
}

/* ─────────── «Восстановить» ─────────── */

/** Ждём, пока панель перезапустится, и открываем её заново (попросит войти). */
function useRestartWatch(active: boolean) {
  const [phase, setPhase] = useState<'idle' | 'down' | 'up'>('idle');
  useEffect(() => {
    if (!active) return;
    let stop = false;
    let sawDown = false;
    const tick = async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, 2000));
        // Окно успели убрать, пока ждали, — опрашивать уже некому.
        if (stop) return;
        const ok = await fetch('/api/health/live', { cache: 'no-store' })
          .then((r) => r.ok)
          .catch(() => false);
        if (!ok) {
          sawDown = true;
          setPhase('down');
        } else if (sawDown) {
          setPhase('up');
          window.location.assign('/');
          return;
        }
      }
    };
    void tick();
    // Не заметили перезапуск за 90 секунд — всё равно обновляем страницу.
    const t = setTimeout(() => window.location.assign('/'), 90_000);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [active]);
  return phase;
}

function InspectSummary({ info, tz }: { info: BackupInspect; tz: string }) {
  if (!info.contents) return null;
  const parts = [
    `база данных ${formatSize(info.contents.dbBytes)}`,
    info.contents.env ? 'ключи шифрования' : null,
    info.contents.metrics ? 'метрики' : null,
    info.contents.paths > 0 ? `дополнительные файлы (${info.contents.paths})` : null,
  ].filter(Boolean);
  return (
    <p className="m-0 text-[12.5px] text-text-2">
      В архиве: {parts.join(', ')}.
      {info.createdAt ? ` Сделан ${formatWhen(info.createdAt, tz).toLowerCase()}` : ''}
      {info.version ? `, панель ${info.version}` : ''}
      {info.compatible ? ' — можно восстановить.' : '.'}
    </p>
  );
}

/**
 * Что сказать в окне, когда восстановление не прошло. Отказ до начала (идёт копия, копии уже нет) и свою
 * ошибку восстановления сервер объясняет сам — в том числе цела ли текущая база: это его слова, как есть.
 * Обрыв связи и сбой без объяснения — честно: чем кончилось, панель не знает, и «база не тронута» здесь
 * не говорим.
 */
function restoreFailure(err: unknown): string {
  if (isApiError(err)) {
    if (err.status >= 400 && err.status < 500) return apiErrorMessage(err);
    if (err.status >= 500 && err.type !== 'about:blank' && err.detail) return err.detail;
  }
  const request =
    isApiError(err) && err.requestId
      ? ` Идентификатор запроса поможет найти причину в логах: ${err.requestId}.`
      : '';
  return `Панель не подтвердила восстановление: ответ не пришёл или пришёл с ошибкой. Что сейчас с базой — неизвестно. Подождите минуту, обновите страницу и проверьте, вернулась ли панель к состоянию на момент копии.${request}`;
}

/**
 * Проверка архива → пароль (если нужен) → предупреждения → слово «ВОССТАНОВИТЬ» → восстановление →
 * ожидание перезапуска. Общая часть для копии из списка и для файла с компьютера.
 */
function RestoreBody({
  item,
  tz,
  onCancel,
  onLockChange,
}: {
  item: BackupItem;
  tz: string;
  onCancel: () => void;
  onLockChange: (lock: boolean) => void;
}) {
  const [password, setPassword] = useState('');
  const [checkedWith, setCheckedWith] = useState<string | undefined>(undefined);
  const [confirm, setConfirm] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const restore = useRestoreBackup();
  const inspect = useQuery({
    queryKey: ['backups', 'inspect', item.name, checkedWith ?? ''],
    queryFn: () => backupsApi.inspect(item.name, checkedWith),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    // Пока проверяется новый пароль — форма остаётся на месте, без мигания.
    placeholderData: (prev) => prev,
  });
  const done = restore.isSuccess;
  const phase = useRestartWatch(done);
  const info = inspect.data;
  const ready = Boolean(info?.compatible) && !info?.needsPassword;
  const canRestore = ready && confirm.trim() === BACKUP_RESTORE_CONFIRM && !restore.isPending;

  useEffect(() => onLockChange(restore.isPending || done), [restore.isPending, done, onLockChange]);

  const submit = async () => {
    setFailure(null);
    try {
      await restore.mutateAsync({
        name: item.name,
        confirm: BACKUP_RESTORE_CONFIRM,
        ...(checkedWith ? { password: checkedWith } : {}),
      });
    } catch (err) {
      // В окне, а не всплывашкой: цела ли база — главное, что нужно знать, и оно не должно исчезнуть.
      if (!(err instanceof StepUpCancelledError)) setFailure(restoreFailure(err));
    }
  };

  if (done)
    return (
      <div className="flex flex-col items-center gap-3 py-4 text-center" aria-live="polite">
        <Loader2Icon className="size-7 animate-spin text-brand" aria-hidden="true" />
        <b className="text-[14px]">
          {phase === 'up' ? 'Панель снова работает — открываю…' : 'Панель перезапускается…'}
        </b>
        <p className="m-0 max-w-[380px] text-[12.5px] text-text-3">
          База восстановлена. Обычно это занимает около минуты, потом панель попросит войти заново — пароль и
          код те, что были на момент копии.
        </p>
      </div>
    );

  return (
    <>
      {inspect.isPending ? (
        <p className="m-0 flex items-center gap-2 text-[12.5px] text-text-3">
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
          Читаю архив: что в нём и подходит ли он этой панели…
        </p>
      ) : inspect.isError ? (
        <WarnBox tone="crit">{apiErrorMessage(inspect.error)}</WarnBox>
      ) : info ? (
        <>
          <InspectSummary info={info} tz={tz} />
          {info.needsPassword ? (
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (password) setCheckedWith(password);
              }}
            >
              <div className="min-w-0 flex-1">
                <Field
                  id="restore-password"
                  label="Пароль архива"
                  hint={
                    // Пока ответ не пришёл, на экране прежний — про другой пароль: «не подошёл» по нему не говорим.
                    inspect.isPlaceholderData ? (
                      <span className="flex items-center gap-1.5">
                        <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
                        Проверяю пароль…
                      </span>
                    ) : checkedWith ? (
                      <span className="text-crit">Пароль не подошёл.</span>
                    ) : (
                      'Копия защищена паролем — без него не открыть.'
                    )
                  }
                >
                  <Input
                    id="restore-password"
                    type="password"
                    autoComplete="off"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={inputClass}
                  />
                </Field>
              </div>
              <button
                type="submit"
                disabled={!password || inspect.isFetching}
                className="mb-[22px] inline-flex h-10 cursor-pointer items-center rounded-[10px] border border-border bg-surface-2 px-3.5 text-[13px] font-medium text-text-2 hover:text-foreground disabled:opacity-50"
              >
                Проверить
              </button>
            </form>
          ) : !info.compatible ? (
            <WarnBox tone="crit">{info.problem ?? 'Эту копию нельзя восстановить из панели.'}</WarnBox>
          ) : (
            <>
              {info.encrypted && (
                <p className="m-0 flex items-center gap-1.5 text-[12.5px] text-ok">
                  <CheckIcon className="size-4" aria-hidden="true" />
                  Пароль подошёл.
                </p>
              )}
              {/* Восстановить можно, но с оговоркой — например, в старой копии нет ключей шифрования. */}
              {info.warning && <WarnBox>{info.warning}</WarnBox>}
              <WarnBox>
                <b>
                  Всё, что изменилось после{' '}
                  {info.createdAt ? formatWhen(info.createdAt, tz).toLowerCase() : 'копии'}, пропадёт:
                </b>{' '}
                новые серверы, инциденты, оплаты, записи Журнала, беседы с Джарвисом.
              </WarnBox>
              <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[12.5px] text-text-2">
                <li>
                  Перед восстановлением панель сама сделает копию текущего состояния — передумаете, вернётесь
                  к ней.
                </li>
                <li>Панель будет недоступна около минуты и попросит войти заново.</li>
                <li>
                  Вход — по паролю и коду 2FA, которые действовали на момент копии
                  {info.createdAt ? ` (${formatWhen(info.createdAt, tz).toLowerCase()})` : ''}; коды
                  восстановления тоже вернутся прежние. Если позже вы меняли пароль или перевыпускали 2FA —
                  убедитесь, что помните прежний пароль и что в приложении-аутентификаторе осталась прежняя
                  запись. Иначе войти не получится, и доступ придётся возвращать из консоли сервера панели —
                  как это сделать, написано на странице входа под «Забыли пароль?».
                </li>
                <li>Серверы, ноды и агенты работают как работали: восстанавливается только панель.</li>
                {info.contents && info.contents.paths > 0 && (
                  <li>
                    Дополнительные файлы на место не раскладываются — они лежат в архиве, достаньте нужное
                    вручную.
                  </li>
                )}
              </ul>
              <Field id="restore-confirm" label={`Для подтверждения введите «${BACKUP_RESTORE_CONFIRM}»`}>
                <Input
                  id="restore-confirm"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={BACKUP_RESTORE_CONFIRM}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className={cn(inputClass, 'font-mono')}
                />
              </Field>
            </>
          )}
        </>
      ) : null}
      {failure && <WarnBox tone="crit">{failure}</WarnBox>}
      <DialogActions>
        <DialogSecondaryButton disabled={restore.isPending} onClick={onCancel}>
          Отмена
        </DialogSecondaryButton>
        <DialogPrimaryButton
          disabled={!canRestore}
          onClick={() => void submit()}
          className="bg-warn text-[#1a1300] hover:bg-warn hover:brightness-110"
        >
          {restore.isPending ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
          {restore.isPending ? 'Восстанавливаю…' : 'Восстановить'}
        </DialogPrimaryButton>
      </DialogActions>
    </>
  );
}

export function RestoreDialog({
  item,
  tz,
  onClose,
}: {
  item: BackupItem | null;
  tz: string;
  onClose: () => void;
}) {
  const [lock, setLock] = useState(false);
  if (!item) return null;
  return (
    <Shell
      open
      onOpenChange={(o) => !o && onClose()}
      lock={lock}
      icon={<RotateCcwIcon aria-hidden="true" />}
      tone="warn"
      title={`Восстановить из копии от ${formatWhen(item.createdAt, tz).toLowerCase()}?`}
      description="Панель вернётся к состоянию на момент копии."
    >
      <RestoreBody key={item.name} item={item} tz={tz} onCancel={onClose} onLockChange={setLock} />
    </Shell>
  );
}

/* ─────────── «Удалить» ─────────── */

export function DeleteDialog({
  item,
  items,
  tz,
  onClose,
}: {
  item: BackupItem | null;
  items: BackupItem[];
  tz: string;
  onClose: () => void;
}) {
  const del = useDeleteBackup();
  if (!item) return null;
  const verified = items.filter((i) => i.verified);
  const lastGood = item.verified && verified.length === 1;
  const newest = items[0]?.name === item.name;
  const submit = async () => {
    try {
      await del.mutateAsync(item.name);
      toast.success('Копия удалена.');
      onClose();
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) toast.error(apiErrorMessage(err));
    }
  };
  return (
    <Shell
      open
      onOpenChange={(o) => !o && onClose()}
      lock={del.isPending}
      icon={<Trash2Icon aria-hidden="true" />}
      tone="crit"
      title={`Удалить копию от ${formatWhen(item.createdAt, tz).toLowerCase()}?`}
      description="Файл удалится с сервера панели. Отменить нельзя."
    >
      {lastGood ? (
        <WarnBox tone="crit">
          <b>Это единственная проверенная копия.</b> После удаления откатиться будет не к чему — сначала
          сделайте новую или скачайте эту.
        </WarnBox>
      ) : newest ? (
        <WarnBox>
          <b>Это самая свежая копия.</b> Если нужна точка отката на сегодня — сначала скачайте её.
        </WarnBox>
      ) : null}
      <p className="m-0 text-[12px] text-text-3">
        Копия в Telegram (если отправлялась) остаётся в чате — её удаляете там сами.
      </p>
      <DialogActions>
        <DialogSecondaryButton disabled={del.isPending} onClick={onClose}>
          Отмена
        </DialogSecondaryButton>
        <DialogPrimaryButton
          disabled={del.isPending}
          onClick={() => void submit()}
          className="bg-crit text-white hover:bg-crit hover:brightness-110"
        >
          {del.isPending ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
          Да, удалить
        </DialogPrimaryButton>
      </DialogActions>
    </Shell>
  );
}

/* ─────────── «Восстановить из файла» ─────────── */

export function FileDialog({ open, tz, onClose }: { open: boolean; tz: string; onClose: () => void }) {
  const [uploaded, setUploaded] = useState<BackupItem | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [lock, setLock] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setUploaded(null);
      setProgress(null);
      setError(null);
    }
  }, [open]);

  const send = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setProgress(0);
    try {
      setUploaded(await uploadBackup(file, setProgress));
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setProgress(null);
    }
  };

  return (
    <Shell
      open={open}
      onOpenChange={(o) => !o && onClose()}
      lock={lock || progress !== null}
      icon={<UploadIcon aria-hidden="true" />}
      tone="warn"
      title="Восстановить из файла"
      description="Архив с компьютера: скачанная раньше копия этой панели."
    >
      {!uploaded ? (
        <>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              void send(e.dataTransfer.files[0]);
            }}
            disabled={progress !== null}
            className={cn(
              'flex cursor-pointer flex-col items-center gap-1 rounded-[12px] border-[1.5px] border-dashed px-4 py-7 text-center transition-colors',
              drag ? 'border-brand bg-brand-soft' : 'border-border-2 bg-surface-2 hover:border-brand',
            )}
          >
            <b className="text-[13.5px]">
              Перетащите архив сюда или <u>выберите файл</u>
            </b>
            <span className="font-mono text-[11.5px] text-text-3">
              nodeservice-backup-*.tar.gz(.enc) · до 2 ГБ
            </span>
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".gz,.enc,application/gzip,application/octet-stream"
            className="hidden"
            data-testid="backup-file-input"
            onChange={(e) => void send(e.target.files?.[0])}
          />
          {progress !== null && (
            <div className="flex flex-col gap-1.5" aria-live="polite">
              <span className="text-[12.5px] text-text-2">Загружаю… {Math.round(progress * 100)}%</span>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                <div
                  className="h-full rounded-full bg-brand"
                  style={{ width: `${Math.max(4, progress * 100)}%` }}
                />
              </div>
            </div>
          )}
          {error && <WarnBox tone="crit">{error}</WarnBox>}
          <p className="m-0 text-[11.5px] text-text-3">
            Копию с другой установки (другие ключи шифрования) панель восстановить не может — её переносят
            через консоль на новом сервере. Загруженный файл остаётся в списке копий: не пригодится — удалите.
          </p>
          <DialogActions>
            <DialogSecondaryButton disabled={progress !== null} onClick={onClose}>
              Отмена
            </DialogSecondaryButton>
          </DialogActions>
        </>
      ) : (
        <RestoreBody item={uploaded} tz={tz} onCancel={onClose} onLockChange={setLock} />
      )}
    </Shell>
  );
}
