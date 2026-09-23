import type { SessionInfo, TrustedDeviceInfo } from '@nodeservice/shared';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { shortUserAgent } from '@/features/audit/audit-format';
import { GhostButton } from '@/features/auth/components/cta-button';
import { Pill, SettingsCard } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import {
  useClearTrustedDevices,
  useRemoveTrustedDevice,
  useRevokeOthers,
  useRevokeSession,
  useSessions,
  useTrustedDevices,
} from './security-api';
import { formatAgo, formatDate, loginMethod, plural } from './security-format';

function RowButton({
  children,
  onClick,
  disabled,
}: {
  children: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="cursor-pointer rounded-[8px] px-2 py-1 text-[12px] font-medium text-text-3 transition-colors hover:bg-crit-soft hover:text-crit disabled:cursor-default disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function ListRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <li
      className={cn(
        'flex items-center justify-between gap-3 border-t border-border py-2.5 first:border-t-0',
        className,
      )}
    >
      {children}
    </li>
  );
}

/** Активные сессии: устройство, IP, активность, способ входа; завершение любой, кроме текущей. */
export function SessionsCard() {
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const revokeOthers = useRevokeOthers();
  const [target, setTarget] = useState<SessionInfo | null>(null);
  const [othersOpen, setOthersOpen] = useState(false);
  const items = sessions.data?.items ?? [];
  const others = items.filter((s) => !s.current).length;

  const doRevoke = async () => {
    if (!target) return;
    try {
      await revoke.mutateAsync(target.id);
      toast.success('Сессия завершена.');
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } finally {
      setTarget(null);
    }
  };
  const doRevokeOthers = async () => {
    try {
      const res = await revokeOthers.mutateAsync();
      toast.success(
        `${plural(res.revoked, ['Завершена', 'Завершены', 'Завершено'])} ${res.revoked} ${plural(res.revoked, ['сессия', 'сессии', 'сессий'])}.`,
      );
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } finally {
      setOthersOpen(false);
    }
  };

  return (
    <SettingsCard
      title="Активные сессии"
      hint="Где ты сейчас вошёл. Незнакомое устройство — заверши и смени пароль."
    >
      <ul className="mt-2" aria-label="Активные сессии">
        {sessions.isPending && <li className="py-3 text-[12.5px] text-text-3">Загружаю…</li>}
        {items.map((s) => (
          <ListRow key={s.id}>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="font-medium" title={s.userAgent}>
                  {shortUserAgent(s.userAgent)}
                </span>
                {s.current && <Pill tone="ok">текущая</Pill>}
              </div>
              <div className="mt-0.5 text-[11.5px] text-text-3">
                <span className="font-mono">{s.ip || '—'}</span> · {loginMethod(s.amr)} · активность{' '}
                {formatAgo(s.lastSeenAt)}
              </div>
            </div>
            <RowButton onClick={() => setTarget(s)} disabled={s.current}>
              Завершить
            </RowButton>
          </ListRow>
        ))}
      </ul>
      <div className="mt-2">
        <GhostButton onClick={() => setOthersOpen(true)} disabled={others === 0}>
          Завершить все, кроме текущей
        </GhostButton>
      </div>
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        title="Завершить сессию?"
        description={
          target ? `${shortUserAgent(target.userAgent)} · ${target.ip}. Там придётся войти заново.` : ''
        }
        yesLabel="Да, завершить"
        loading={revoke.isPending}
        onConfirm={doRevoke}
      />
      <ConfirmDialog
        open={othersOpen}
        onOpenChange={setOthersOpen}
        kind="warn"
        title="Завершить все остальные сессии?"
        description={`${others} ${plural(others, ['сессия', 'сессии', 'сессий'])} на других устройствах будут завершены. Эта — останется.`}
        yesLabel="Да, завершить"
        loading={revokeOthers.isPending}
        onConfirm={doRevokeOthers}
      />
    </SettingsCard>
  );
}

/** Запомненные устройства («не спрашивать код 30 дней»). */
export function DevicesCard() {
  const devices = useTrustedDevices();
  const remove = useRemoveTrustedDevice();
  const clear = useClearTrustedDevices();
  const [target, setTarget] = useState<TrustedDeviceInfo | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const items = devices.data?.items ?? [];

  const doRemove = async () => {
    if (!target) return;
    try {
      await remove.mutateAsync(target.id);
      toast.success('Устройство забыто — в следующий раз спросим код.');
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } finally {
      setTarget(null);
    }
  };
  const doClear = async () => {
    try {
      const res = await clear.mutateAsync();
      toast.success(`Забыто устройств: ${res.revoked}.`);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } finally {
      setClearOpen(false);
    }
  };

  return (
    <SettingsCard
      title="Запомненные устройства"
      hint="Где отмечено «не спрашивать код 30 дней». Продления нет: через 30 дней код спросим снова."
    >
      <ul className="mt-2" aria-label="Запомненные устройства">
        {devices.isPending && <li className="py-3 text-[12.5px] text-text-3">Загружаю…</li>}
        {devices.data && items.length === 0 && (
          <li className="py-3 text-[12.5px] text-text-3">
            Пока нет. Галочка на шаге ввода кода 2FA добавит устройство сюда.
          </li>
        )}
        {items.map((d) => (
          <ListRow key={d.id}>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="font-medium" title={d.userAgent}>
                  {shortUserAgent(d.userAgent)}
                </span>
                {d.current && <Pill tone="ok">это устройство</Pill>}
              </div>
              <div className="mt-0.5 text-[11.5px] text-text-3">
                <span className="font-mono">{d.ipPrefix || '—'}</span> · использовано{' '}
                {formatAgo(d.lastUsedAt)} · до {formatDate(d.expiresAt)}
              </div>
            </div>
            <RowButton onClick={() => setTarget(d)}>Забыть</RowButton>
          </ListRow>
        ))}
      </ul>
      {items.length > 0 && (
        <div className="mt-2">
          <GhostButton onClick={() => setClearOpen(true)}>Забыть все</GhostButton>
        </div>
      )}
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        title="Забыть устройство?"
        description={
          target
            ? `${shortUserAgent(target.userAgent)} · ${target.ipPrefix}. При следующем входе там спросим код 2FA.`
            : ''
        }
        yesLabel="Да, забыть"
        loading={remove.isPending}
        onConfirm={doRemove}
      />
      <ConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        kind="warn"
        title="Забыть все устройства?"
        description="Код 2FA спросим на каждом устройстве при следующем входе, включая это."
        yesLabel="Да, забыть все"
        loading={clear.isPending}
        onConfirm={doClear}
      />
    </SettingsCard>
  );
}
