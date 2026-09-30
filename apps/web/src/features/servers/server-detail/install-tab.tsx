import type { Server } from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';
import { CopyIcon, ExternalLinkIcon, InfoIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/notify';

/** Команда меняется редко — держим отдельной константой, чтобы её было видно и легко поправить. */
const INSTALL_COMMAND =
  'bash <(curl -sL https://raw.githubusercontent.com/feauche/remnanode-installer/main/install.sh)';

/**
 * «Установка» (J9, набросок): готовая команда установки ноды Remnawave на уже добавленный сервер.
 * Панель ничего не выполняет сама — только показывает команду для копирования. Выполняется вручную по
 * SSH от root; секретный ключ ноды скрипт спросит сам, остальные вопросы можно оставить по умолчанию.
 */
export function InstallTab({ server }: { server: Server }) {
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
