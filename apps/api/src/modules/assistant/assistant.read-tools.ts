import type { Incident } from '@nodeservice/shared';

import type { BillingService } from '../billing/billing.service.js';
import type { IncidentsService } from '../incidents/incidents.service.js';
import type { RemnawaveService } from '../remnawave/remnawave.service.js';
import type { RemnawaveTopologyService } from '../remnawave/remnawave-topology.service.js';
import { PLAYBOOKS, playbookById, renderPlaybook } from './assistant.playbooks.js';
import { REFERENCE, referenceById } from './assistant.reference.js';
import type { ToolOutcome } from './assistant.tools.js';
import type { LlmToolDef } from './llm.provider.js';

/** Инструменты только для чтения: Ассистент видит ноды, события и оплаты, но ничего не меняет. */
export const READ_TOOL_DEFS: LlmToolDef[] = [
  {
    name: 'get_remnawave_profiles',
    description:
      'Прочитать подключённую Remnawave без изменений. Без profile — каталог: профили конфигурации Xray для нод (и какие сниппеты каждый использует), сниппеты (общие куски конфига: сколько объектов, в каких профилях) и шаблоны подписки всех видов (Xray JSON, Mihomo, sing-box, Clash, Stash). С profile (точное имя, уникальная часть имени или UUID) и kind — одно целиком: kind=node — конфиг ноды, в котором ссылки {"snippet": "имя"} уже раскрыты так, как Remnawave собирает конфиг для ноды (вставленное помечено _fromSnippet; ссылки на несуществующие сниппеты перечислены в missingSnippets — Remnawave их молча выбрасывает); kind=snippet — содержимое сниппета и где он используется; kind=template — шаблон подписки (xray_json — только Xray JSON). Секреты (ключи Reality, пароли, UUID, email, токены, сертификаты, списки клиентов) скрываются до передачи тебе. Используй для вопросов о протоколе, inbound, Reality, transport, routing, outbounds, балансировщиках, сниппетах и шаблонах подписки.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['node', 'snippet', 'template', 'xray_json'] },
        profile: {
          type: 'string',
          description: 'имя или UUID профиля, имя сниппета или шаблона; без него — каталог',
        },
      },
    },
  },
  {
    name: 'get_remnawave_squads',
    description:
      'Сквады Remnawave, только чтение: внутренние (какие инбаунды — подключения: тег, протокол, сеть, защита, порт — выданы группе пользователей и сколько в ней людей) и внешние (какие шаблоны подписки и настройки подписки у группы). Используй, когда спрашивают, почему у пользователей нет какого-то подключения или кому что выдано.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'find_remnawave_user',
    description:
      'Пользователь Remnawave по точному имени (username), только чтение: статус (ACTIVE, DISABLED, LIMITED, EXPIRED), срок, трафик и лимит, сквады, сколько устройств и их лимит, когда был онлайн и на какой ноде, когда открывал подписку и каким приложением, тег и заметка. Ссылка подписки, ключи, пароли, UUID, почта и Telegram ID не передаются. Используй, когда владелец спрашивает про конкретного пользователя («почему у Васи не работает»).',
    input_schema: {
      type: 'object',
      properties: { username: { type: 'string', description: 'имя пользователя точно как в Remnawave' } },
      required: ['username'],
    },
  },
  {
    name: 'get_remnawave_topology',
    description:
      'Безопасная карта и разбор конфигураций Remnawave без секретов: профили, инбаунды, хосты, назначенные ноды, правила routing, outbounds, объяснение назначения каждого выхода и найденные разрывы. Используй, когда нужно понять путь клиент → хост → нода → выход, объяснить первый outbound по умолчанию, разобрать Psiphon/dialerProxy/балансировщик или проверить все профили. Пунктирная связь означает конфигурацию, а не измеренный живой трафик. Не называй неизвестный сервис ошибкой без подтверждения.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_incidents',
    description:
      'Список событий нод, новые сверху. status: open (открытые) | resolved (закрытые) | all (по умолчанию). nodeUuid — только по одной ноде Remnawave. limit — сколько вернуть (до 25, по умолчанию 10). По каждому: id, нода, вид, важность, статус, заголовок, времена, проверка Check-Host, если была. Отдельно даёт сводку по всей выборке: сколько событий на каждой ноде (byNode) и каких видов (byKind). Для вопросов «где больше событий» берите числа из сводки.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        nodeUuid: { type: 'string', description: 'UUID ноды Remnawave' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'get_incident',
    description:
      'Событие целиком по id: что случилось, снимок в момент события, хронология и проверка Check-Host, если была. Зови перед любым разбором.',
    input_schema: {
      type: 'object',
      properties: { incidentId: { type: 'string' } },
      required: ['incidentId'],
    },
  },
  {
    name: 'get_playbook',
    description: `Плейбук разбора: порядок чтения данных, как читать результат, какие проверки рекомендовать владельцу и чего панель не видит. Без id возвращает список плейбуков. id: ${PLAYBOOKS.map((p) => p.id).join(' | ')}. Сверяйся с плейбуком перед разбором сбоя.`,
    input_schema: { type: 'object', properties: { id: { type: 'string' } } },
  },
  {
    name: 'get_reference',
    description: `Справочник Ассистента: подробные знания по теме. Без id возвращает список тем. Открывайте нужную тему до ответа, когда вопрос про устройство панели, события, метрики, проверки, интеграции, сценарии, VPN-стек, блокировки, базу знаний, безопасность или про то, как строить ответ. id: ${REFERENCE.map((t) => t.id).join(' | ')}. Данные о конкретных нодах берите не отсюда, а из инструментов чтения.`,
    input_schema: { type: 'object', properties: { id: { type: 'string' } } },
  },
  {
    name: 'get_billing',
    description:
      'Биллинг: что и когда оплачивать — хостинг нод, аренда у провайдеров, домены, сертификаты, прочее. По каждой активной оплате: тип, название, провайдер, ноды, сумма и примерно в рублях по курсу ЦБ, период, до какого момента оплачено, срок словами («через 2 дня», «просрочено на 1 день»), автоплатёж, заметка. Плюс итоги: оплачено за месяц и год в рублях по курсу на день оплаты, сколько ещё ожидается до конца месяца, и прогноз (forecast): сколько платить в ближайшие 7 и 30 дней, до конца года, в год, по месяцам и список ближайших оплат с датами. Зови, когда спрашивают про оплату, деньги, сроки, и когда нода недоступна или упал онлайн: просроченная оплата или срок в ближайшие сутки — частая причина. archived — добавить архив.',
    input_schema: {
      type: 'object',
      properties: {
        archived: { type: 'boolean', description: 'true — добавить архив (до 30 записей)' },
      },
    },
  },
];

