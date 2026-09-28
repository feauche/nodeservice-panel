import type { SessionInfo, TrustedDeviceInfo } from '@nodeservice/shared';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { shortUserAgent } from '@/features/audit/audit-format';
import { Pill, RowButton, SettingsCard } from '@/features/settings/settings-ui';
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

function ListRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <li
      className={cn(
        'flex items-center justify-between gap-3 border-t border-border py-3 first:border-t-0',
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
      hint="Где вы сейчас вошли. Незнакомое устройство — завершите сессию и смените пароль."
      footer={
        <RowButton tone="danger" onClick={() => setOthersOpen(true)} disabled={others === 0}>
          Завершить все, кроме текущей
        </RowButton>
      }
    >
      <ul className="m-0 list-none p-0 py-1" aria-label="Активные сессии">
        {sessions.isPending && <li className="py-3 text-[12.5px] text-text-3">Загружаю…</li>}
        {items.map((s) => (
          <ListRow key={s.id}>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="font-medium" title={s.userAgent}>
                  {shortUserAgent(s.userAgent)}
                </span>
                {s.current && <Pill tone="ok">Текущая</Pill>}
              </div>
              <div className="mt-0.5 text-[11.5px] text-text-3">
                <span className="font-mono">{s.ip || '—'}</span> · {loginMethod(s.amr)} · активность{' '}
                {formatAgo(s.lastSeenAt)}
              </div>
            </div>
            {/* Текущую завершить нельзя — для неё кнопки нет, метка «Текущая» это объясняет. */}
            {!s.current && (
              <RowButton tone="danger" onClick={() => setTarget(s)}>
                Завершить
              </RowButton>
            )}
          </ListRow>
        ))}
      </ul>
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
      footer={
        items.length > 0 ? (
          <RowButton tone="danger" onClick={() => setClearOpen(true)}>
            Забыть все
          </RowButton>
        ) : undefined
      }
    >
      <ul className="m-0 list-none p-0 py-1" aria-label="Запомненные устройства">
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
                {d.current && <Pill tone="ok">Это устройство</Pill>}
              </div>
              <div className="mt-0.5 text-[11.5px] text-text-3">
                <span className="font-mono">{d.ipPrefix || '—'}</span> · использовано{' '}
                {formatAgo(d.lastUsedAt)} · до {formatDate(d.expiresAt)}
              </div>
            </div>
            <RowButton tone="danger" onClick={() => setTarget(d)}>
              Забыть
            </RowButton>
          </ListRow>
        ))}
      </ul>
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
