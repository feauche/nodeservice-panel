import {
  NODE_LINK_AUTO,
  NODE_LINK_BY_LABELS,
  NODE_LINK_NONE,
  type RemnawaveStatus,
  type Server,
} from '@nodeservice/shared';

import { Combobox } from '@/components/ui/combobox';
import { nodeOfServer } from '@/features/remnawave/node-link';
import { useRemnawaveStatus } from '@/features/remnawave/remnawave-api';

const HINT = 'm-0 mt-1.5 text-[12px] leading-snug text-text-3';

/** Что сейчас происходит при выбранном значении: панель называет найденную ноду или объясняет, что её нет. */
function hintOf(value: string, server: Server, status: RemnawaveStatus | undefined): string {
  if (value === NODE_LINK_NONE)
    return 'Ноды Remnawave на этом сервере нет: онлайн на карточке не показывается, а падение онлайна к этому серверу не привязывается.';
  if (!status?.connected)
    return 'Remnawave не подключена — выбирать пока не из чего. Подключить: «Серверы → Remnawave».';
  if (value !== NODE_LINK_AUTO)
    return status.nodes.some((n) => n.uuid === value)
      ? 'Выбрана вручную. Так и оставьте, если адрес ноды в Remnawave записан иначе, чем адрес этого сервера в панели.'
      : 'Выбранной ноды больше нет в Remnawave — выберите другую или «Определять автоматически».';
  // Показываем то, что нашла панель для сохранённого значения: несохранённый выбор на связь ещё не повлиял.
  const found = server.nodeLink === NODE_LINK_AUTO ? nodeOfServer(status.nodes, server) : undefined;
  if (found)
    return `Панель находит ноду сама: по адресу сервера и по IP, на который указывает домен. Сейчас: «${found.name}» — ${NODE_LINK_BY_LABELS[found.linkedBy ?? 'address']}.`;
  return 'Панель находит ноду сама: по адресу сервера и по IP, на который указывает домен. Сейчас нода не найдена: адрес этого сервера не совпал ни с одной нодой Remnawave. Выберите её в списке — иначе при падении онлайна панель не проверит оплату и вход этого сервера.';
}

/**
 * «Какая это нода в Remnawave» (решение владельца 30.09.2026): по умолчанию панель находит ноду сама, но когда
 * адреса записаны по-разному, её можно выбрать. От этой связи зависят онлайн на карточке, проверки при падении
 * онлайна, «Ёмкость» и разбор инцидентов.
 */
export function NodeLinkField({
  server,
  value,
  onChange,
}: {
  server: Server;
  value: string;
  onChange: (v: string) => void;
}) {
  const status = useRemnawaveStatus();
  const nodes = status.data?.connected ? status.data.nodes : [];
  return (
    <div className="mt-2">
      <label htmlFor="pf-node-link" className="mb-2 block text-[13px] font-semibold">
        Какая это нода в Remnawave
      </label>
      <Combobox
        id="pf-node-link"
        ariaLabel="Какая это нода в Remnawave"
        value={value}
        onChange={(v) => onChange(v ?? NODE_LINK_AUTO)}
        options={[
          { value: NODE_LINK_AUTO, label: 'Определять автоматически', pinned: true },
          { value: NODE_LINK_NONE, label: 'Нет ноды', pinned: true },
          ...nodes.map((n) => ({
            value: n.uuid,
            label: n.name,
            keywords: n.address,
            node: (
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate">{n.name}</span>
                <span className="truncate font-mono text-[11.5px] text-text-3">{n.address}</span>
              </span>
            ),
          })),
        ]}
        placeholder={<span className="text-text-3">Выберите ноду</span>}
        // Выбранной ноды нет в списке (её удалили из Remnawave): поле не должно выглядеть пустым.
        display={
          value !== NODE_LINK_AUTO && value !== NODE_LINK_NONE && !nodes.some((n) => n.uuid === value) ? (
            <span className="text-text-3">Нода не найдена</span>
          ) : undefined
        }
        searchPlaceholder="Найти ноду…"
        className="h-10 w-full"
      />
      <p className={HINT}>{hintOf(value, server, status.data)}</p>
    </div>
  );
}