export interface ReadDeps {
  incidents: IncidentsService;
  /** Безопасное чтение конфигураций, сквадов и пользователей Remnawave; секреты удаляет сам сервис до передачи модели. */
  remnawaveProfiles?: Partial<Pick<RemnawaveService, 'squadsForAssistant' | 'userForAssistant'>> &
    Pick<RemnawaveService, 'profilesForAssistant'>;
  remnawaveTopology?: Pick<RemnawaveTopologyService, 'forAssistant'>;
  /** Биллинг: оплаты, сроки, итоги. Нет — инструмент скажет, что раздел недоступен. */
  billing?: Pick<BillingService, 'forAssistant'>;
}

const HISTORY_POINTS = 12;

const r2 = (n: number): number => Math.round(n * 100) / 100;
const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

export interface SeriesSummary {
  samples: number;
  last: number;
  min: number;
  avg: number;
  max: number;
  peakAt: string;
  trend: 'растёт' | 'падает' | 'ровно';
  points: Array<{ at: string; v: number }>;
}

/** Сводка ряда: Ассистенту нужна форма (пик, тренд), а не сотни точек. */
export function summarizeSeries(raw: Array<[number, number]>): SeriesSummary | null {
  const pts = raw.filter(([, v]) => Number.isFinite(v));
  if (pts.length === 0) return null;
  const vals = pts.map((p) => p[1]);
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const mean = avg(vals);
  const third = Math.max(1, Math.floor(vals.length / 3));
  const delta = avg(vals.slice(-third)) - avg(vals.slice(0, third));
  const threshold = 0.15 * Math.max(Math.abs(mean), max - min);
  const peak = pts[vals.indexOf(max)] as [number, number];
  const step = Math.max(1, (pts.length - 1) / (HISTORY_POINTS - 1));
  const picked = new Set<number>();
  for (let i = 0; i < HISTORY_POINTS && Math.round(i * step) < pts.length; i += 1)
    picked.add(Math.round(i * step));
  picked.add(pts.length - 1);
  return {
    samples: pts.length,
    last: r2(vals.at(-1) as number),
    min: r2(min),
    avg: r2(mean),
    max: r2(max),
    peakAt: new Date(peak[0] * 1000).toISOString(),
    trend: Math.abs(delta) <= threshold ? 'ровно' : delta > 0 ? 'растёт' : 'падает',
    points: [...picked]
      .sort((a, b) => a - b)
      .map((i) => ({
        at: new Date((pts[i] as [number, number])[0] * 1000).toISOString(),
        v: r2(vals[i] as number),
      })),
  };
}

