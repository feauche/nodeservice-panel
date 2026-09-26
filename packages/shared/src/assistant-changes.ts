import { z } from 'zod';

import { ACTION_LEVELS } from './incidents.js';

/**
 * Изменения по предложению Джарвиса (J5). Джарвис не меняет ничего сам: он создаёт «изменение» с превью
 * «было → станет», а применяет его человек кнопкой. Перед применением панель заново читает состояние и
 * отказывает, если оно изменилось после предложения; после применения проверяет результат и по возможности
 * умеет откатить.
 */

export const CHANGE_OPERATIONS = [
  'server.provider',
  'server.tags',
  'server.notes',
  'server.rename',
  'server.nodeWatch',
  'server.profile',
  'incident.resolve',
  'autofix.pause',
  'autofix.policy',
  'maintenance.run',
] as const;
export const changeOperationSchema = z.enum(CHANGE_OPERATIONS);
export type ChangeOperation = z.infer<typeof changeOperationSchema>;

export const CHANGE_OPERATION_TITLES: Record<ChangeOperation, string> = {
  'server.provider': 'Сменить провайдера',
  'server.tags': 'Изменить теги',
  'server.notes': 'Изменить заметку',
  'server.rename': 'Переименовать сервер',
  'server.nodeWatch': 'Изменить слежение за нодой',
  'server.profile': 'Изменить профиль сервера',
  'incident.resolve': 'Закрыть инцидент',
  'autofix.pause': 'Автопочинка: пауза',
  'autofix.policy': 'Изменить режим автопочинки',
  'maintenance.run': 'Запустить обслуживание',
};

/** proposed — ждёт решения; expired — не применили за сутки, состояние могло уйти вперёд. */
export const CHANGE_STATUSES = [
  'proposed',
  'applied',
  'reverted',
  'rejected',
  'failed',
  'stale',
  'expired',
] as const;
export const changeStatusSchema = z.enum(CHANGE_STATUSES);
export type ChangeStatus = z.infer<typeof changeStatusSchema>;
export const CHANGE_STATUS_LABELS: Record<ChangeStatus, string> = {
  proposed: 'Ждёт вашего решения',
  applied: 'Применено',
  reverted: 'Отменено',
  rejected: 'Отклонено',
  failed: 'Не применено',
  stale: 'Состояние изменилось',
  expired: 'Устарело',
};

/** Сколько предложение живёт: по истечении применить его нельзя, состояние могло измениться. */
export const CHANGE_TTL_HOURS = 24;

export const CHANGE_TARGET_TYPES = ['server', 'incident', 'settings'] as const;

export const changeRowSchema = z.object({
  label: z.string(),
  /** Готовые к показу значения; «—» значит «пусто». */
  before: z.string(),
  after: z.string(),
  /** Для списков (теги, контейнеры, порты): что добавилось и что убрали. */
  added: z.array(z.string()).optional(),
  removed: z.array(z.string()).optional(),
});
export type ChangeRow = z.infer<typeof changeRowSchema>;

export const assistantChangeSchema = z.object({
  id: z.uuid(),
  operation: changeOperationSchema,
  title: z.string(),
  level: z.enum(ACTION_LEVELS),
  target: z.object({
    type: z.enum(CHANGE_TARGET_TYPES),
    id: z.string().nullable(),
    label: z.string(),
  }),
  /** Почему Джарвис это предлагает (его слова). */
  reason: z.string().nullable(),
  rows: z.array(changeRowSchema),
  /** Что важно знать до нажатия: последствия одной фразой. */
  consequence: z.string().nullable(),
  /** Можно ли после применения вернуть прежнее значение кнопкой. */
  reversible: z.boolean(),
  /** Работа после применения ещё идёт в фоне (обслуживание): в `note` свежий ход, карточку стоит перечитывать. */
  live: z.boolean().default(false),
  status: changeStatusSchema,
  /** Пояснение к состоянию: итог проверки, причина отказа, что сейчас на сервере. */
  note: z.string().nullable(),
  conversationId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  /** Когда применили, отклонили или отменили. */
  decidedAt: z.iso.datetime().nullable(),
  decidedBy: z.string().nullable(),
  expiresAt: z.iso.datetime(),
});
export type AssistantChange = z.infer<typeof assistantChangeSchema>;

/** Сводка для настроек: что сделано по предложениям Джарвиса. */
export const assistantChangesSummarySchema = z.object({
  days: z.number().int(),
  applied: z.number().int().min(0),
  reverted: z.number().int().min(0),
  rejected: z.number().int().min(0),
  pending: z.number().int().min(0),
});
export type AssistantChangesSummary = z.infer<typeof assistantChangesSummarySchema>;
