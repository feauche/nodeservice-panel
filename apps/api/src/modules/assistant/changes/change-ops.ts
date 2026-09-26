import {
  type ActionLevel,
  type AssistantChange,
  AUTOFIX_POLICIES,
  AUTOFIX_POLICY_LABELS,
  autofixPolicySchema,
  type ChangeOperation,
  type ChangeRow,
  compareVersions,
  DISK_CLEANUP_OFFER_PCT,
  INCIDENT_KINDS,
  type Incident,
  MAINTENANCE_KIND_LABELS,
  MAINTENANCE_TIERS,
  type MaintenanceKind,
  NODE_WATCH_LABELS,
  NODE_WATCH_MODES,
  normalizeProfilePatch,
  SERVER_IMPORTANCE_LABELS,
  SERVER_NOTES_MAX,
  SERVER_ROLE_SHORT,
  SERVER_TAGS_MAX,
  type Server,
  type ServerProfile,
  type ServerProfilePatch,
  serverNameSchema,
  serverProfilePatchSchema,
  tagSchema,
} from '@nodeservice/shared';
import { z } from 'zod';

import type { IncidentsService } from '../../incidents/incidents.service.js';
import type { MaintenanceService } from '../../maintenance/maintenance.service.js';
import type { ProvidersService } from '../../providers/providers.service.js';
import type { ServersService } from '../../servers/servers.service.js';

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Всё, что нужно операциям: существующие сервисы панели (изменения идут теми же путями, что и ручные). */
export interface ChangeCtx {
  servers: Pick<ServersService, 'list' | 'update'>;
  providers: Pick<ProvidersService, 'list'>;
  incidents: Pick<IncidentsService, 'get' | 'resolveManual' | 'policy' | 'updatePolicy'>;
  maintenance: Pick<MaintenanceService, 'start' | 'state' | 'runs'>;
}

/** То, что показывается человеку и что хранится вместе с изменением. */
export interface ChangePlan {
  title: string;
  /** Уровень именно этого предложения; без него берётся уровень операции. */
  level?: ActionLevel;
  target: AssistantChange['target'];
  rows: ChangeRow[];
  consequence: string | null;
  reversible: boolean;
  /** Что читаем перед применением и после него; сравнивается по значению. */
  before: Json;
  after: Json;
  /** Что нужно для отката, если недостаточно `before`. */
  undo?: Json;
  /** Аргументы, как их прислала модель: по ним заново собираем превью, когда состояние ушло вперёд. */
  raw?: Record<string, Json>;
  /** Что вернуло применение (например, id запущенного обслуживания). */
  outcome?: Json;
}

export type Built = { args: Record<string, Json>; plan: ChangePlan } | { problem: string };

export interface ChangeOp {
  level: ActionLevel;
  /** Аргументы от модели (имена вместо id и т. п.). */
  schema: z.ZodType<Record<string, unknown>>;
  /** Проверить допустимость, привести аргументы к каноническому виду и собрать превью по живому состоянию. */
  build(raw: Record<string, unknown>, ctx: ChangeCtx): Promise<Built>;
  /** Текущее значение в той же форме, что `plan.before` и `plan.after`. */
  read(args: Record<string, Json>, ctx: ChangeCtx): Promise<Json>;
  /** Применить; может вернуть результат (id запуска), он сохранится в `plan.outcome`. */
  apply(args: Record<string, Json>, plan: ChangePlan, ctx: ChangeCtx): Promise<unknown>;
  /** Своя проверка результата вместо сравнения `read()` с `plan.after` (когда работа идёт в фоне). */
  verify?(args: Record<string, Json>, plan: ChangePlan, ctx: ChangeCtx): Promise<boolean>;
  /** Свежий ход фоновой работы для карточки: текст и идёт ли ещё. */
  progress?(
    args: Record<string, Json>,
    plan: ChangePlan,
    ctx: ChangeCtx,
  ): Promise<{ note: string; live: boolean } | null>;
  /** Есть только у обратимых операций. */
  revert?(args: Record<string, Json>, plan: ChangePlan, ctx: ChangeCtx): Promise<void>;
}

/* ---------- вспомогательное ---------- */

