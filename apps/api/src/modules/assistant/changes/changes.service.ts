import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  type AssistantChange,
  type AssistantChangesSummary,
  CHANGE_OPERATION_TITLES,
  CHANGE_STATUS_LABELS,
  CHANGE_TTL_HOURS,
  type ChangeOperation,
  type ChangeStatus,
} from '@nodeservice/shared';
import { ClsService } from 'nestjs-cls';

import { problem } from '../../../common/filters/problem-details.filter.js';
import type { AssistantChangeRow } from '../../../infra/db/schema/index.js';
import { AuditService } from '../../audit/audit.service.js';
import { CLS_USER } from '../../auth/cls-keys.js';
import { IncidentsService } from '../../incidents/incidents.service.js';
import { ProvidersService } from '../../providers/providers.service.js';
import { ServersService } from '../../servers/servers.service.js';
import { CHANGE_OPS, type ChangeCtx, type ChangePlan, type Json, same } from './change-ops.js';
import { ChangesRepository } from './changes.repository.js';

export type ProposeOutcome = { change: AssistantChange; reused: boolean } | { problem: string };

/** Человеческий текст ошибки: у HttpException берём detail, у остальных — общая фраза (подробности в лог). */
function errorText(err: unknown): string {
  if (err instanceof HttpException) {
    const r = err.getResponse();
    if (typeof r === 'string') return r;
    const o = r as { detail?: unknown; title?: unknown };
    if (typeof o.detail === 'string' && o.detail) return o.detail;
    if (typeof o.title === 'string' && o.title) return o.title;
  }
  if (err instanceof Error && err.message.startsWith('Сервера больше нет')) return err.message;
  return 'Не удалось применить изменение: внутренняя ошибка панели.';
}

const rowsText = (rows: ChangePlan['rows'], side: 'before' | 'after'): string =>
  rows.map((r) => `${r.label}: ${r[side]}`).join('; ');

@Injectable()
export class ChangesService {
  private readonly log = new Logger(ChangesService.name);
  /** Изменения, которые применяются или откатываются прямо сейчас: двойной клик не должен применить дважды. */
  private readonly busy = new Set<string>();

  constructor(
    private readonly repo: ChangesRepository,
    private readonly servers: ServersService,
    private readonly providers: ProvidersService,
    private readonly incidents: IncidentsService,
    private readonly audit: AuditService,
    private readonly cls: ClsService,
  ) {}

  private ctx(): ChangeCtx {
    return { servers: this.servers, providers: this.providers, incidents: this.incidents };
  }

  private actor(): string {
    const user = this.cls.isActive()
      ? this.cls.get<{ id: string; login: string } | undefined>(CLS_USER)
      : undefined;
    return user?.login ?? '—';
  }

  private planOf(row: AssistantChangeRow): ChangePlan {
    return row.plan as unknown as ChangePlan;
  }

