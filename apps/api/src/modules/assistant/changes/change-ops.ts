import {
  type ActionLevel,
  type AssistantChange,
  type ChangeOperation,
  type ChangeRow,
  type Incident,
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
import type { ProvidersService } from '../../providers/providers.service.js';
import type { ServersService } from '../../servers/servers.service.js';

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Всё, что нужно операциям: существующие сервисы панели (изменения идут теми же путями, что и ручные). */
export interface ChangeCtx {
  servers: Pick<ServersService, 'list' | 'update'>;
  providers: Pick<ProvidersService, 'list'>;
  incidents: Pick<IncidentsService, 'get' | 'resolveManual' | 'policy' | 'updatePolicy'>;
}

/** То, что показывается человеку и что хранится вместе с изменением. */
export interface ChangePlan {
  title: string;
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
  apply(args: Record<string, Json>, plan: ChangePlan, ctx: ChangeCtx): Promise<void>;
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

export const CHANGE_OPS: Readonly<Record<ChangeOperation, ChangeOp>> = {
  'server.provider': provider,
  'server.tags': tags,
  'server.notes': notes,
  'server.rename': rename,
  'server.nodeWatch': nodeWatch,
  'server.profile': profile,
  'incident.resolve': incidentResolve,
  'autofix.pause': autofixPause,
};