/** Сравнение по значению независимо от порядка ключей. */
export function same(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([x], [y]) => x.localeCompare(y))
              .map(([k, val]) => [k, canon(val)]),
          )
        : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

const DASH = '—';
const clip = (s: string, max = 300): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const list = (items: readonly (string | number)[]): string => (items.length > 0 ? items.join(', ') : DASH);

function listRow(
  label: string,
  before: readonly (string | number)[],
  after: readonly (string | number)[],
): ChangeRow {
  const b = new Set(before.map(String));
  const a = new Set(after.map(String));
  const added = after.map(String).filter((x) => !b.has(x));
  const removed = before.map(String).filter((x) => !a.has(x));
  return {
    label,
    before: list(before),
    after: list(after),
    ...(added.length > 0 ? { added } : {}),
    ...(removed.length > 0 ? { removed } : {}),
  };
}

const serverRef = z.string().trim().min(1).max(200).describe('Имя или id сервера');

async function findServer(ctx: ChangeCtx, ref: string): Promise<{ server: Server } | { problem: string }> {
  const servers = await ctx.servers.list();
  const key = ref.trim();
  const found =
    servers.find((s) => s.id === key) ?? servers.find((s) => s.name.toLowerCase() === key.toLowerCase());
  if (found) return { server: found };
  return {
    problem: `Сервер «${ref}» не найден. Возьмите точное имя или id из get_fleet_status. Карточка не создана.`,
  };
}

const serverTarget = (s: Server): AssistantChange['target'] => ({ type: 'server', id: s.id, label: s.name });

async function currentServer(ctx: ChangeCtx, args: Record<string, Json>): Promise<Server> {
  const id = String(args.serverId);
  const found = (await ctx.servers.list()).find((s) => s.id === id);
  if (!found) throw new Error('Сервера больше нет в панели.');
  return found;
}

const NO_CHANGE = (what: string): { problem: string } => ({
  problem: `${what} Менять нечего, карточка не создана.`,
});

/* ---------- операции над сервером ---------- */

const provider: ChangeOp = {
  level: 'T1',
  schema: z.object({ server: serverRef, provider: z.string().trim().max(120).nullable() }),
  async build(raw, ctx) {
    const s = await findServer(ctx, String(raw.server));
    if ('problem' in s) return s;
    let providerId: string | null = null;
    let providerName = DASH;
    if (raw.provider !== null && raw.provider !== undefined && String(raw.provider).trim()) {
      const ref = String(raw.provider).trim();
      const all = await ctx.providers.list();
      const found =
        all.find((p) => p.id === ref) ?? all.find((p) => p.name.toLowerCase() === ref.toLowerCase());
      if (!found)
        return {
          problem: `Провайдера «${ref}» нет. Есть: ${all.map((p) => p.name).join(', ') || 'ни одного'}. Новый провайдер добавляется вручную в «Серверы → Провайдеры». Карточка не создана.`,
        };
      providerId = found.id;
      providerName = found.name;
    }
    if (s.server.providerId === providerId) return NO_CHANGE('У сервера уже такой провайдер.');
    const all = await ctx.providers.list();
    const beforeName = all.find((p) => p.id === s.server.providerId)?.name ?? DASH;
    return {
      args: { serverId: s.server.id, providerId },
      plan: {
        title: 'Сменить провайдера',
        target: serverTarget(s.server),
        rows: [{ label: 'Провайдер', before: beforeName, after: providerName }],
        consequence: 'Провайдер только помечает сервер и на его работу не влияет.',
        reversible: true,
        before: { providerId: s.server.providerId },
        after: { providerId },
      },
    };
  },
  async read(args, ctx) {
    return { providerId: (await currentServer(ctx, args)).providerId };
  },
  async apply(args, _plan, ctx) {
    await ctx.servers.update(String(args.serverId), { providerId: args.providerId as string | null });
  },
  async revert(args, plan, ctx) {
    await ctx.servers.update(String(args.serverId), {
      providerId: (plan.before as { providerId: string | null }).providerId,
    });
  },
};

