import { z } from 'zod';
export const scenarioSchema = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(2).max(100),
    enabled: z.boolean().default(false),
    scope: z.enum(['all', 'selected']).default('all'),
    nodes: z.array(z.uuid()).max(100).default([]),
    hostBindings: z
      .array(z.object({ hostUuid: z.uuid(), nodeUuid: z.uuid() }))
      .max(500)
      .default([]),
    trigger: z.enum(['offline', 'online_drop', 'tcp_unreachable']),
    conditions: z
      .array(z.enum(['offline', 'online_drop', 'tcp_unreachable']))
      .max(3)
      .default([]),
    conditionMode: z.enum(['all', 'any']).default('all'),
    holdMinutes: z.number().int().min(1).max(60).default(1),
    actions: z
      .array(z.enum(['check_tcp', 'record_event', 'notify', 'hide_host', 'rename_host']))
      .min(1)
      .max(5),
    renameMode: z.enum(['replace', 'prepend', 'append']).default('append'),
    renameText: z.string().trim().max(200).default(''),
    autoRestore: z.boolean().default(true),
    cooldownMinutes: z.number().int().min(5).max(1440).default(30),
  })
  .refine(
    (r) => r.scope === 'all' || r.nodes.length > 0,
    'Выберите хотя бы одну ноду для индивидуального сценария',
  )
  .refine(
    (r) => !r.actions.includes('rename_host') || r.renameText.length > 0,
    'Введите текст для изменения имени Host',
  )
  .refine(
    (r) => new Set(r.hostBindings.map((b) => b.hostUuid)).size === r.hostBindings.length,
    'Каждый Host можно назначить только одной ноде',
  )
  .refine((r) => new Set(r.conditions).size === r.conditions.length, 'Условия не должны повторяться')
  .refine((r) => new Set(r.actions).size === r.actions.length, 'Действия не должны повторяться');
export const scenariosSchema = z.object({ items: z.array(scenarioSchema).max(100) });
export type Scenario = z.infer<typeof scenarioSchema>;
/**
 * Срабатывание сценария для журнала на странице «Сценарии»: когда, на какой ноде и чем кончился каждый шаг.
 * `tone`: ok — хорошо, warn — неполно, crit — не вышло или нода недоступна, info — сведения, change — изменение в
 * Remnawave (имя Host, скрытие).
 */
export const scenarioRunStepSchema = z.object({
  text: z.string(),
  tone: z.enum(['ok', 'warn', 'crit', 'info', 'change']),
  /**
   * С 0.94.0 — для журнала: шаг сценария и его номер в момент срабатывания, слово-итог («доступен», «не вышло»)
   * и подробности после него. У записей до 0.94.0 их нет — журнал показывает `text`.
   */
  action: z.enum(['check_tcp', 'record_event', 'notify', 'hide_host', 'rename_host']).optional(),
  n: z.number().int().min(1).optional(),
  word: z.string().optional(),
  detail: z.string().optional(),
  /** Шаг не выполнен (ошибка), а не итог проверки вроде «недоступен из РФ». */
  failed: z.boolean().optional(),
  /** Шаг не выполнялся: перед ним не вышел другой шаг. */
  skipped: z.boolean().optional(),
  /** Событие, в которое записано срабатывание: ссылка из журнала. */
  incidentId: z.string().optional(),
});
export const scenarioRunSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  ruleName: z.string(),
  t: z.number(),
  nodeUuid: z.string(),
  nodeName: z.string(),
  /** run — сработал на сбое; restore — вернул Host после восстановления ноды (или сказал, почему нельзя). */
  kind: z.enum(['run', 'restore']),
  title: z.string(),
  /** С 0.94.0: условие фразой («нода потеряла связь») и сколько минут оно держалось перед срабатыванием. */
  condition: z.string().optional(),
  holdMinutes: z.number().optional(),
  steps: z.array(scenarioRunStepSchema),
  failed: z.boolean(),
});
export const scenarioRunsSchema = z.object({ items: z.array(scenarioRunSchema) });
export type ScenarioRun = z.infer<typeof scenarioRunSchema>;
export type ScenarioRunStep = z.infer<typeof scenarioRunStepSchema>;
export const scenarioLabels = {
  offline: 'Нода потеряла связь',
  online_drop: 'Подтверждено падение онлайна',
  tcp_unreachable: 'TCP недоступен',
};
export const scenarioActionLabels = {
  check_tcp: 'Проверить TCP',
  record_event: 'Записать событие',
  notify: 'Уведомить в Telegram',
  hide_host: 'Скрыть Host',
  rename_host: 'Изменить имя Host',
};
export const scenarioHostsSchema = z.object({
  hosts: z.array(
    z.object({
      uuid: z.string(),
      name: z.string(),
      address: z.string(),
      port: z.number().nullable(),
      nodes: z.array(z.string()),
      nodeNames: z.array(z.string()),
      bindingSource: z.string().default(''),
      disabled: z.boolean(),
      eligible: z.boolean(),
      reason: z.string(),
      ownedBy: z.string().nullable(),
      restoration: z.string().nullable(),
    }),
  ),
});

/** Spaces around the replacement/inserted fragment are part of the actual Host remark. */
/**
 * Новое имя Host по сценарию. Пометка уже стоит на своём месте (Host не вернули после прошлого сбоя) — имя
 * не меняется: «⚠️» не добавится второй раз.
 */
export function formatScenarioHostName(name: string, mode: 'replace' | 'prepend' | 'append', text: string) {
  const mark = text.trim();
  const fragment = ` ${mark} `;
  if (mode === 'replace') return fragment;
  if (mode === 'append') return mark && name.trimEnd().endsWith(mark) ? name : name.trimEnd() + fragment;
  const original = name.trimStart();
  const flag = original.match(
    /^(\p{Regional_Indicator}{2}|🏳️(?:‍🌈|‍⚧️)?|🏴(?:[\u{E0020}-\u{E007E}]+\u{E007F})?)\s*/u,
  );
  const rest = flag ? original.slice(flag[0].length) : original;
  if (mark && rest.startsWith(mark)) return name;
  return flag ? flag[1] + fragment + rest : fragment + original;
}

export const scenarioConditionDescriptions = {
  offline: 'Remnawave сообщает, что нода потеряла связь. Это состояние подключения ноды к панели Remnawave.',
  online_drop:
    'Мониторинг подтвердил снижение числа пользователей относительно обычного уровня. Нода при этом может оставаться на связи.',
  tcp_unreachable:
    'Check-Host подтвердил недоступность проверяемых TCP-портов из РФ или других стран. Это не доказывает выключение сервера; неполная проверка не запускает сценарий. Частота и порты — в разделе «Мониторинг нод».',
};
export const scenarioConditions = (rule: Scenario): Scenario['trigger'][] =>
  rule.conditions.length ? rule.conditions : [rule.trigger];
export const scenarioConditionLabel = (rule: Scenario) =>
  scenarioConditions(rule)
    .map((c) => scenarioLabels[c])
    .join(rule.conditionMode === 'all' ? ' И ' : ' ИЛИ ');
export function scenarioConditionMatches(rule: Scenario, states: Record<Scenario['trigger'], boolean>) {
  const values = scenarioConditions(rule).map((c) => states[c]);
  return rule.conditionMode === 'any' ? values.some(Boolean) : values.every(Boolean);
}
