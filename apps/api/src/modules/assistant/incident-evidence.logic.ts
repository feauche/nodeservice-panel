import {
  INCIDENT_KIND_META,
  type Incident,
  type IncidentKind,
  PANEL_TIME_ZONE_DEFAULT,
  type Server,
} from '@nodeservice/shared';

import { localDateTime, localDay } from '../../common/local-time.js';
import { lowerFirst } from '../../common/text.js';
import type { CountryReach } from '../incidents/block-check.logic.js';

/**
 * Улики для разбора сбоев связи (решение владельца 29.09.2026: «чтобы при разборе учитывалось всё —
 * онлайн, инциденты, прошлые логи, агент, SSH, пинги, тесты»). Панель собирает их сама до первого круга
 * модели: Джарвис видит всё сразу, а не решает, что проверить, и уверенность можно сверить с числом
 * независимых признаков.
 */
export const CONNECTIVITY_KINDS: ReadonlySet<IncidentKind> = new Set<IncidentKind>([
  'server_down',
  'agent_offline',
  'ssh_down',
  'node_blocked',
  'node_down',
]);

/** «29 сентября, 15:37» в поясе панели. */
const hm = (ms: number, timeZone: string) => localDateTime(new Date(ms), timeZone);

/** «12 мин назад», «3 ч назад», «2 дн назад». */
export function ago(iso: string | null, nowMs = Date.now()): string {
  if (!iso) return 'ни разу';
  const min = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000));
  if (min < 60) return `${min} мин назад`;
  if (min < 48 * 60) return `${Math.round(min / 60)} ч назад`;
  return `${Math.round(min / 1440)} дн назад`;
}

export interface OnlineSummary {
  before: number | null;
  minAfter: number | null;
  now: number | null;
  /** Падение от «до» к минимуму, %; null — не посчитать. */
  dropPct: number | null;
}

/**
 * Онлайн ноды вокруг открытия дела: среднее за час до, минимум после, последнее значение. Точки —
 * [секунды, значение] из VictoriaMetrics.
 */
export function summarizeOnline(points: ReadonlyArray<[number, number]>, openedAtMs: number): OnlineSummary {
  const openedSec = openedAtMs / 1000;
  const before = points.filter(([t]) => t < openedSec && t >= openedSec - 3600).map(([, v]) => v);
  const after = points.filter(([t]) => t >= openedSec).map(([, v]) => v);
  const avg = before.length ? Math.round(before.reduce((a, b) => a + b, 0) / before.length) : null;
  const minAfter = after.length ? Math.min(...after) : null;
  const now = points.at(-1)?.[1] ?? null;
  const dropPct =
    avg !== null && avg > 0 && minAfter !== null ? Math.round(((avg - minAfter) / avg) * 100) : null;
  return { before: avg, minAfter, now, dropPct };
}

export function onlineText(nodeName: string, s: OnlineSummary): string {
  if (s.before === null && s.now === null)
    return `Онлайн ноды «${nodeName}»: истории нет (метрики не пишутся).`;
  const parts = [
    `до дела в среднем ${s.before ?? 'нет данных'}`,
    `минимум после открытия ${s.minAfter ?? 'нет данных'}`,
    `сейчас ${s.now ?? 'нет данных'}`,
  ];
  const drop =
    s.dropPct === null
      ? ''
      : s.dropPct >= 50
        ? ` Падение на ${s.dropPct}% — так выглядит массовая потеря подключений.`
        : s.dropPct >= 15
          ? ` Падение на ${s.dropPct}% — отвалилась часть пользователей.`
          : ' Заметного падения онлайна нет — пользователи, скорее всего, не пострадали.';
  const back =
    s.before !== null && s.now !== null && s.before > 0 && s.now >= s.before * 0.8 && (s.dropPct ?? 0) >= 15
      ? ' Сейчас онлайн вернулся близко к прежнему.'
      : '';
  return `Онлайн ноды «${nodeName}» за 6 часов: ${parts.join(', ')}.${drop}${back}`;
}