const tags: ChangeOp = {
  level: 'T1',
  schema: z.object({
    server: serverRef,
    add: z.array(z.string()).max(SERVER_TAGS_MAX).optional(),
    remove: z.array(z.string()).max(SERVER_TAGS_MAX).optional(),
  }),
  async build(raw, ctx) {
    const s = await findServer(ctx, String(raw.server));
    if ('problem' in s) return s;
    const add = (raw.add as string[] | undefined) ?? [];
    const remove = ((raw.remove as string[] | undefined) ?? []).map((t) => t.trim().toLowerCase());
    if (add.length === 0 && remove.length === 0)
      return { problem: 'Не указано, какие теги добавить (add) или убрать (remove). Карточка не создана.' };
    const parsed: string[] = [];
    for (const t of add) {
      const ok = tagSchema.safeParse(t);
      if (!ok.success)
        return {
          problem: `Тег «${t}» не подходит: ${ok.error.issues[0]?.message ?? 'неверный формат'}. Карточка не создана.`,
        };
      parsed.push(ok.data);
    }
    const before = s.server.tags;
    const kept = before.filter((t) => !remove.includes(t.toLowerCase()));
    const next = [...kept];
    for (const t of parsed) if (!next.some((x) => x.toLowerCase() === t.toLowerCase())) next.push(t);
    if (next.length > SERVER_TAGS_MAX)
      return { problem: `У сервера не может быть больше ${SERVER_TAGS_MAX} тегов. Карточка не создана.` };
    if (same(before, next)) return NO_CHANGE('Теги уже такие.');
    return {
      args: { serverId: s.server.id, tags: next },
      plan: {
        title: 'Изменить теги',
        target: serverTarget(s.server),
        rows: [listRow('Теги', before, next)],
        consequence: null,
        reversible: true,
        before: { tags: before },
        after: { tags: next },
      },
    };
  },
  async read(args, ctx) {
    return { tags: (await currentServer(ctx, args)).tags };
  },
  async apply(args, _plan, ctx) {
    await ctx.servers.update(String(args.serverId), { tags: args.tags as string[] });
  },
  async revert(args, plan, ctx) {
    await ctx.servers.update(String(args.serverId), { tags: (plan.before as { tags: string[] }).tags });
  },
};

const notes: ChangeOp = {
  level: 'T1',
  schema: z.object({
    server: serverRef,
    notes: z
      .string()
      .max(SERVER_NOTES_MAX * 2)
      .nullable(),
  }),
  async build(raw, ctx) {
    const s = await findServer(ctx, String(raw.server));
    if ('problem' in s) return s;
    const text = raw.notes === null ? null : String(raw.notes).trim() || null;
    if (text !== null && text.length > SERVER_NOTES_MAX)
      return {
        problem: `Заметка длиннее ${SERVER_NOTES_MAX} знаков (${text.length}). Сократите текст. Карточка не создана.`,
      };
    if ((s.server.notes ?? null) === text) return NO_CHANGE('Заметка уже такая.');
    return {
      args: { serverId: s.server.id, notes: text },
      plan: {
        title: 'Изменить заметку',
        target: serverTarget(s.server),
        rows: [{ label: 'Заметка', before: clip(s.server.notes ?? DASH), after: clip(text ?? DASH) }],
        consequence: null,
        reversible: true,
        before: { notes: s.server.notes ?? null },
        after: { notes: text },
      },
    };
  },
  async read(args, ctx) {
    return { notes: (await currentServer(ctx, args)).notes ?? null };
  },
  async apply(args, _plan, ctx) {
    await ctx.servers.update(String(args.serverId), { notes: args.notes as string | null });
  },
  async revert(args, plan, ctx) {
    await ctx.servers.update(String(args.serverId), {
      notes: (plan.before as { notes: string | null }).notes,
    });
  },
};

