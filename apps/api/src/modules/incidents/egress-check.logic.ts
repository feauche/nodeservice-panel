import type { EgressGroup, EgressReportDto, EgressVerdict, Server } from '@nodeservice/shared';

import { SH } from './actions.registry.js';
import { isSafeBlockCheckTarget } from './block-check.logic.js';

/**
 * Проверка «куда сервер может выйти» (случай «Казахстан-1», 29.09.2026: сервер жив, файрвол чистый, а сеть
 * хостера не пропускает трафик в Россию и к панели — владелец разбирал это вручную за восемь шагов).
 * Команда выполняется НА проверяемом сервере: TCP-подключение к панели, к российским и зарубежным адресам
 * и пинг панели. По итогу видно, чья сторона: сеть сервера, фильтрация части сетей или всё в порядке.
 */

export interface EgressTarget {
  label: string;
  host: string;
  port: number;
  group: EgressGroup;
}

export interface EgressResult {
  target: EgressTarget;
  open: boolean;
  ms: number | null;
}

export interface EgressReport {
  /** Через какой сервер парка заходили (панель напрямую не пускают) или null — напрямую. */
  via: string | null;
  results: EgressResult[];
  /** Пинг до панели прошёл: «дорога есть, а подключения не проходят» — признак фильтрации. */
  panelPing: boolean | null;
}

/** Российские адреса: крупные сайты, которые не бывают недоступны сами по себе. */
const RU_SITES: EgressTarget[] = [
  { label: 'ya.ru', host: 'ya.ru', port: 443, group: 'ru' },
  { label: 'vk.com', host: 'vk.com', port: 443, group: 'ru' },
];
const FOREIGN_SITES: EgressTarget[] = [
  { label: 'google.com', host: 'google.com', port: 443, group: 'foreign' },
  { label: 'github.com', host: 'github.com', port: 443, group: 'foreign' },
  { label: '1.1.1.1', host: '1.1.1.1', port: 443, group: 'foreign' },
];

/** Панель, российские серверы парка (по порту SSH) и сайты; всё проверено на безопасную форму. */
export function egressTargets(
  panelHosts: string | readonly string[],
  self: Pick<Server, 'id'>,
  all: Array<Pick<Server, 'id' | 'name' | 'host' | 'port' | 'country'>>,
): EgressTarget[] {
  const fleetRu = all
    .filter((s) => s.id !== self.id && s.country.code === 'RU')
    .slice(0, 2)
    .map((s): EgressTarget => ({ label: s.name, host: s.host, port: s.port, group: 'ru' }));
  const hosts = [...new Set(typeof panelHosts === 'string' ? [panelHosts] : panelHosts)];
  const panel = hosts.map(
    (host, index): EgressTarget => ({
      label: index === 0 ? 'Основной вход агента' : `Запасной вход агента ${index}`,
      host,
      port: 443,
      group: 'panel',
    }),
  );
  return [...panel, ...fleetRu, ...RU_SITES, ...FOREIGN_SITES].filter((t) =>
    isSafeBlockCheckTarget(t.host, t.port, null),
  );
}

/**
 * Одна строка на цель: «номер open мс» или «номер closed». Адреса подставляет внешняя оболочка (во вложенном
 * bash переменных нет — та же ошибка, что была в проверке блокировки), форма адресов проверена заранее.
 */
export function buildEgressCommand(targets: EgressTarget[], panelHost: string): string {
  const lines = ['# ns-egress'];
  targets.forEach((t, i) => {
    lines.push(
      `(s=$(date +%s%N); if timeout 5 bash -c "exec 3<>/dev/tcp/${t.host}/${t.port}" 2>/dev/null; then e=$(date +%s%N); echo "${i} open $(( (e-s)/1000000 ))"; else echo "${i} closed"; fi) &`,
    );
  });
  const ping = isSafeBlockCheckTarget(panelHost, 443, null) ? panelHost : '';
  if (ping)
    lines.push(
      `(if ping -c 2 -W 2 ${ping} >/dev/null 2>&1; then echo "ping ok"; else echo "ping fail"; fi) &`,
    );
  // В недоступной сети каждая цель ждёт свои 5 секунд. Последовательно двенадцать целей занимали минуту
  // и попадали под общий SSH-таймаут; параллельно весь снимок ограничен одной самой медленной целью.
  lines.push('wait');
  return SH(lines.join('\n'));
}