/** Агент и SSH по данным панели: когда последний раз отвечали. */
export function connectionText(
  s: Pick<
    Server,
    | 'agentStatus'
    | 'agentVersion'
    | 'agentLastSeenAt'
    | 'agentTransport'
    | 'agentRoute'
    | 'agentRouteFallback'
    | 'sshOk'
    | 'lastSshOkAt'
    | 'lastSshCheckAt'
  >,
  nowMs = Date.now(),
): string {
  const agent =
    s.agentStatus === 'online'
      ? 'агент на связи'
      : s.agentStatus === 'offline'
        ? `агент молчит, последний раз был ${ago(s.agentLastSeenAt, nowMs)}`
        : 'агент не установлен или ставится';
  const ssh =
    s.sshOk === true
      ? 'SSH с панели работает'
      : s.sshOk === false
        ? `SSH с панели не работает, последний успешный вход ${ago(s.lastSshOkAt, nowMs)}`
        : 'SSH ещё не проверяли';
  const version = s.agentVersion ? `, версия ${s.agentVersion}` : '';
  const route = s.agentRoute ? ` (${s.agentRoute})` : '';
  const channel =
    s.agentTransport === 'https' && s.agentRouteFallback === false
      ? ` Канал агента: основной входящий HTTPS${route}; панель подключается к агенту, поэтому исходящий доступ сервера к домену панели для этой связи не нужен.`
      : s.agentTransport
        ? ` Канал агента: запасной исходящий ${s.agentTransport === 'websocket' ? 'WebSocket' : 'HTTPS'}${route}; сервер сам подключается к панели, поэтому его исходящий доступ к этому адресу важен.`
        : '';
  return `Связь с панелью: ${agent}${version}; ${ssh}.${channel}`;
}

/** Порт SSH из каждой страны и что это значит. */
/** Строка проверки: откуда, открыт ли порт, время ответа и пинг, если есть. */
export interface ReachLine extends CountryReach {
  ms?: number | null;
  ping?: number | null;
}

const reachLine = (r: ReachLine): string => {
  const extra = [r.ms != null ? `${r.ms} мс` : null, r.ping != null ? `пинг ${r.ping} мс` : null].filter(
    Boolean,
  );
  return `• ${r.from} — ${r.open ? 'порт открыт' : 'порт не отвечает'}${extra.length ? ` (${extra.join(', ')})` : ''}`;
};

