import {
  type Scenario,
  type ScenarioRun,
  scenarioActionLabels,
  scenarioConditionLabel,
  scenarioOverview,
} from '@nodeservice/shared';

import type { LlmToolDef } from './llm.provider.js';

/**
 * Разделы панели, которые Ассистент читает целиком (просьба владельца 14.10.2026: «чтобы он всё просматривал»):
 * сценарии и их журнал, интеграции, резервные копии, свои сайты и провайдеры. Только чтение; ключи, токены, пароли
 * и почта скрываются по именам полей до передачи модели, адреса нод и доменов остаются — без них разбор невозможен.
 */
export const PANEL_TOOL_DEFS: LlmToolDef[] = [
  {
    name: 'get_scenarios',
    description:
      'Сценарии автоматизации («Сценарии»): правила «если → то» по нодам. Без scenario — все правила: включено ли, для каких нод, условия (нода потеряла связь, подтверждено падение онлайна, TCP недоступен; И/ИЛИ), сколько минут держится, шаги (проверить TCP, записать событие, уведомить, отключить Host, изменить имя Host), пауза между срабатываниями — и сводка по каждому: последнее срабатывание, сколько за сутки и неделю, сколько с замечаниями; плюс сколько Host сейчас отключено сценариями. С scenario (имя, часть имени или id) — правило целиком и его последние срабатывания по шагам: когда, на какой ноде, чем кончился каждый шаг. Только чтение — сценарии не запускаются и не меняются.',
    input_schema: {
      type: 'object',
      properties: { scenario: { type: 'string', description: 'имя, часть имени или id сценария' } },
    },
  },
  {
    name: 'get_integrations',
    description:
      'Интеграции («Интеграции»): DPI Checker (dpi — подключение, расписание проверок, последние проверки по нодам и точкам операторов), DNS-интеграции (dns — записи, какие обновляются сами при смене IP, история изменений), BS Checker (bs — аккаунт и кредиты, серверы точки, аренды, последние проверки белых списков). which: dpi | dns | bs | all (по умолчанию all). Ключи и токены скрыты. Только чтение — проверки не запускаются.',
    input_schema: {
      type: 'object',
      properties: { which: { type: 'string', enum: ['dpi', 'dns', 'bs', 'all'] } },
    },
  },
  {
    name: 'get_backups',
    description:
      'Резервные копии («Настройки» → «Резервные копии»): список копий (когда, вид, размер, зашифрована ли, проверена ли, отправлена ли в Telegram и во внешнее хранилище), идёт ли копия сейчас, следующая по расписанию, свободное место, доступны ли копии на этом сервере; и настройки: расписание, сколько хранить, задан ли пароль (сам пароль не передаётся), Telegram, внешнее хранилище (без ключей), дополнительные папки. Только чтение.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_sites_and_providers',
    description:
      'Свои сайты (группа «Свои сайты» в меню: названия и адреса) и провайдеры (хостинги нод из Remnawave, как в «Биллинге»: название, сайт, заметка, с какими нодами связаны). Только чтение.',
    input_schema: { type: 'object', properties: {} },
  },
];

export interface PanelDeps {
  scenarios?: {
    rules: () => Promise<Scenario[]>;
    runs: (limit: number) => Promise<ScenarioRun[]>;
    marked: () => Promise<number>;
    timeZone: () => Promise<string>;
    nodeNames: () => Promise<Map<string, string>>;
  };
  integrations?: {
    dpi?: () => Promise<unknown>;
    dns?: () => Promise<unknown>;
    bs?: () => Promise<unknown>;
  };
  backups?: { list: () => Promise<unknown>; settings: () => Promise<unknown> };
  providers?: () => Promise<unknown>;
  sites?: () => Promise<unknown>;
}

const SECRET_KEY =
  /^(api[-_]?key|apikey|token|access[-_]?token|refresh[-_]?token|secret|password|passwd|pass|private[-_]?key|key|credentials?|authorization|cookie|session|email|e[-_]?mail|ownurl|url[-_]?secret|accesskeyid|secretaccesskey)$/i;
const HIDDEN = '[скрыто]';

/**
 * Безопасная копия для модели: значения полей с секретными именами скрыты, почта и ссылки tgram:// с токеном бота
 * вычищены из строк, длинные списки и строки обрезаны. Адреса и имена остаются.
 */
export function safeForAssistant(value: unknown, depth = 0, key = ''): unknown {
  if (key && SECRET_KEY.test(key))
    return value === null || value === undefined || value === '' ? value : HIDDEN;
  if (depth > 8) return '[глубже не показано]';
  if (typeof value === 'string') {
    const clean = value
      .replace(/tgram:\/\/[^/\s]+/gi, 'tgram://[токен скрыт]')
      .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, HIDDEN)
      .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, HIDDEN);
    return clean.length > 1_500 ? `${clean.slice(0, 1_500)}…` : clean;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, 40).map((v) => safeForAssistant(v, depth + 1));
    return value.length > 40 ? [...head, `…ещё ${value.length - 40}`] : head;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, safeForAssistant(v, depth + 1, k)]),
  );
}

const content = (data: unknown): { content: string; citations: never[] } => ({
  content: JSON.stringify(data),
  citations: [],
});
const unavailable = (what: string) => content({ error: `${what} сейчас недоступны.` });

/** Правило сценария словами: условия, шаги, ноды — как его видит владелец на странице «Сценарии». */
function ruleBrief(rule: Scenario, names: Map<string, string>) {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    nodes: rule.scope === 'all' ? 'все ноды' : rule.nodes.map((uuid) => names.get(uuid) ?? uuid),
    conditions: scenarioConditionLabel(rule),
    holdMinutes: rule.holdMinutes,
    steps: rule.actions.map((a) => scenarioActionLabels[a]),
    ...(rule.actions.includes('rename_host')
      ? { rename: { mode: rule.renameMode, text: rule.renameText } }
      : {}),
    ...(rule.actions.includes('hide_host') || rule.actions.includes('rename_host')
      ? { autoRestore: rule.autoRestore, hostBindings: rule.hostBindings.length }
      : {}),
    cooldownMinutes: rule.cooldownMinutes,
  };
}