const rename: ChangeOp = {
  level: 'T1',
  schema: z.object({ server: serverRef, name: z.string().trim().min(1).max(200) }),
  async build(raw, ctx) {
    const s = await findServer(ctx, String(raw.server));
    if ('problem' in s) return s;
    const name = serverNameSchema.safeParse(raw.name);
    if (!name.success)
      return {
        problem: `Название не подходит: ${name.error.issues[0]?.message ?? 'неверный формат'}. Карточка не создана.`,
      };
    if (name.data === s.server.name) return NO_CHANGE('Сервер уже так называется.');
    const taken = (await ctx.servers.list()).some(
      (x) => x.id !== s.server.id && x.name.toLowerCase() === name.data.toLowerCase(),
    );
    if (taken) return { problem: `Название «${name.data}» уже занято другим сервером. Карточка не создана.` };
    return {
      args: { serverId: s.server.id, name: name.data },
      plan: {
        title: 'Переименовать сервер',
        target: serverTarget(s.server),
        rows: [{ label: 'Название', before: s.server.name, after: name.data }],
        consequence:
          'Новое название появится в списке серверов и в инцидентах; в прежних записях Журнала останется старое.',
        reversible: true,
        before: { name: s.server.name },
        after: { name: name.data },
      },
    };
  },
  async read(args, ctx) {
    return { name: (await currentServer(ctx, args)).name };
  },
  async apply(args, _plan, ctx) {
    await ctx.servers.update(String(args.serverId), { name: String(args.name) });
  },
  async revert(args, plan, ctx) {
    await ctx.servers.update(String(args.serverId), { name: (plan.before as { name: string }).name });
  },
};

const NODE_WATCH_CONSEQUENCE: Record<(typeof NODE_WATCH_MODES)[number], string> = {
  auto: 'Панель будет следить за нодой, только если найдёт её контейнер.',
  on: 'Если контейнер ноды остановится или пропадёт, панель заведёт инцидент.',
  off: 'Панель перестанет следить за нодой на этом сервере: инцидент об остановленной ноде заводиться не будет.',
};

const nodeWatch: ChangeOp = {
  level: 'T1',
  schema: z.object({ server: serverRef, mode: z.enum(NODE_WATCH_MODES) }),
  async build(raw, ctx) {
    const s = await findServer(ctx, String(raw.server));
    if ('problem' in s) return s;
    const mode = raw.mode as (typeof NODE_WATCH_MODES)[number];
    if (s.server.nodeWatch === mode) return NO_CHANGE('Слежение за нодой уже в этом режиме.');
    return {
      args: { serverId: s.server.id, nodeWatch: mode },
      plan: {
        title: 'Изменить слежение за нодой',
        target: serverTarget(s.server),
        rows: [
          { label: 'Нода', before: NODE_WATCH_LABELS[s.server.nodeWatch], after: NODE_WATCH_LABELS[mode] },
        ],
        consequence: NODE_WATCH_CONSEQUENCE[mode],
        reversible: true,
        before: { nodeWatch: s.server.nodeWatch },
        after: { nodeWatch: mode },
      },
    };
  },
  async read(args, ctx) {
    return { nodeWatch: (await currentServer(ctx, args)).nodeWatch };
  },
  async apply(args, _plan, ctx) {
    await ctx.servers.update(String(args.serverId), {
      nodeWatch: args.nodeWatch as (typeof NODE_WATCH_MODES)[number],
    });
  },
  async revert(args, plan, ctx) {
    await ctx.servers.update(String(args.serverId), {
      nodeWatch: (plan.before as { nodeWatch: (typeof NODE_WATCH_MODES)[number] }).nodeWatch,
    });
  },
};

const PROFILE_KEYS = [
  'roles',
  'importance',
  'maintenanceWindow',
  'expectedContainers',
  'expectedPorts',
] as const;

const pickProfile = (p: ServerProfile, keys: readonly string[]): Record<string, Json> =>
  Object.fromEntries(keys.map((k) => [k, (p as unknown as Record<string, Json>)[k] as Json]));