export function reachText(
  port: number,
  reach: readonly ReachLine[],
  panelOpen: boolean | null,
  /** Агент на связи и SSH с панели работает: «искать внутри» тогда нечего — связь с сервером в порядке. */
  linkOk = false,
  opts: {
    /** Агент на связи (SSH при этом может не работать): сервер включён, что бы ни показал порт. */
    agentOnline?: boolean;
    /** Сколько проверяющих было выбрано; в `reach` — только те, на кого панель зашла. */
    chosen?: number;
  } = {},
): string {
  if (reach.length === 0) {
    const panel = panelOpen === null ? '' : ` С сервера панели порт ${panelOpen ? 'открыт' : 'не отвечает'}.`;
    // Проверяющие были, но панель не зашла ни на один: «нет серверов парка» — неправда, а вот связь самой
    // панели под вопросом (то же говорит текст дела).
    return (opts.chosen ?? 0) > 0
      ? `Порт SSH ${port} из других стран проверить не удалось: панель не зашла ни на один из проверяющих серверов парка (выбрано: ${opts.chosen}) — возможно, связь пропала у самой панели.${panel}`
      : `Порт SSH ${port} из других стран проверить не с чего: нет серверов парка с известной страной и рабочим SSH.${panel}`;
  }
  const lines = reach.map(reachLine);
  if (panelOpen !== null) lines.push(`• Сервер панели — ${panelOpen ? 'порт открыт' : 'порт не отвечает'}`);
  const open = reach.filter((r) => r.open);
  const closed = reach.filter((r) => !r.open);
  const ru = reach.filter((r) => r.country === 'RU');
  const ruOpen = ru.filter((r) => r.open);
  const ruClosed = ru.filter((r) => !r.open);
  const abroadClosed = closed.some((r) => r.country !== 'RU');
  let meaning: string;
  if (closed.length === 0 && panelOpen !== false)
    meaning = `Открыт отовсюду: сервер включён, с этих точек сеть до него в порядке${
      linkOk ? '' : ' — искать внутри (агент, служба, SSH-вход)'
    }.`;
  else if (open.length === 0) {
    // С серверов парка закрыт, а сам сервер заведомо работает — «выключен» сказать нельзя.
    if (panelOpen === true || linkOk || opts.agentOnline)
      meaning =
        'С серверов парка порт не отвечает, но сервер работает (порт открыт с сервера панели или агент на связи): SSH пускает не все адреса (файрвол), не запущена служба SSH либо путь закрыт из сетей проверяющих.';
    else if (panelOpen === null && new Set(reach.map((r) => r.country)).size === 1)
      meaning =
        'Не отвечает ни с одного проверяющего, но все они из одной страны: выключен сервер или закрыт путь из этой страны, по такой проверке не отличить.';
    else meaning = 'Не отвечает ни из одной страны: сервер выключен, завис или отрезан у хостера.';
  } else if (!abroadClosed && ruClosed.length > 0 && ruOpen.length === 0 && panelOpen !== false)
    meaning = 'Закрыт только из России, из-за рубежа открыт: признак блокировки IP в России (ТСПУ).';
  else if (!abroadClosed && ruClosed.length > 0 && ruOpen.length > 0 && panelOpen !== false)
    // Российские проверяющие расходятся: «закрыт из России» сказать нельзя — из части России он открыт.
    meaning = `Из России — частично: открыт с ${ruOpen.map((r) => r.from).join(', ')}, закрыт с ${ruClosed
      .map((r) => r.from)
      .join(
        ', ',
      )}; из-за рубежа открыт. Это не блокировка IP по всей России — похоже на блокировку у части провайдеров или сбой маршрута.`;
  else if (closed.length === 0)
    // Все проверяющие видят порт, не видит только панель: «закрыт из части стран» — неправда.
    meaning = `Открыт со всех проверяющих (${open.map((r) => r.from).join(', ')}), не отвечает только с сервера панели: сервер жив, закрыт путь между панелью и сервером — поэтому с панели не проходит SSH, а агент может не дозваниваться.`;
  else
    meaning = `Открыт из ${open.map((r) => r.from).join(', ')}, закрыт из ${closed.map((r) => r.from).join(', ')}${
      panelOpen === false ? ' и с сервера панели' : ''
    }: сервер жив, отрезан путь из части сетей — блокировка в этих странах или сбой маршрута.`;
  return `Порт SSH ${port} из разных стран (проверка сейчас):\n${lines.join('\n')}\nЧто это значит: ${meaning}`;
}

/** Одновременные сбои у других серверов: если их много — причина скорее у нас или в общей сети. */
export function fleetText(
  inc: Pick<Incident, 'id' | 'serverId' | 'openedAt'>,
  open: readonly Incident[],
): string {
  const at = Date.parse(inc.openedAt);
  const near = open.filter(
    (i) =>
      i.id !== inc.id &&
      i.serverId !== inc.serverId &&
      CONNECTIVITY_KINDS.has(i.kind) &&
      Math.abs(Date.parse(i.openedAt) - at) <= 30 * 60_000,
  );
  if (near.length === 0)
    return 'Другие серверы в это время: похожих сбоев нет — сбой касается только этого сервера или пути к нему.';
  const names = [
    ...new Set(near.map((i) => `${i.serverName} (${lowerFirst(INCIDENT_KIND_META[i.kind].label)})`)),
  ];
  return `Другие серверы в это время (±30 мин): ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` и ещё ${names.length - 6}` : ''}. Сбой у нескольких серверов сразу — вероятна общая причина (сеть у нас, у хостера или блокировка).`;
}