export function parseEgress(
  stdout: string,
  targets: EgressTarget[],
): { results: EgressResult[]; panelPing: boolean | null } {
  // Параллельные проверки заканчиваются в произвольном порядке; итог возвращаем в порядке целей, чтобы
  // таблица не прыгала от запуска к запуску.
  const seen = new Map<number, EgressResult>();
  let panelPing: boolean | null = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line === 'ping ok') panelPing = true;
    else if (line === 'ping fail') panelPing = false;
    const m = line.match(/^(\d+) (open|closed)(?: (\d+))?$/);
    const index = m ? Number(m[1]) : -1;
    const target = targets[index];
    if (m && target) seen.set(index, { target, open: m[2] === 'open', ms: m[3] ? Number(m[3]) : null });
  }
  const results = targets.flatMap((_, index) => (seen.has(index) ? [seen.get(index) as EgressResult] : []));
  return { results, panelPing };
}

export function egressVerdict(r: Pick<EgressReport, 'results'>): EgressVerdict {
  const g = (group: EgressGroup) => r.results.filter((x) => x.target.group === group);
  const anyOpen = (xs: EgressResult[]) => xs.some((x) => x.open);
  const allClosed = (xs: EgressResult[]) => xs.length > 0 && xs.every((x) => !x.open);
  const panel = g('panel');
  const ru = g('ru');
  const foreign = g('foreign');
  if (r.results.length === 0) return 'unknown';
  if (r.results.every((x) => !x.open)) return 'no_internet';
  if (r.results.every((x) => x.open)) return 'ok';
  if (anyOpen(foreign) && allClosed(panel) && allClosed(ru)) return 'ru_and_panel_cut';
  if (anyOpen(foreign) && allClosed(ru)) return 'ru_cut';
  if (allClosed(panel)) return 'panel_cut';
  return 'partial';
}

const MEANING: Record<EgressVerdict, string> = {
  ok: 'Выход наружу в порядке: сервер доходит и до панели, и до России, и до зарубежных сайтов — сеть сервера не виновата.',
  no_internet:
    'Сервер никуда не может подключиться: у него нет выхода в интернет. Вопрос к хостеру (сеть сервера) или к файрволу на самом сервере.',
  ru_and_panel_cut:
    'Сеть сервера не пропускает трафик в Россию и к панели, а зарубежные сайты открываются. Так выглядит фильтрация у хостера или его вышестоящего провайдера: людям из России нода недоступна, агент не может выйти на связь. Переустановка агента не поможет — нужно писать хостеру или менять IP.',
  ru_cut:
    'Сеть сервера не пропускает трафик в Россию, а зарубежные сайты и панель открываются. Людям из России нода недоступна — фильтрация у хостера или на пути. Нужно писать хостеру или менять IP.',
  panel_cut:
    'Сервер доходит до интернета, но не до панели. Поэтому агент не может выйти на связь, переустановка не поможет. Путь между сервером и панелью закрыт у хостера одной из сторон.',
  partial: 'Часть адресов недоступна — смотрите список: закрыто выборочно, это фильтрация или сбой маршрута.',
  unknown: 'Проверка не дала результата.',
};

