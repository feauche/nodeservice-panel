import type { Server } from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';
import {
  CheckCircle2Icon,
  CopyIcon,
  ExternalLinkIcon,
  InfoIcon,
  Loader2Icon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRefreshInventory } from '@/features/servers/servers-api';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';

/** Команда меняется редко — держим отдельной константой, чтобы её было видно и легко поправить. */
const INSTALL_COMMAND =
  'bash <(curl -sL https://raw.githubusercontent.com/feauche/remnanode-installer/main/install.sh)';

/**
 * «Установка» (J9, набросок): готовая команда установки ноды Remnawave на уже добавленный сервер.
 * Панель ничего не выполняет сама — только показывает команду для копирования. Выполняется вручную по
 * SSH от root; секретный ключ ноды скрипт спросит сам, остальные вопросы можно оставить по умолчанию.
 */
export function InstallTab({ server }: { server: Server }) {
  const refresh = useRefreshInventory();
  const components = new Map(
    server.inventory?.components?.map((component) => [component.key, component]) ?? [],
  );
  const cards = [
    { key: 'remnanode' as const, title: 'Remnanode', hint: 'VPN-нода в Docker' },
    { key: 'selfsteal' as const, title: 'Selfsteal', hint: 'сайт маскировки Reality' },
    { key: 'psiphon' as const, title: 'Psiphon', hint: 'локальный SOCKS5-выход' },
  ];

  const refreshComponents = async () => {
    try {
      await refresh.mutateAsync(server.id);
      toast.success('Компоненты проверены.');
    } catch (error) {
      toast.error(apiErrorMessage(error));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2.5 rounded-[10px] border border-l-[3px] border-border border-l-brand bg-surface px-3 py-2.5 text-[12.5px] leading-normal text-text-2">
        <InfoIcon className="mt-0.5 size-[15px] flex-none text-brand" aria-hidden="true" />
        <p className="m-0">
          <b className="font-semibold text-foreground">Что это.</b> Команда ставит саму ноду Remnawave
          (контейнер remnanode) на сервер «{server.name}» — не путать с «Установить агента» в левой панели:
          это отдельная, лёгкая программа, через которую панель следит за сервером, а нода обслуживает
          подключения пользователей.
        </p>
      </div>

      <section className="overflow-hidden rounded-2xl border border-border bg-surface-2/40">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h3 className="text-[13px] font-semibold">Что установлено на сервере</h3>
            <p className="mt-0.5 text-[11.5px] text-text-3">
              {server.inventory
                ? `Снимок по SSH: ${new Date(server.inventory.at).toLocaleString('ru-RU')}`
                : 'Состояние ещё не проверялось'}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={refresh.isPending}
            onClick={() => void refreshComponents()}
            className="h-8 gap-1.5 rounded-[9px] px-3 text-[12px]"
          >
            {refresh.isPending ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3.5" />
            )}
            Проверить
          </Button>
        </div>
        <div className="grid sm:grid-cols-3">
          {cards.map((card) => {
            const component = components.get(card.key);
            const unknown = !component;
            const problem = Boolean(component?.installed && component.running === false);
            const installed = Boolean(component?.installed);
            const Icon = unknown
              ? InfoIcon
              : problem
                ? TriangleAlertIcon
                : installed
                  ? CheckCircle2Icon
                  : XIcon;
            return (
              <div
                key={card.key}
                className="flex min-h-[112px] items-start gap-3 border-t border-border p-4 first:border-t-0 sm:border-t-0 sm:border-l sm:first:border-l-0"
              >
                <span
                  className={cn(
                    'grid size-8 flex-none place-items-center rounded-lg',
                    unknown && 'bg-surface-3 text-text-3',
                    installed && !problem && 'bg-ok-soft text-ok',
                    problem && 'bg-warn-soft text-warn',
                    !unknown && !installed && 'bg-surface-3 text-text-3',
                  )}
                >
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <div className="text-[12.5px] font-semibold">{card.title}</div>
                  <div className="mt-0.5 text-[11px] text-text-3">{card.hint}</div>
                  <div
                    className={cn(
                      'mt-2 text-[11.5px] font-medium',
                      installed && !problem ? 'text-ok' : problem ? 'text-warn' : 'text-text-3',
                    )}
                  >
                    {component?.detail ?? 'Нужна проверка'}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <span className="text-[13px] font-semibold">Команда установки</span>
        <code className="block break-all rounded-[10px] border border-border bg-surface-2 px-3 py-2.5 font-mono text-[12.5px]">
          {INSTALL_COMMAND}
        </code>
        <p className="m-0 text-[12px] leading-normal text-text-3">
          Выполните её от root по SSH на самом сервере (не в этой панели). Она один раз обязательно спросит
          секретный ключ ноды — его выдаёт Remnawave: раздел «Nodes» → «Add Node» → «Secret Key». На остальные
          вопросы (порт SSH, порт ноды, версия образа, логи) можно просто нажимать Enter — там уже стоят
          разумные значения по умолчанию.
        </p>
        <div>
          <Button
            type="button"
            variant="outline"
            className="h-8 gap-1.5 rounded-[8px] border-border bg-surface-2 px-2.5 text-[12px] text-text-2 hover:bg-surface-3 hover:text-foreground"
            onClick={() => {
              void navigator.clipboard?.writeText(INSTALL_COMMAND);
              toast.success('Команда скопирована.');
            }}
          >
            <CopyIcon className="size-3.5" aria-hidden="true" />
            Скопировать команду
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2 rounded-2xl border border-border bg-surface-2/40 p-4">
        <span className="text-[13px] font-semibold">После установки</span>
        <p className="m-0 text-[12.5px] leading-normal text-text-2">
          Команда только поднимает ноду на сервере — саму Remnawave она не трогает. Ноду всё ещё нужно
          добавить в самой Remnawave вручную: «Nodes» → «Add Node», тот же секретный ключ, адрес и порт этого
          сервера. После этого панель сама свяжет ноду с этим сервером — по адресу. Если в Remnawave адрес
          записан иначе, выберите ноду на вкладке «Профиль»: «Какая это нода в Remnawave».
        </p>
        <Link
          to="/servers/remnawave"
          className="inline-flex w-fit items-center gap-1.5 text-[12.5px] font-medium text-brand hover:underline"
        >
          Открыть «Remnawave»
          <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
        </Link>
      </section>
    </div>
  );
}
