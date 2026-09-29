import { INCIDENT_KIND_META, type Incident, type IncidentKind, type Server } from '@nodeservice/shared';

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

const hm = (ms: number) =>
  new Date(ms).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Moscow',
  });

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
        ? ` Падение на ${s.dropPct}% — люди массово не могут подключиться.`
        : s.dropPct >= 15
          ? ` Падение на ${s.dropPct}% — часть людей отвалилась.`
          : ' Заметного падения онлайна нет — пользователи, скорее всего, не пострадали.';
  const back =
    s.before !== null && s.now !== null && s.before > 0 && s.now >= s.before * 0.8 && (s.dropPct ?? 0) >= 15
      ? ' Сейчас онлайн вернулся близко к прежнему.'
      : '';
  return `Онлайн ноды «${nodeName}» за 6 часов: ${parts.join(', ')}.${drop}${back}`;
}

/** Агент и SSH по данным панели: когда последний раз отвечали. */
export function connectionText(
  s: Pick<Server, 'agentStatus' | 'agentLastSeenAt' | 'sshOk' | 'lastSshOkAt' | 'lastSshCheckAt'>,
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
  return `Связь с панелью: ${agent}; ${ssh}.`;
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

export function reachText(port: number, reach: readonly ReachLine[], panelOpen: boolean | null): string {
  if (reach.length === 0)
    return `Порт SSH ${port} из других стран проверить не с чего: нет серверов парка с известной страной и рабочим SSH.${
      panelOpen === null ? '' : ` С сервера панели порт ${panelOpen ? 'открыт' : 'не отвечает'}.`
    }`;
  const lines = reach.map(reachLine);
  if (panelOpen !== null) lines.push(`• Сервер панели — ${panelOpen ? 'порт открыт' : 'порт не отвечает'}`);
  const open = reach.filter((r) => r.open);
  const closed = reach.filter((r) => !r.open);
  const ruClosed = closed.some((r) => r.country === 'RU');
  let meaning: string;
  if (closed.length === 0 && panelOpen !== false)
    meaning =
      'Открыт отовсюду: сервер включён и сеть до него в порядке — искать внутри (агент, служба, SSH-вход).';
  else if (open.length === 0)
    meaning = 'Не отвечает ни из одной страны: сервер выключен, завис или отрезан у хостера.';
  else if (ruClosed && closed.every((r) => r.country === 'RU') && panelOpen !== false)
    meaning = 'Закрыт только из России, из-за рубежа открыт: признак блокировки IP в России (ТСПУ).';
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
    return 'Другие серверы в это время: похожих сбоев нет — проблема именно у этого сервера.';
  const names = [
    ...new Set(near.map((i) => `${i.serverName} (${INCIDENT_KIND_META[i.kind].label.toLowerCase()})`)),
  ];
  return `Другие серверы в это время (±30 мин): ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` и ещё ${names.length - 6}` : ''}. Сбой у нескольких серверов сразу — вероятна общая причина (сеть у нас, у хостера или блокировка).`;
}

/** Прошлые дела этого сервера за 30 дней: повторяется ли, как заканчивалось. */
export function historyText(inc: Pick<Incident, 'id'>, past: readonly Incident[]): string {
  const mine = past.filter((i) => i.id !== inc.id);
  if (mine.length === 0) return 'Прошлые дела этого сервера за 30 дней: не было.';
  const byKind = new Map<string, number>();
  for (const i of mine)
    byKind.set(INCIDENT_KIND_META[i.kind].label, (byKind.get(INCIDENT_KIND_META[i.kind].label) ?? 0) + 1);
  const kinds = [...byKind].map(([k, n]) => `${k.toLowerCase()} — ${n}`).join(', ');
  const last = mine.slice(0, 4).map((i) => {
    const how =
      i.status === 'open'
        ? 'ещё открыто'
        : `закрыто ${i.resolvedBy === 'manual' ? 'вручную' : 'само'}${
            i.resolvedAt ? ` через ${ago(i.openedAt, Date.parse(i.resolvedAt)).replace(' назад', '')}` : ''
          }`;
    return `• ${hm(Date.parse(i.openedAt))} — ${i.title}; ${how}${i.analysis?.verdict ? `; вывод тогда: ${i.analysis.verdict}` : ''}`;
  });
  return `Прошлые дела этого сервера за 30 дней: ${kinds}.\n${last.join('\n')}`;
}

/** Изменения в панели по серверу за сутки (Журнал): не сломал ли что-то сам администратор или шаг. */
export function changesText(items: ReadonlyArray<{ at: string; action: string; result: string }>): string {
  if (items.length === 0) return 'Изменения по серверу в Журнале за сутки: не было.';
  return `Изменения по серверу в Журнале за сутки:\n${items
    .slice(0, 8)
    .map((e) => `• ${hm(Date.parse(e.at))} — ${e.action}${e.result === 'success' ? '' : ` (${e.result})`}`)
    .join('\n')}`;
}

/** Статьи базы знаний по теме дела: короткая выдержка, дата и происхождение. */
export function kbText(
  docs: ReadonlyArray<{ title: string; content: string; updatedAt: Date; source: string }>,
): string {
  if (docs.length === 0) return 'База знаний: статей по этой теме нет.';
  return `База знаний, статьи по теме (ссылайтесь на дату; написанное Джарвисом — «не проверено человеком»):\n${docs
    .slice(0, 3)
    .map(
      (d) =>
        `• «${d.title}» (${d.updatedAt.toISOString().slice(0, 10)}, ${d.source}): ${d.content.replace(/\s+/g, ' ').slice(0, 400)}`,
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