/** Коротко о событии: для списка и для сводки по ноде. */
export function briefIncident(i: Incident) {
  return {
    id: i.id,
    node: i.serverName,
    nodeUuid: i.nodeUuid ?? null,
    diagnostics: i.diagnostics ?? null,
    kind: i.kind,
    severity: i.severity,
    status: i.status,
    title: i.title,
    openedAt: i.openedAt,
    resolvedAt: i.resolvedAt,
    resolvedBy: i.resolvedBy,
  };
}

/** Событие целиком: всё, что нужно для разбора причин. */
export function incidentCase(i: Incident) {
  return {
    ...briefIncident(i),
    detail: i.detail,
    snapshot: i.snapshot,
    timeline: i.timeline.map((e) => ({ at: e.at, by: e.by, action: e.action, result: e.result })),
  };
}

const none = (content: string): ToolOutcome => ({ content, citations: [] });

/** Выполнить инструмент чтения; null — это не он, пусть разбирается основной исполнитель. */
export async function runReadTool(
  name: string,
  arg: Record<string, unknown>,
  deps: ReadDeps,
): Promise<ToolOutcome | null> {
  if (name === 'get_remnawave_profiles') {
    if (!deps.remnawaveProfiles) return none('Чтение профилей Remnawave сейчас недоступно.');
    return none(JSON.stringify(await deps.remnawaveProfiles.profilesForAssistant(arg)));
  }
  if (name === 'get_remnawave_squads') {
    if (!deps.remnawaveProfiles?.squadsForAssistant) return none('Сквады Remnawave сейчас недоступны.');
    return none(JSON.stringify(await deps.remnawaveProfiles.squadsForAssistant()));
  }
  if (name === 'find_remnawave_user') {
    if (!deps.remnawaveProfiles?.userForAssistant) return none('Пользователи Remnawave сейчас недоступны.');
    return none(JSON.stringify(await deps.remnawaveProfiles.userForAssistant(arg.username)));
  }
  if (name === 'get_remnawave_topology') {
    if (!deps.remnawaveTopology) return none('Карта Remnawave сейчас недоступна.');
    return none(JSON.stringify(await deps.remnawaveTopology.forAssistant()));
  }

  if (name === 'list_incidents') {
    const status = arg.status === 'open' || arg.status === 'resolved' ? arg.status : 'all';
    const limitRaw = Number(arg.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(25, Math.floor(limitRaw)) : 10;
    const nodeUuid = typeof arg.nodeUuid === 'string' && arg.nodeUuid.trim() ? arg.nodeUuid.trim() : null;
    const res = await deps.incidents.list(status);
    // Сводки считаем по всей выборке (до среза по limit): «где больше событий» отвечается числами, а не первыми строками.
    const pool = res.items.filter((i) => nodeUuid === null || i.nodeUuid === nodeUuid);
    const items = [...pool].sort((a, b) => b.openedAt.localeCompare(a.openedAt)).slice(0, limit);
    const bump = (m: Map<string, { total: number; open: number }>, key: string, isOpen: boolean) => {
      const cur = m.get(key) ?? { total: 0, open: 0 };
      cur.total += 1;
      if (isOpen) cur.open += 1;
      m.set(key, cur);
    };
    const byNode = new Map<string, { total: number; open: number }>();
    const byKind = new Map<string, { total: number; open: number }>();
    for (const i of pool) {
      bump(byNode, i.serverName, i.status !== 'resolved');
      bump(byKind, i.title.split(' · ')[0] ?? i.kind, i.status !== 'resolved');
    }
    const rank = (m: Map<string, { total: number; open: number }>, label: string) =>
      [...m.entries()].sort((a, b) => b[1].total - a[1].total).map(([name, v]) => ({ [label]: name, ...v }));
    return {
      content: JSON.stringify({
        counts: res.counts,
        matched: pool.length,
        byNode: rank(byNode, 'node'),
        byKind: rank(byKind, 'title'),
        items: items.map(briefIncident),
      }),
      // Список ничего не прикрепляет: цитата нужна только у конкретного события, которое разбирали.
      citations: [],
    };
  }

  if (name === 'get_incident') {
    let inc: Incident;
    try {
      inc = await deps.incidents.get(String(arg.incidentId ?? ''));
    } catch {
      return none('Событие с таким id не найдено. Возьми id из list_incidents.');
    }
    return {
      content: JSON.stringify(incidentCase(inc)),
      citations: [{ type: 'incident', id: inc.id, label: inc.title }],
    };
  }

  if (name === 'get_playbook') {
    const id = String(arg.id ?? '').trim();
    if (!id) return none(JSON.stringify(PLAYBOOKS.map((p) => ({ id: p.id, title: p.title, when: p.when }))));
    const p = playbookById(id);
    return none(
      p ? renderPlaybook(p) : `Плейбука «${id}» нет. Доступные: ${PLAYBOOKS.map((x) => x.id).join(', ')}.`,
    );
  }

  if (name === 'get_reference') {
    const id = String(arg.id ?? '').trim();
    if (!id) return none(JSON.stringify(REFERENCE.map((t) => ({ id: t.id, title: t.title, when: t.when }))));
    const t = referenceById(id);
    return none(t ? t.render() : `Темы «${id}» нет. Доступные: ${REFERENCE.map((x) => x.id).join(', ')}.`);
  }

  if (name === 'get_billing') {
    if (!deps.billing) return none('Биллинг сейчас недоступен.');
    const data = await deps.billing.forAssistant({ archived: arg.archived === true });
    return none(
      JSON.stringify({
        ...data,
        hint:
          data.items.length === 0
            ? 'Оплат нет. Их заводят в разделе «Биллинг».'
            : 'state: overdue — просрочено, today — меньше суток (окно оплаты: при сбое связи такая же вероятная причина, как просрочка), soon — скоро, ok — не скоро. Смотри вид оплаты: хостинг («Сервер») объясняет сбой, только если нода не отвечает совсем; аренда — и когда выход работает, а вход арендодателя молчит; сертификат, домен и «Другое» ноду не выключают. Даты пересказывай по-русски.',
      }),
    );
  }

  return null;
}