const profile: ChangeOp = {
  level: 'T1',
  schema: z.object({ server: serverRef }).extend(serverProfilePatchSchema.shape),
  async build(raw, ctx) {
    const s = await findServer(ctx, String(raw.server));
    if ('problem' in s) return s;
    const { server: _ref, ...rest } = raw;
    const patch = normalizeProfilePatch(serverProfilePatchSchema.parse(rest));
    const keys = PROFILE_KEYS.filter((k) => patch[k] !== undefined);
    if (keys.length === 0)
      return { problem: 'Не указано ни одного поля профиля для изменения. Карточка не создана.' };
    const cur = s.server.profile;
    const changed = keys.filter((k) => !same(cur[k], patch[k]));
    if (changed.length === 0) return NO_CHANGE('Профиль уже такой.');
    const rows: ChangeRow[] = [];
    for (const k of changed) {
      if (k === 'roles')
        rows.push(
          listRow(
            'Функции сервера',
            cur.roles.map((r) => SERVER_ROLE_SHORT[r]),
            (patch.roles ?? []).map((r) => SERVER_ROLE_SHORT[r]),
          ),
        );
      else if (k === 'importance')
        rows.push({
          label: 'Важность',
          before: SERVER_IMPORTANCE_LABELS[cur.importance],
          after: SERVER_IMPORTANCE_LABELS[patch.importance ?? cur.importance],
        });
      else if (k === 'maintenanceWindow')
        rows.push({
          label: 'Окно обслуживания',
          before: cur.maintenanceWindow ?? DASH,
          after: patch.maintenanceWindow ?? DASH,
        });
      else if (k === 'expectedContainers')
        rows.push(listRow('Ожидаемые контейнеры', cur.expectedContainers, patch.expectedContainers ?? []));
      else rows.push(listRow('Ожидаемые порты', cur.expectedPorts, patch.expectedPorts ?? []));
    }
    const consequences = [
      patch.importance === 'critical' && cur.importance !== 'critical'
        ? 'Для критичного сервера Джарвис будет называть последствия и окно обслуживания.'
        : null,
      changed.includes('expectedContainers') || changed.includes('expectedPorts')
        ? 'Панель начнёт сверять ожидаемое со снимком состояния и показывать расхождения.'
        : null,
    ].filter(Boolean);
    const only = Object.fromEntries(changed.map((k) => [k, patch[k] as Json]));
    return {
      args: { serverId: s.server.id, patch: only },
      plan: {
        title: 'Изменить профиль сервера',
        target: serverTarget(s.server),
        rows,
        consequence: consequences.length > 0 ? consequences.join(' ') : null,
        reversible: true,
        before: pickProfile(cur, changed),
        after: only,
      },
    };
  },
  async read(args, ctx) {
    const s = await currentServer(ctx, args);
    return pickProfile(s.profile, Object.keys(args.patch as object));
  },
  async apply(args, _plan, ctx) {
    await ctx.servers.update(String(args.serverId), { profile: args.patch as ServerProfilePatch });
  },
  async revert(args, plan, ctx) {
    await ctx.servers.update(String(args.serverId), { profile: plan.before as ServerProfilePatch });
  },
};

/* ---------- инциденты и автопочинка ---------- */

const INCIDENT_STATUS_LABEL: Record<Incident['status'], string> = {
  open: 'Открыт',
  acknowledged: 'В работе',
  resolved: 'Закрыт',
};

const incidentResolve: ChangeOp = {
  level: 'T2',
  schema: z.object({ incidentId: z.uuid() }),
  async build(raw, ctx) {
    let inc: Incident;
    try {
      inc = await ctx.incidents.get(String(raw.incidentId));
    } catch {
      return {
        problem: 'Инцидент с таким id не найден. Возьмите id из list_incidents. Карточка не создана.',
      };
    }
    if (inc.status === 'resolved') return NO_CHANGE('Инцидент уже закрыт.');
    const running = inc.attempts.some((a) => a.status === 'running');
    return {
      args: { incidentId: inc.id },
      plan: {
        title: 'Закрыть инцидент',
        target: { type: 'incident', id: inc.id, label: inc.title },
        rows: [{ label: 'Статус', before: INCIDENT_STATUS_LABEL[inc.status], after: 'Закрыт вручную' }],
        consequence: `Если проблема осталась, панель заведёт новый инцидент.${running ? ' Идущая попытка починки будет прервана.' : ''} Закрытие кнопкой не отменяется.`,
        reversible: false,
        before: { resolved: false },
        after: { resolved: true },
      },
    };
  },
  async read(args, ctx) {
    return { resolved: (await ctx.incidents.get(String(args.incidentId))).status === 'resolved' };
  },
  async apply(args, _plan, ctx) {
    await ctx.incidents.resolveManual(String(args.incidentId));
  },
};