  toDto(row: AssistantChangeRow): AssistantChange {
    const plan = this.planOf(row);
    const op = row.operation as ChangeOperation;
    return {
      id: row.id,
      operation: op,
      title: plan.title || CHANGE_OPERATION_TITLES[op],
      level: CHANGE_OPS[op].level,
      target: plan.target,
      reason: row.reason,
      rows: plan.rows,
      consequence: plan.consequence,
      reversible: plan.reversible,
      status: row.status as ChangeStatus,
      note: row.note,
      conversationId: row.conversationId,
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      decidedBy: row.decidedBy,
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  /** Строка изменения; ожидавшее решения и просроченное помечается «Устарело». */
  private async load(id: string): Promise<AssistantChangeRow> {
    const row = await this.repo.find(id);
    if (!row) throw problem(HttpStatus.NOT_FOUND, { detail: 'Изменение не найдено.' });
    if (row.status === 'proposed' && row.expiresAt.getTime() < Date.now()) {
      const updated = await this.repo.update(id, {
        status: 'expired',
        note: `Предложение не применили за ${CHANGE_TTL_HOURS} ч: состояние могло измениться. Попросите Джарвиса предложить заново.`,
      });
      return updated ?? row;
    }
    return row;
  }

  async get(id: string): Promise<AssistantChange> {
    return this.toDto(await this.load(id));
  }

  /** Джарвис предлагает изменение: проверяем допустимость, считаем превью по живому состоянию, сохраняем. Ничего не меняем. */
  async propose(input: {
    operation: string;
    args: unknown;
    reason: string | null;
    conversationId: string | null;
  }): Promise<ProposeOutcome> {
    const known = Object.keys(CHANGE_OPS);
    if (!known.includes(input.operation))
      return {
        problem: `Операции «${input.operation}» нет. Доступные: ${known.join(', ')}. Карточка не создана.`,
      };
    const op = CHANGE_OPS[input.operation as ChangeOperation];
    const parsed = op.schema.safeParse(input.args ?? {});
    if (!parsed.success)
      return {
        problem: `Аргументы не подходят: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ')}. Карточка не создана.`,
      };
    const built = await op.build(parsed.data, this.ctx());
    if ('problem' in built) return built;

    if (input.conversationId) {
      const dup = (await this.repo.findPending(input.conversationId, input.operation)).find(
        (r) => same(r.args, built.args) && r.expiresAt.getTime() > Date.now(),
      );
      if (dup) return { change: this.toDto(dup), reused: true };
    }
    const row = await this.repo.insert({
      conversationId: input.conversationId,
      operation: input.operation,
      args: built.args,
      reason: input.reason?.trim() ? input.reason.trim().slice(0, 300) : null,
      plan: { ...built.plan, raw: parsed.data } as unknown as Record<string, unknown>,
      status: 'proposed',
      expiresAt: new Date(Date.now() + CHANGE_TTL_HOURS * 3_600_000),
    });
    return { change: this.toDto(row), reused: false };
  }

  private async finish(
    row: AssistantChangeRow,
    status: ChangeStatus,
    note: string | null,
    opts: { audit?: 'applied' | 'reverted' | 'rejected' | 'failed'; decided?: boolean } = {},
  ): Promise<AssistantChange> {
    const plan = this.planOf(row);
    const updated =
      (await this.repo.update(row.id, {
        status,
        note,
        ...(opts.decided === false ? {} : { decidedAt: new Date(), decidedBy: this.actor() }),
      })) ?? row;
    if (opts.audit)
      await this.audit.record({
        action: `assistant.change.${opts.audit}`,
        result: opts.audit === 'failed' ? 'failed' : 'ok',
        severity: opts.audit === 'failed' ? 'warn' : 'info',
        target: { type: plan.target.type, id: plan.target.id ?? row.id, display: plan.target.label },
        metadata: {
          changeId: row.id,
          operation: row.operation,
          title: plan.title,
          reason: row.reason,
          rows: plan.rows.map((r) => ({ label: r.label, before: r.before, after: r.after })),
          ...(note ? { note } : {}),
        },
      });
    return this.toDto(updated);
  }

  /** Применить изменение по нажатию человека: свежая проверка состояния, применение, проверка результата. */
  async apply(id: string): Promise<AssistantChange> {
    if (this.busy.has(id))
      throw problem(HttpStatus.CONFLICT, {
        detail: 'Изменение уже применяется, подождите несколько секунд.',
      });
    this.busy.add(id);
    try {
      const row = await this.load(id);
      if (row.status === 'applied') return this.toDto(row);
      if (row.status === 'expired') return this.toDto(row);
      if (row.status !== 'proposed')
        throw problem(HttpStatus.CONFLICT, {
          detail: `Это предложение уже в состоянии «${CHANGE_STATUS_LABELS[row.status as ChangeStatus].toLowerCase()}»: применить его нельзя.`,
        });
      const op = CHANGE_OPS[row.operation as ChangeOperation];
      const plan = this.planOf(row);
      const args = row.args as Record<string, Json>;
      const ctx = this.ctx();

      // Перед применением состояние должно быть таким, каким его видели при предложении.
      let current: Json;
      try {
        current = await op.read(args, ctx);
      } catch (err) {
        return this.finish(row, 'stale', errorText(err), { audit: 'failed' });
      }
      if (!same(current, plan.before)) {
        const fresh = plan.raw ? await op.build(plan.raw, ctx).catch(() => null) : null;
        const now = !fresh
          ? ''
          : 'plan' in fresh
            ? ` Сейчас: ${rowsText(fresh.plan.rows, 'before')}.`
            : ` ${fresh.problem.replace(/\s*(Менять нечего, )?[Кк]арточка не создана\.?$/, '')}`;
        return this.finish(
          row,
          'stale',
          `Состояние изменилось после предложения, ничего не применено.${now} Попросите Джарвиса предложить заново.`,
          { audit: 'failed' },
        );
      }

      try {
        await op.apply(args, plan, ctx);
      } catch (err) {
        this.log.warn(
          `Изменение ${id} (${row.operation}) не применено: ${err instanceof HttpException ? errorText(err) : err instanceof Error ? err.message : String(err)}`,
        );
        return this.finish(row, 'failed', errorText(err), { audit: 'failed' });
      }

      let after: Json;
      try {
        after = await op.read(args, ctx);
      } catch {
        after = null;
      }
      if (!same(after, plan.after))
        return this.finish(
          row,
          'failed',
          'Изменение выполнено, но проверка не подтвердила результат. Проверьте значение вручную.',
          { audit: 'failed' },
        );
      return this.finish(row, 'applied', `Проверено: ${rowsText(plan.rows, 'after')}.`, { audit: 'applied' });
    } finally {
      this.busy.delete(id);
    }
  }

  async reject(id: string): Promise<AssistantChange> {
    if (this.busy.has(id))
      throw problem(HttpStatus.CONFLICT, {
        detail: 'Изменение сейчас применяется: отклонить его уже нельзя.',
      });
    const row = await this.load(id);
    if (row.status === 'rejected') return this.toDto(row);
    if (row.status !== 'proposed')
      throw problem(HttpStatus.CONFLICT, {
        detail: `Предложение уже в состоянии «${CHANGE_STATUS_LABELS[row.status as ChangeStatus].toLowerCase()}»: отклонить его нельзя.`,
      });
    return this.finish(row, 'rejected', null, { audit: 'rejected' });
  }

  /** Вернуть прежнее значение, если оно всё ещё то, что мы поставили. */
  async revert(id: string): Promise<AssistantChange> {
    if (this.busy.has(id))
      throw problem(HttpStatus.CONFLICT, {
        detail: 'С этим изменением уже работают, подождите несколько секунд.',
      });
    this.busy.add(id);
    try {
      const row = await this.load(id);
      if (row.status === 'reverted') return this.toDto(row);
      const plan = this.planOf(row);
      const op = CHANGE_OPS[row.operation as ChangeOperation];
      if (row.status !== 'applied' || !plan.reversible || !op.revert)
        throw problem(HttpStatus.CONFLICT, {
          detail: plan.reversible
            ? 'Отменить можно только применённое изменение.'
            : 'Это изменение кнопкой не отменяется.',
        });
      const args = row.args as Record<string, Json>;
      const ctx = this.ctx();
      let current: Json;
      try {
        current = await op.read(args, ctx);
      } catch (err) {
        throw problem(HttpStatus.CONFLICT, { detail: errorText(err) });
      }
      if (!same(current, plan.after))
        throw problem(HttpStatus.CONFLICT, {
          detail:
            'После применения значение уже менялось: откатывать нечего, чтобы не затереть чужую правку.',
        });
      try {
        await op.revert(args, plan, ctx);
      } catch (err) {
        throw problem(HttpStatus.CONFLICT, { detail: errorText(err) });
      }
      const back = await op.read(args, ctx).catch(() => null);
      if (!same(back, plan.before))
        throw problem(HttpStatus.CONFLICT, {
          detail: 'Откат выполнен, но проверка не подтвердила прежнее значение. Проверьте вручную.',
        });
      return this.finish(row, 'reverted', `Возвращено прежнее значение: ${rowsText(plan.rows, 'before')}.`, {
        audit: 'reverted',
      });
    } finally {
      this.busy.delete(id);
    }
  }

  async summary(days: number): Promise<AssistantChangesSummary> {
    const counts = await this.repo.countsSince(new Date(Date.now() - days * 86_400_000));
    const n = (s: string): number => counts.find((c) => c.status === s)?.n ?? 0;
    return {
      days,
      applied: n('applied'),
      reverted: n('reverted'),
      rejected: n('rejected'),
      pending: n('proposed'),
    };
  }
}
