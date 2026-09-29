import {
  AUTOFIX_GRACE_SECONDS,
  actionMeta,
  INCIDENT_CHAINS,
  type Incident,
  type IncidentWeekStats,
  incidentWeekStats,
} from '@nodeservice/shared';

/** Порядковые для «помогло с … попытки». */
const ORDINAL = ['первой', 'второй', 'третьей', 'четвёртой', 'пятой'];
const attemptOrdinal = (n: number): string =>
  n >= 1 && n <= ORDINAL.length ? `с ${ORDINAL[n - 1]} попытки` : `с попытки ${n}`;

const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/** Сколько секунд автопочинка ещё выжидает по свежему инциденту; null — пауза не идёт. */
export function graceLeftS(inc: Incident, now: number): number | null {
  if (inc.status === 'resolved' || inc.attempts.length > 0 || inc.proposal) return null;
  if (INCIDENT_CHAINS[inc.kind].length === 0) return null;
  const left = Math.ceil((new Date(inc.openedAt).getTime() + AUTOFIX_GRACE_SECONDS * 1000 - now) / 1000);
  return left > 0 ? left : null;
}

/**
 * Одно предложение «что происходит / чем кончилось» — строка под названием в реестре и в шапке кейса.
 * Всегда с заглавной, без обрывков.
 */
export function outcomeSentence(inc: Incident, now: number): string {
  const running = inc.attempts.find((a) => a.status === 'running');
  if (running) return `Выполняется: ${lower(actionMeta(running.action).title)}`;
  const fixes = inc.attempts.filter((a) => a.level !== 'T0');
  const last = fixes.at(-1);
  if (inc.status === 'resolved') {
    if (last?.status === 'helped')
      return `Помогло ${attemptOrdinal(fixes.length)}: ${lower(actionMeta(last.action).title)}, ${
        last.by === 'auto' ? 'автоматически' : 'по вашей команде'
      }`;
    if (inc.resolvedBy === 'manual') return 'Закрыт администратором';
    // Не «прошло само, починка не потребовалась», если панель пыталась: проблема ушла, но не от её шагов.
    if (fixes.length > 0) return 'Проблема ушла сама, шаги починки не помогли';
    if (inc.attempts.length > 0) return 'Проблема ушла сама после осмотра';
    return 'Прошло само, починка не потребовалась';
  }
  const failed =
    last && last.status !== 'helped' ? `Не помогло: ${lower(actionMeta(last.action).title)}. ` : '';
  if (inc.proposal) {
    const title = lower(actionMeta(inc.proposal.action).title);
    return inc.proposal.level === 'T3'
      ? `${failed}Следующий шаг только вручную: ${title}`
      : `${failed}Ждёт подтверждения: ${title}`;
  }
  if (failed) return `${failed}Шаги цепочки исчерпаны`;
  const wait = graceLeftS(inc, now);
  if (wait !== null) return `Ждём ещё ${wait} с — возможно, поднимется само`;
  if (INCIDENT_CHAINS[inc.kind].length === 0) return 'Автопочинки нет, только уведомление';
  return 'Наблюдаем';
}

/** Заголовок дела без имени сервера (оно в строке отдельно): «Сервер недоступен — просрочена оплата». */
export function titleOnly(inc: Pick<Incident, 'title'>): string {
  const i = inc.title.lastIndexOf(' · ');
  return i > 0 ? inc.title.slice(0, i) : inc.title;
}

/**
 * Вторая строка в списке: готовый разбор Джарвиса важнее «Автопочинки нет» — он называет причину. Шаг,
 * который ждёт подтверждения, и ход починки остаются главными.
 */
export function listSubtitle(inc: Incident, now: number): string {
  const a = inc.analysis;
  const waitingStep = inc.status !== 'resolved' && (inc.proposal || graceLeftS(inc, now) !== null);
  if (!waitingStep && a?.status === 'done' && a.verdict) {
    const first = a.verdict.split(/(?<=[.!?])\s/)[0] ?? a.verdict;
    return `Джарвис: ${first.length > 160 ? `${first.slice(0, 159)}…` : first}`;
  }
  return outcomeSentence(inc, now);
}

/** Длительность: «38 с», «6 мин», «1 ч 12 мин»; для открытого — с многоточием. */
export function durationText(inc: Incident, now: number): string {
  const end = inc.resolvedAt ? new Date(inc.resolvedAt).getTime() : now;
  const s = Math.max(0, Math.round((end - new Date(inc.openedAt).getTime()) / 1000));
  const text =
    s < 60
      ? `${s} с`
      : s < 3600
        ? `${Math.round(s / 60)} мин`
        : `${Math.floor(s / 3600)} ч ${Math.round((s % 3600) / 60)} мин`;
  return inc.status === 'resolved' ? text : `${text}…`;
}

const MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

/** Заголовок группы по дню: «Сегодня», «Вчера, 23 сентября», «21 сентября». */
export function dayLabel(iso: string, now: number): string {
  const d = new Date(iso);
  const today = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  const dm = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  if (diffDays === 0) return 'Сегодня';
  if (diffDays === 1) return `Вчера, ${dm}`;
  return d.getFullYear() === today.getFullYear() ? dm : `${dm} ${d.getFullYear()}`;
}

/** Часы:минуты для колонки времени. */
export const hhmm = (iso: string): string =>
  new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

export type WeekStats = IncidentWeekStats;

/** Итог за 7 дней для полосы над реестром — общая функция, её же считает сервер. */
export const weekStats = (items: Incident[], now: number): WeekStats => incidentWeekStats(items, now);

/** Время закрытия для сортировки реестра; у открытого — момент открытия. */
export const closedAtMs = (inc: Incident): number => new Date(inc.resolvedAt ?? inc.openedAt).getTime();

/** «40 с», «6 мин», «9 ч 12 мин». */
export function humanSeconds(s: number): string {
  if (s < 60) return `${s} с`;
  if (s < 3600) return `${Math.round(s / 60)} мин`;
  return `${Math.floor(s / 3600)} ч ${Math.round((s % 3600) / 60)} мин`;
}