const pauseLabel = (minutes: number): string =>
  minutes % 60 === 0 && minutes >= 60 ? `${minutes / 60} ч` : `${minutes} мин`;

const autofixPause: ChangeOp = {
  level: 'T1',
  schema: z.object({ minutes: z.number().int().min(0).max(1440) }),
  async build(raw, ctx) {
    const minutes = Number(raw.minutes);
    const policy = await ctx.incidents.policy();
    if (!policy.autofixEnabled)
      return { problem: 'Автопочинка выключена в настройках инцидентов: ставить на паузу нечего.' };
    const until = policy.pausedUntil;
    const left = until ? Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 60_000)) : 0;
    if (minutes === 0 && !until) return NO_CHANGE('Автопочинка и так не на паузе.');
    return {
      args: { minutes },
      plan: {
        title: minutes > 0 ? 'Поставить автопочинку на паузу' : 'Снять автопочинку с паузы',
        target: { type: 'settings', id: 'incidents', label: 'Автопочинка' },
        rows: [
          {
            label: 'Автопочинка',
            before: until ? `На паузе, осталось ${pauseLabel(left)}` : 'Работает',
            after: minutes > 0 ? `На паузе на ${pauseLabel(minutes)}` : 'Работает',
          },
        ],
        consequence:
          minutes > 0
            ? 'Пока пауза, панель сама ничего не чинит; инциденты по-прежнему заводятся и видны.'
            : null,
        reversible: true,
        before: { paused: Boolean(until) },
        after: { paused: minutes > 0 },
        undo: { pausedUntil: until },
      },
    };
  },
  async read(_args, ctx) {
    return { paused: Boolean((await ctx.incidents.policy()).pausedUntil) };
  },
  async apply(args, _plan, ctx) {
    await ctx.incidents.updatePolicy({ pauseMinutes: Number(args.minutes) });
  },
  async revert(_args, plan, ctx) {
    const until = (plan.undo as { pausedUntil: string | null } | undefined)?.pausedUntil ?? null;
    const minutes = until ? Math.max(0, Math.ceil((Date.parse(until) - Date.now()) / 60_000)) : 0;
    await ctx.incidents.updatePolicy({ pauseMinutes: minutes });
  },
};

const policyConsequence = (policy: (typeof AUTOFIX_POLICIES)[number]): string =>
  policy === 'auto'
    ? 'Панель сама выполнит безопасные шаги (T1) при этом виде инцидента, без вашего нажатия. Шаги с подтверждением (T2) по-прежнему только по вашему решению.'
    : policy === 'ask'
      ? 'Панель предложит шаги и будет ждать вашего подтверждения.'
      : 'Панель только следит: шаги не предлагаются и не выполняются.';

const autofixPolicy: ChangeOp = {
  level: 'T2',
  schema: z.object({ kind: z.enum(INCIDENT_KINDS), policy: autofixPolicySchema }),
  async build(raw, ctx) {
    const kind = raw.kind as (typeof INCIDENT_KINDS)[number];
    const policy = raw.policy as (typeof AUTOFIX_POLICIES)[number];
    const all = await ctx.incidents.policy();
    const item = all.items.find((i) => i.kind === kind);
    if (!item) return { problem: `Вида инцидента «${kind}» нет. Карточка не создана.` };
    if (item.policy === policy)
      return NO_CHANGE(`Для «${item.label}» уже выбран режим «${AUTOFIX_POLICY_LABELS[policy]}».`);
    if (policy === 'auto' && !item.autoAvailable)
      return {
        problem: `Для «${item.label}» нет безопасного шага (T1), который панель могла бы делать сама: режим «Само» недоступен. Доступны «Спросить» и «Наблюдать». Карточка не создана.`,
      };
    const off = all.autofixEnabled
      ? ''
      : ' Общий выключатель автопочинки в настройках инцидентов сейчас выключен: режим заработает после его включения.';
    return {
      args: { kind, policy },
      plan: {
        title: 'Изменить режим автопочинки',
        level: policy === 'auto' ? 'T2' : 'T1',
        target: { type: 'settings', id: 'incidents', label: `Автопочинка: ${item.label}` },
        rows: [
          {
            label: `Режим для «${item.label}»`,
            before: AUTOFIX_POLICY_LABELS[item.policy],
            after: AUTOFIX_POLICY_LABELS[policy],
          },
        ],
        consequence: `${policyConsequence(policy)}${off}`,
        reversible: true,
        before: { policy: item.policy },
        after: { policy },
      },
    };
  },
  async read(args, ctx) {
    const item = (await ctx.incidents.policy()).items.find((i) => i.kind === args.kind);
    return { policy: item?.policy ?? null };
  },
  async apply(args, _plan, ctx) {
    await ctx.incidents.updatePolicy({
      policy: { [String(args.kind)]: args.policy as (typeof AUTOFIX_POLICIES)[number] },
    });
  },
  async revert(args, plan, ctx) {
    await ctx.incidents.updatePolicy({
      policy: { [String(args.kind)]: (plan.before as { policy: (typeof AUTOFIX_POLICIES)[number] }).policy },
    });
  },
};