function runBrief(run: ScenarioRun) {
  return {
    at: new Date(run.t).toISOString(),
    node: run.nodeName,
    kind: run.kind === 'restore' ? 'возврат Host' : 'срабатывание',
    title: run.title,
    ...(run.condition ? { condition: run.condition, holdMinutes: run.holdMinutes } : {}),
    failed: run.failed,
    steps: run.steps.map((s) => ({
      ...(s.n ? { n: s.n } : {}),
      ...(s.action ? { step: scenarioActionLabels[s.action] } : {}),
      result: s.word ?? s.text,
      ...(s.detail ? { detail: s.detail } : {}),
      ...(s.failed ? { failed: true } : {}),
      ...(s.skipped ? { skipped: true } : {}),
    })),
  };
}

/** Выполнить инструмент разделов панели; null — это не он. */
export async function runPanelTool(
  name: string,
  arg: Record<string, unknown>,
  deps: PanelDeps,
): Promise<{ content: string; citations: never[] } | null> {
  if (name === 'get_scenarios') {
    const sc = deps.scenarios;
    if (!sc) return unavailable('Сценарии');
    const [rules, runs, marked, timeZone, names] = await Promise.all([
      sc.rules(),
      sc.runs(300),
      sc.marked(),
      sc.timeZone(),
      sc.nodeNames(),
    ]);
    if (!rules.length)
      return content({
        total: 0,
        hint: 'Сценариев нет или Remnawave не подключена: сценарии хранятся для подключённой панели Remnawave.',
      });
    const overview = scenarioOverview(rules, runs, marked, Date.now(), timeZone);
    const selector = typeof arg.scenario === 'string' ? arg.scenario.trim().toLowerCase() : '';
    if (!selector) {
      const stats = new Map(overview.items.map((i) => [i.ruleId, i]));
      const { daySlots: _slots, ...tiles } = overview.tiles;
      return content({
        total: rules.length,
        tiles,
        timeZone,
        items: rules.map((rule) => {
          const st = stats.get(rule.id);
          return {
            ...ruleBrief(rule, names),
            lastRun: st?.last
              ? {
                  at: new Date(st.last.t).toISOString(),
                  node: st.last.nodeName,
                  result: st.last.text,
                  tone: st.last.tone,
                }
              : null,
            day: st?.day ?? 0,
            dayWithIssues: st?.dayWarn ?? 0,
            week: st?.week ?? 0,
            weekWarnings: st?.weekWarn ?? 0,
            weekFailures: st?.weekCrit ?? 0,
          };
        }),
        hint: 'tiles.marked — сколько Host сейчас отключено или переименовано сценариями и ждут возврата. Время — UTC, называй его в поясе панели.',
      });
    }
    const exact = rules.filter((r) => r.id.toLowerCase() === selector || r.name.toLowerCase() === selector);
    const found = exact.length ? exact : rules.filter((r) => r.name.toLowerCase().includes(selector));
    if (found.length !== 1)
      return content({
        error: found.length
          ? `«${arg.scenario}» неоднозначно — уточните имя.`
          : `Сценария «${arg.scenario}» нет.`,
        available: rules.map((r) => r.name),
      });
    const rule = found[0] as Scenario;
    return content({
      rule: ruleBrief(rule, names),
      runs: runs
        .filter((r) => r.ruleId === rule.id)
        .slice(0, 15)
        .map(runBrief),
      hint: 'runs — последние срабатывания, новые сверху; failed — шаг не выполнен (ошибка), а не итог проверки.',
    });
  }

  if (name === 'get_integrations') {
    const which = arg.which === 'dpi' || arg.which === 'dns' || arg.which === 'bs' ? arg.which : 'all';
    const src = deps.integrations ?? {};
    const read = async (fn: (() => Promise<unknown>) | undefined) => {
      if (!fn) return { error: 'Раздел недоступен.' };
      try {
        return safeForAssistant(await fn());
      } catch (err) {
        return { error: err instanceof Error ? err.message : 'Не удалось прочитать.' };
      }
    };
    return content({
      ...(which === 'all' || which === 'dpi' ? { dpi: await read(src.dpi) } : {}),
      ...(which === 'all' || which === 'dns' ? { dns: await read(src.dns) } : {}),
      ...(which === 'all' || which === 'bs' ? { bs: await read(src.bs) } : {}),
      safety: 'Только чтение. Ключи доступа и токены скрыты.',
    });
  }

  if (name === 'get_backups') {
    if (!deps.backups) return unavailable('Резервные копии');
    const [list, settings] = await Promise.all([deps.backups.list(), deps.backups.settings()]);
    return content({
      backups: safeForAssistant(list),
      settings: safeForAssistant(settings),
      hint: 'passwordSet — задан ли пароль копий; сам пароль и ключи внешнего хранилища не передаются. Время — UTC.',
    });
  }

  if (name === 'get_sites_and_providers') {
    const [sites, providers] = await Promise.all([
      deps.sites ? deps.sites().catch(() => null) : null,
      deps.providers ? deps.providers().catch(() => null) : null,
    ]);
    return content({
      sites: sites === null ? { error: 'Свои сайты недоступны.' } : safeForAssistant(sites),
      providers: providers === null ? { error: 'Провайдеры недоступны.' } : safeForAssistant(providers),
    });
  }

  return null;
}
