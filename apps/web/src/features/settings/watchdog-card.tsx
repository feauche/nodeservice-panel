import type { Server } from '@nodeservice/shared';
import { Loader2Icon, RefreshCwIcon, SendIcon, ServerIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateTime } from '@/features/security/security-format';
import { StepUpCancelledError } from '@/features/security/step-up';
import { useServers } from '@/features/servers/servers-api';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { RowButton, SettingsCard, SettingsRow } from './settings-ui';
import { useInstallWatchdog, useRemoveWatchdog, useTestWatchdog, useWatchdog } from './watchdog-api';

const TOKEN_NOTE = 'Сторож знает токен бота: он может только отправлять сообщения в ваш чат.';

/** Группы в списке серверов: за рубежом — первыми (из России Telegram может быть недоступен). */
const GROUPS = ['За рубежом', 'Страна не определена', 'В России'] as const;
const groupOf = (s: Server): (typeof GROUPS)[number] =>
  s.country.code === null ? 'Страна не определена' : s.country.code === 'RU' ? 'В России' : 'За рубежом';

const serverOption = (s: Server): ComboOption => ({
  value: s.id,
  label: s.name,
  keywords: s.host,
  group: groupOf(s),
  node: (
    <span className="flex min-w-0 items-center gap-2">
      <ServerIcon className="size-3.5 flex-none text-text-3" aria-hidden="true" />
      <span className="truncate">{s.name}</span>
      <span className="truncate font-mono text-[11.5px] text-text-3">{s.host}</span>
    </span>
  ),
});

/**
 * «Сторож панели»: маленькая программа на сервере парка пишет в Telegram сама, когда панель лежит целиком
 * (упала, зависла, осталась без базы) — сама панель в такую минуту ничего прислать не может. Действия
 * применяются сразу, кнопками в строке, как «Отправить тест» у чатов.
 */