/** Какое обслуживание Джарвис может предложить. Обновление системы (apt upgrade) сознательно не входит: только вручную. */
const MAINT_KINDS = ['check', 'agent_update', 'cleanup', 'unattended_enable'] as const;

const MAINT_TITLES: Record<(typeof MAINT_KINDS)[number], string> = {
  check: 'Проверить сервер',
  agent_update: 'Обновить агента',
  cleanup: 'Очистить диск',
  unattended_enable: 'Включить автообновления безопасности',
};

const ago = (iso: string): string => {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return min < 60
    ? `${min} мин назад`
    : min < 1440
      ? `${Math.round(min / 60)} ч назад`
      : `${Math.round(min / 1440)} дн назад`;
};

const maintenanceRun: ChangeOp = {
  level: 'T2',
  schema: z.object({ server: serverRef, kind: z.enum(MAINT_KINDS) }),
  async build(raw, ctx) {
    const s = await findServer(ctx, String(raw.server));
    if ('problem' in s) return s;
    const kind = raw.kind as (typeof MAINT_KINDS)[number];
    if (s.server.sshOk === false)
      return {
        problem: `К серверу сейчас нет доступа по SSH: сначала «Проверить связь». Карточка не создана.`,
      };
    const st = await ctx.maintenance.state(s.server.id);
    if (st.running)
      return { problem: 'На этом сервере уже идёт обслуживание: дождитесь завершения. Карточка не создана.' };
    const check = st.check;
    const needCheck = {
      problem: 'Данных проверки сервера ещё нет: сначала предложите операцию «check». Карточка не создана.',
    };
    let rows: ChangeRow[];
    let consequence: string;
    if (kind === 'check') {
      rows = [
        {
          label: 'Проверка сервера',
          before: check ? `Последняя: ${ago(check.checkedAt)}` : 'Ещё не было',
          after: 'Запустится сейчас',
        },
      ];
      consequence = 'Только чтение: ничего на сервере не меняет. Займёт около минуты.';
    } else if (kind === 'agent_update') {
      if (!check) return needCheck;
      const { installed, latest } = check.agent;
      if (!installed)
        return { problem: 'Агент на сервере не установлен: обновлять нечего. Карточка не создана.' };
      if (!latest)
        return { problem: 'Последняя версия агента неизвестна: сначала «check». Карточка не создана.' };
      if (compareVersions(latest, installed) <= 0) return NO_CHANGE('Агент уже последней версии.');
      rows = [
        {
          label: 'Агент',
          before: `v${installed.replace(/^v/i, '')}`,
          after: `v${latest.replace(/^v/i, '')}`,
        },
      ];
      consequence =
        'Панель скачает релиз, проверит сумму и перезапустит агента: несколько секунд без связи с агентом. Нода и трафик не затрагиваются.';
    } else if (kind === 'cleanup') {
      if (!check) return needCheck;
      if (!check.supported)
        return { problem: 'Очистка доступна только на Debian и Ubuntu. Карточка не создана.' };
      const used = check.disk.usedPct;
      if (used === null)
        return { problem: 'Занятость диска неизвестна: сначала «check». Карточка не создана.' };
      if (used < DISK_CLEANUP_OFFER_PCT)
        return {
          problem: `Диск занят на ${used} %, чистить нечего: панель предлагает очистку от ${DISK_CLEANUP_OFFER_PCT} %. Карточка не создана.`,
        };
      rows = [
        {
          label: 'Диск',
          before: `Занято ${used}\u00A0%`,
          after: 'Уберём ненужные пакеты, старые ядра, кеш apt, журнал сожмём до 200 МБ',
        },
      ];
      consequence =
        'Данные и настройки не трогаем. Старые ядра удаляются, поэтому очистку кнопкой не отменить.';
    } else {
      if (!check) return needCheck;
      if (!check.supported)
        return { problem: 'Автообновления настраиваются только на Debian и Ubuntu. Карточка не создана.' };
      if (check.unattended === true) return NO_CHANGE('Автообновления безопасности уже включены.');
      if (check.unattended === null)
        return { problem: 'Состояние автообновлений неизвестно: сначала «check». Карточка не создана.' };
      rows = [{ label: 'Автообновления безопасности', before: 'Выключены', after: 'Включены' }];
      consequence =
        'Ночью система сама ставит только обновления безопасности, без перезагрузки. Остальные пакеты по-прежнему через панель.';
    }
    const p = s.server.profile;
    if (kind !== 'check' && p.importance === 'critical')
      consequence += ` Сервер критичный${p.maintenanceWindow ? `, окно обслуживания: ${p.maintenanceWindow}` : ''}: запускайте в удобное время.`;
    return {
      args: { serverId: s.server.id, kind },
      plan: {
        title: MAINT_TITLES[kind],
        level: MAINTENANCE_TIERS[kind],
        target: serverTarget(s.server),
        rows,
        consequence,
        reversible: false,
        before: { active: false },
        after: { started: true },
      },
    };
  },
  async read(args, ctx) {
    return { active: Boolean((await ctx.maintenance.state(String(args.serverId))).running) };
  },
  async apply(args, _plan, ctx) {
    const run = await ctx.maintenance.start(String(args.serverId), args.kind as MaintenanceKind);
    return { runId: run.id };
  },
  async verify(args, plan, ctx) {
    const runId = (plan.outcome as { runId?: string } | undefined)?.runId;
    if (!runId) return false;
    return (await ctx.maintenance.runs(String(args.serverId), 20)).items.some((r) => r.id === runId);
  },
  async progress(args, plan, ctx) {
    const runId = (plan.outcome as { runId?: string } | undefined)?.runId;
    if (!runId) return null;
    const run = (await ctx.maintenance.runs(String(args.serverId), 20)).items.find((r) => r.id === runId);
    if (!run) return null;
    const title =
      MAINT_TITLES[args.kind as (typeof MAINT_KINDS)[number]] ?? MAINTENANCE_KIND_LABELS[run.kind];
    if (run.status === 'running') {
      const step = run.steps.find((x) => x.status === 'running')?.label;
      return { note: `Запущено: ${title}. Идёт${step ? `: ${step}` : ''}.`, live: true };
    }
    const sec = run.finishedAt
      ? Math.max(1, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000))
      : null;
    return run.status === 'ok'
      ? {
          note: `${title}: готово${sec ? ` за ${sec} с` : ''}. Подробности: вкладка «Обслуживание» сервера.`,
          live: false,
        }
      : {
          note: `${title}: ошибка${run.error ? `: ${run.error}` : ''}. Подробности: вкладка «Обслуживание» сервера.`,
          live: false,
        };
  },
};

export const CHANGE_OPS: Readonly<Record<ChangeOperation, ChangeOp>> = {
  'server.provider': provider,
  'server.tags': tags,
  'server.notes': notes,
  'server.rename': rename,
  'server.nodeWatch': nodeWatch,
  'server.profile': profile,
  'incident.resolve': incidentResolve,
  'autofix.pause': autofixPause,
  'autofix.policy': autofixPolicy,
  'maintenance.run': maintenanceRun,
};
