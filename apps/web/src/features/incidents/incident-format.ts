import type { Incident, IncidentWeekStats } from '@nodeservice/shared';

/**
 * Одно предложение «чем кончилось» — строка под названием в реестре и в описании кейса. Всегда с заглавной,
 * без обрывков. Автопочинки больше нет, о шагах и попытках строка не рассказывает. Старое событие, которое
 * закрыл помогший шаг прежних версий, — «Проблема устранена», а не «Прошло само»: так было бы неправдой.
 */
export function outcomeSentence(inc: Pick<Incident, 'status' | 'resolvedBy' | 'timeline'>): string {
  if (inc.status !== 'resolved') return 'Наблюдаем';
  if (inc.resolvedBy === 'manual') return 'Закрыто администратором';
  if (inc.timeline.some((e) => e.result === 'helped')) return 'Проблема устранена';
  return 'Прошло само';
}

/** Заголовок дела без имени ноды (оно в строке отдельно): «Высокая нагрузка на CPU». */
export function titleOnly(inc: Pick<Incident, 'title'>): string {
  const i = inc.title.lastIndexOf(' · ');
  return i > 0 ? inc.title.slice(0, i) : inc.title;
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

/** Итог за 7 дней для полосы над реестром — готовые цифры с сервера панели. */
export type WeekStats = IncidentWeekStats;

/** Время закрытия для сортировки реестра; у открытого — момент открытия. */
export const closedAtMs = (inc: Incident): number => new Date(inc.resolvedAt ?? inc.openedAt).getTime();