/** Прошлые дела этого сервера за 30 дней: повторяется ли, как заканчивалось. */
export function historyText(
  inc: Pick<Incident, 'id'>,
  past: readonly Incident[],
  timeZone: string = PANEL_TIME_ZONE_DEFAULT,
): string {
  const mine = past.filter((i) => i.id !== inc.id);
  if (mine.length === 0) return 'Прошлые дела этого сервера за 30 дней: не было.';
  const byKind = new Map<string, number>();
  for (const i of mine)
    byKind.set(INCIDENT_KIND_META[i.kind].label, (byKind.get(INCIDENT_KIND_META[i.kind].label) ?? 0) + 1);
  const kinds = [...byKind].map(([k, n]) => `${lowerFirst(k)} — ${n}`).join(', ');
  const last = mine.slice(0, 4).map((i) => {
    const how =
      i.status === 'open'
        ? 'ещё открыто'
        : `закрыто ${i.resolvedBy === 'manual' ? 'вручную' : 'само'}${
            i.resolvedAt ? ` через ${ago(i.openedAt, Date.parse(i.resolvedAt)).replace(' назад', '')}` : ''
          }`;
    return `• ${hm(Date.parse(i.openedAt), timeZone)} — ${i.title}; ${how}${i.analysis?.verdict ? `; вывод тогда: ${i.analysis.verdict}` : ''}`;
  });
  return `Прошлые дела этого сервера за 30 дней: ${kinds}.\n${last.join('\n')}`;
}

/** Изменения в панели по серверу за сутки (Журнал): не сломал ли что-то сам администратор или шаг. */
export function changesText(
  items: ReadonlyArray<{ at: string; action: string; result: string }>,
  timeZone: string = PANEL_TIME_ZONE_DEFAULT,
): string {
  if (items.length === 0) return 'Изменения по серверу в Журнале за сутки: не было.';
  return `Изменения по серверу в Журнале за сутки:\n${items
    .slice(0, 8)
    .map(
      (e) =>
        `• ${hm(Date.parse(e.at), timeZone)} — ${e.action}${e.result === 'success' ? '' : ` (${e.result})`}`,
    )
    .join('\n')}`;
}

/** Статьи базы знаний по теме дела: короткая выдержка, дата и происхождение. */
export function kbText(
  docs: ReadonlyArray<{ title: string; content: string; updatedAt: Date; source: string }>,
  timeZone: string = PANEL_TIME_ZONE_DEFAULT,
): string {
  if (docs.length === 0) return 'База знаний: статей по этой теме нет.';
  return `База знаний, статьи по теме (ссылайтесь на дату; написанное Джарвисом — «не проверено человеком»):\n${docs
    .slice(0, 3)
    .map(
      (d) =>
        `• «${d.title}» (${localDay(d.updatedAt, timeZone)}, ${d.source}): ${d.content.replace(/\s+/g, ' ').slice(0, 400)}`,
    )
    .join('\n')}`;
}

/** Что проверено, а что нет: модель видит пробелы и не завышает уверенность. */
export function coverageText(checked: Record<string, boolean>): string {
  const yes = Object.entries(checked)
    .filter(([, v]) => v)
    .map(([k]) => k);
  const no = Object.entries(checked)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  return `Проверено панелью до разбора: ${yes.join(', ') || 'ничего'}.${no.length ? ` Не удалось или не к чему: ${no.join(', ')}.` : ''}`;
}

/** Запрос в базу знаний по делу: вид сбоя и ключевые слова из заголовка. */
export function kbQuery(inc: Pick<Incident, 'kind' | 'title'>): string {
  const base: Partial<Record<IncidentKind, string>> = {
    server_down: 'сервер недоступен',
    agent_offline: 'агент не в сети',
    ssh_down: 'ssh недоступен',
    node_blocked: 'блокировка ТСПУ',
    node_down: 'нода контейнер',
  };
  return base[inc.kind] ?? INCIDENT_KIND_META[inc.kind].label;
}