export function WatchdogCard() {
  const q = useWatchdog();
  const servers = useServers();
  const install = useInstallWatchdog();
  const remove = useRemoveWatchdog();
  const test = useTestWatchdog();
  const [serverId, setServerId] = useState<string | null>(null);
  const busy = install.isPending || remove.isPending || test.isPending;

  const fail = (err: unknown) => {
    if (!(err instanceof StepUpCancelledError)) toast.error(apiErrorMessage(err));
  };
  const put = async (id: string, again: boolean) => {
    try {
      const s = await install.mutateAsync(id);
      toast.success(
        again
          ? 'Сторож поставлен заново с нынешними чатами и адресом панели.'
          : `Сторож поставлен на сервер «${s.installed?.serverName ?? ''}». Нажмите «Проверить сторожа» — придёт тестовое сообщение.`,
      );
    } catch (err) {
      fail(err);
    }
  };
  const drop = async () => {
    const was = q.data?.installed;
    try {
      await remove.mutateAsync();
      toast.success(
        was?.serverGone ? 'Запись о стороже убрана.' : `Сторож убран с сервера «${was?.serverName ?? ''}».`,
      );
    } catch (err) {
      fail(err);
    }
  };
  const check = async () => {
    try {
      const r = await test.mutateAsync();
      if (r.ok) toast.success(r.detail);
      else toast.error(r.detail);
    } catch (err) {
      fail(err);
    }
  };

  const options = [...(servers.data?.items ?? [])]
    .sort(
      (a, b) => GROUPS.indexOf(groupOf(a)) - GROUPS.indexOf(groupOf(b)) || a.name.localeCompare(b.name, 'ru'),
    )
    .map(serverOption);
  const installed = q.data?.installed ?? null;
  const blocker = q.data?.blocker ?? null;

  return (
    <SettingsCard
      title="Сторож панели"
      hint="Когда панель упала, зависла или осталась без базы данных, сама она ничего прислать не может. Сторож — маленькая программа на одном из ваших серверов: раз в минуту он проверяет панель и, если она три минуты подряд не отвечает, пишет в чаты выше. Когда панель снова заработает, напишет ещё раз."
    >
      {q.isPending ? (
        <Skeleton className="my-3 h-[52px] rounded-[10px]" />
      ) : q.isError ? (
        <p role="alert" className="my-3 text-[12.5px] text-crit">
          {apiErrorMessage(q.error)}
        </p>
      ) : installed ? (
        <SettingsRow
          label="Сторож поставлен"
          hint={
            <>
              {installed.serverGone
                ? `Сервера «${installed.serverName}» больше нет в панели — убрать сторожа с него панель не может. Если сервер ещё работает, сторож на нём продолжит проверять панель.`
                : `На сервере «${installed.serverName}» с ${formatDateTime(installed.installedAt)}. ${TOKEN_NOTE}`}
              {installed.outdated && !installed.serverGone && (
                <span className="mt-1 block text-warn">
                  После установки поменялись чаты Telegram, прокси, адрес или часовой пояс панели — сторож
                  пишет и проверяет по-старому. Поставьте его заново.
                </span>
              )}
              {blocker && !installed.serverGone && <span className="mt-1 block text-warn">{blocker}</span>}
            </>
          }
        >
          {installed.outdated && !installed.serverGone && (
            <RowButton disabled={busy || Boolean(blocker)} onClick={() => void put(installed.serverId, true)}>
              {install.isPending ? (
                <Loader2Icon className="animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCwIcon aria-hidden="true" />
              )}
              Поставить заново
            </RowButton>
          )}
          {!installed.serverGone && (
            <RowButton disabled={busy} onClick={() => void check()}>
              {test.isPending ? (
                <Loader2Icon className="animate-spin" aria-hidden="true" />
              ) : (
                <SendIcon aria-hidden="true" />
              )}
              Проверить сторожа
            </RowButton>
          )}
          <RowButton tone="danger" disabled={busy} onClick={() => void drop()}>
            {remove.isPending ? (
              <Loader2Icon className="animate-spin" aria-hidden="true" />
            ) : (
              <Trash2Icon aria-hidden="true" />
            )}
            Убрать
          </RowButton>
        </SettingsRow>
      ) : (
        // Пояснение длинное — как у «Прокси» выше: поле во всю ширину, пояснение под ним.
        <SettingsRow
          stack
          label={
            <>
              Сервер для сторожа
              <span className="ml-1.5 rounded-full bg-surface-3 px-1.5 py-px align-[1px] text-[10.5px] font-medium text-text-3">
                необязательно
              </span>
            </>
          }
          hint={
            <>
              Лучше зарубежный: из России Telegram может быть недоступен, и сторож не сможет написать.{' '}
              {TOKEN_NOTE} Пока сторожа нет, о том, что панель не отвечает целиком, сообщить некому.
              {(blocker || (servers.isSuccess && options.length === 0)) && (
                <span className="mt-1 block text-warn">
                  {blocker ?? 'Серверов в панели пока нет — сторожа некуда поставить.'}
                </span>
              )}
            </>
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <Combobox
              id="wd-server"
              ariaLabel="Сервер для сторожа"
              value={serverId}
              onChange={setServerId}
              options={options}
              placeholder={<span className="text-text-3">Выберите сервер</span>}
              searchPlaceholder="Найти сервер…"
              disabled={busy || Boolean(blocker) || options.length === 0}
              className="h-[34px] min-w-0 flex-1 basis-[240px] sm:max-w-[380px]"
            />
            <RowButton
              className="h-[34px]"
              disabled={busy || !serverId || Boolean(blocker)}
              onClick={() => serverId && void put(serverId, false)}
            >
              {install.isPending && <Loader2Icon className="animate-spin" aria-hidden="true" />}
              Поставить сторожа
            </RowButton>
          </div>
        </SettingsRow>
      )}
    </SettingsCard>
  );
}