/** Текст для дела и для Джарвиса: построчно, с временем ответа, и вывод словами. */
export function egressText(r: EgressReport): string {
  const head = r.via
    ? `Куда сервер может выйти (зашли на него через «${r.via}» — напрямую панель не пускают):`
    : 'Куда сервер может выйти (проверка с самого сервера):';
  const lines = r.results.map(
    (x) =>
      `• ${x.target.label} — ${x.open ? `открыто${x.ms !== null ? ` (${x.ms} мс)` : ''}` : 'не подключается'}`,
  );
  const verdict = egressVerdict(r);
  const ping =
    r.panelPing === true && r.results.some((x) => x.target.group === 'panel' && !x.open)
      ? ' Пинг до панели при этом проходит: дорога есть, а подключения режутся — это фильтрация, а не обрыв.'
      : '';
  return `${head}\n${lines.join('\n')}\nЧто это значит: ${MEANING[verdict]}${ping}`;
}

/** Кого взять «ступенькой», если панель до сервера не достаёт: сервер парка, откуда порт открыт; не Россия. */
export function pickJump<T extends Pick<Server, 'name' | 'country'>>(
  openFrom: readonly string[],
  all: readonly T[],
): T | null {
  const candidates = all.filter((s) => openFrom.includes(s.name));
  return candidates.find((s) => s.country.code !== 'RU') ?? candidates[0] ?? null;
}

const HEADLINE: Record<EgressVerdict, string> = {
  ok: 'Сеть сервера в порядке: до панели он доходит.',
  no_internet: 'У сервера нет выхода в интернет.',
  ru_and_panel_cut: 'Агент установлен, но сеть сервера не пропускает трафик к панели и в Россию.',
  ru_cut: 'Сеть сервера не пропускает трафик в Россию.',
  panel_cut: 'Агент установлен, но сеть сервера не пропускает трафик к панели.',
  partial: 'Часть адресов с сервера недоступна.',
  unknown: 'Проверка не дала результата.',
};
const ADVICE: Record<EgressVerdict, string> = {
  ok: 'Причина в самом агенте: посмотрите журнал службы в SSH-терминале — «journalctl -u nodeservice-agent -n 20 --no-pager -l».',
  no_internet: 'Проверьте сервер у хостера и файрвол на самом сервере.',
  ru_and_panel_cut: 'Повторная установка не поможет — напишите хостеру или смените IP.',
  ru_cut: 'Людям из России нода недоступна — напишите хостеру или смените IP.',
  panel_cut: 'Повторная установка не поможет — напишите хостеру.',
  partial: 'Посмотрите, что именно закрыто, — это фильтрация или сбой маршрута.',
  unknown: 'Повторите проверку позже.',
};

/** Готовое обращение к хостеру: что не работает, что работает, почему это не наш файрвол. */
export function hosterText(r: EgressReport, serverHost: string): string {
  const closed = r.results
    .filter((x) => !x.open)
    .map((x) => `${x.target.label} (${x.target.host}:${x.target.port})`);
  const opened = r.results.filter((x) => x.open).map((x) => x.target.label);
  return [
    'Здравствуйте.',
    `С сервера ${serverHost} не устанавливаются TCP-подключения к части адресов${r.panelPing ? ', хотя ping до них проходит' : ''}.`,
    closed.length ? `Не подключается: ${closed.join(', ')}.` : '',
    opened.length ? `Подключается: ${opened.join(', ')}.` : '',
    'Файрвол на самом сервере эти адреса не блокирует. Проверьте, пожалуйста, фильтрацию или маршрутизацию на вашей стороне для трафика нашего сервера. С какого времени это началось и когда будет исправлено?',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Для окна сервера: результат, итог, фраза, совет и текст для хостера. */
export function egressDto(r: EgressReport, checkedAt: Date, serverHost: string): EgressReportDto {
  const verdict = egressVerdict(r);
  return {
    checkedAt: checkedAt.toISOString(),
    via: r.via,
    verdict,
    headline: HEADLINE[verdict],
    advice: ADVICE[verdict],
    panelPing: r.panelPing,
    results: r.results.map((x) => ({ label: x.target.label, group: x.target.group, open: x.open, ms: x.ms })),
    hosterText: hosterText(r, serverHost),
  };
}
