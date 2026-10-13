import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import {
  type BsRental,
  type BsRentalTarget,
  type BsWs,
  type BsWsExitInput,
  bsRentalSchema,
  bsWsConnectSchema,
  bsWsSchema,
} from '@nodeservice/shared';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { problem } from '../../common/filters/problem-details.filter.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';
import { BsCheckerService } from './bschecker.service.js';
import { IntegrationsService } from './integrations.service.js';

type Change = {
  identity: string;
  rentalId: string;
  before: BsRentalTarget[];
  after: BsRentalTarget[];
  expiresAt: string;
  started: boolean;
  result?: {
    status: 'submitted' | 'uncertain';
    changed: boolean | null;
    version: number | null;
    warnings: string[];
  };
};
type WsChange = {
  identity: string;
  wsId: string;
  before: BsWsExitInput[];
  after: BsWsExitInput[];
  balancing?: 'weighted' | 'sticky' | undefined;
  health_check?: 'fast' | 'standard' | 'tolerant' | undefined;
  expiresAt: string;
  started: boolean;
  result?: { status: 'submitted' | 'uncertain'; applied: boolean | null; warnings: string[] } | undefined;
};
const validId = (id: string) => {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new BadRequestException('Некорректная точка аренды.');
  return encodeURIComponent(id);
};
@Injectable()
export class BsRentalsService {
  private readonly log = new Logger(BsRentalsService.name);
  private active = new Map<string, Promise<NonNullable<Change['result']>>>();
  constructor(
    @Inject(DB) private db: Db,
    private bs: BsCheckerService,
    private integrations: IntegrationsService,
  ) {}
  /**
   * Ответ BS Checker — не ввод владельца: незнакомый вид даёт 502 «формат изменился», а не «проверьте поля»
   * с английским текстом разбора. В журнал сервера — только пути полей: в ответах бывают секреты.
   */
  private read<T>(schema: z.ZodType<T>, data: unknown, detail: string): T {
    const parsed = schema.safeParse(data);
    if (parsed.success) return parsed.data;
    this.log.warn(
      `${detail} Поля: ${parsed.error.issues.map((i) => i.path.join('.') || 'ответ').join(', ')}`,
    );
    throw problem(502, { type: 'urn:nodeservice:bschecker:format', detail });
  }
  private async save(id: string, change: Change) {
    const value = JSON.stringify(change);
    await this.db
      .insert(appMeta)
      .values({ key: `bschecker.rental-change.${id}`, value })
      .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: new Date() } });
  }
  private async load(id: string): Promise<Change> {
    const row = await this.db.query.appMeta.findFirst({
      where: eq(appMeta.key, `bschecker.rental-change.${id}`),
    });
    if (!row) throw new BadRequestException('Сначала подготовьте изменение.');
    return JSON.parse(row.value);
  }
  /**
   * Точки аренды по одной: незнакомое поле у одной точки не прячет остальные (раньше одна «странная» точка —
   * и список пуст). Непрочитанные считаются, чтобы честно сказать «не прочитано N».
   */
  async list() {
    const raw = await this.bs.rentalRequest('/rentals');
    const items = Array.isArray(raw.rentals) ? raw.rentals : [];
    const parsed = items.map((r) => bsRentalSchema.safeParse(r));
    return {
      rentals: parsed.flatMap((p) => (p.success ? [p.data] : [])),
      unreadable: parsed.filter((p) => !p.success).length,
    };
  }
  async get(id: string): Promise<BsRental> {
    return this.read(
      bsRentalSchema,
      await this.bs.rentalRequest(`/rentals/${validId(id)}`),
      'Формат точки аренды BS Checker изменился — панель не смогла её прочитать.',
    );
  }
  async prepare(id: string, targets: BsRentalTarget[]) {
    const rental = await this.get(id),
      primary = targets.filter((t) => !t.backup),
      backup = targets.filter((t) => t.backup);
    if (
      primary.length < 1 ||
      primary.length > (rental.proto === 'tcp' ? 3 : 1) ||
      backup.length > (rental.proto === 'tcp' ? 2 : 1)
    )
      throw new BadRequestException(
        rental.proto === 'tcp'
          ? 'TCP: 1–3 основных и до 2 резервных адресов.'
          : 'UDP: 1 основной и до 1 резервного адреса.',
      );
    if (new Set(targets.map((t) => `${t.host}:${t.port}`)).size !== targets.length)
      throw new BadRequestException('Адреса не должны повторяться.');
    const changeId = randomUUID(),
      expiresAt = new Date(Date.now() + 10 * 60000).toISOString();
    await this.save(changeId, {
      identity: await this.integrations.identity('bschecker'),
      rentalId: id,
      before: rental.targets,
      after: targets,
      expiresAt,
      started: false,
    });
    return { id: changeId, rentalId: id, before: rental.targets, after: targets, expiresAt };
  }
  async execute(id: string) {
    const old = this.active.get(id);
    if (old) return old;
    const task = this.apply(id).finally(() => this.active.delete(id));
    this.active.set(id, task);
    return task;
  }
  private async apply(id: string): Promise<NonNullable<Change['result']>> {
    const change = await this.load(id);
    if (change.identity !== (await this.integrations.identity('bschecker')))
      throw new BadRequestException('Подключение изменилось. Подготовьте изменение заново.');
    if (change.result?.status === 'submitted') return change.result;
    if (!change.started) {
      if (Date.parse(change.expiresAt) < Date.now()) throw new BadRequestException('Подтверждение устарело.');
      const rental = await this.get(change.rentalId);
      if (JSON.stringify(rental.targets) !== JSON.stringify(change.before))
        throw new BadRequestException('Адреса уже изменились. Обновите точку перед сохранением.');
    }
    change.started = true;
    await this.save(id, change);
    try {
      const response = await this.bs.rentalRequest(
        `/rentals/${validId(change.rentalId)}/targets`,
        { targets: change.after },
        id,
        'PUT',
      );
      const apply =
        response.apply && typeof response.apply === 'object'
          ? (response.apply as Record<string, unknown>)
          : {};
      change.result = {
        status: 'submitted',
        changed: typeof response.changed === 'boolean' ? response.changed : null,
        version: typeof apply.version === 'number' ? apply.version : null,
        warnings: Array.isArray(response.warnings)
          ? response.warnings.filter((w): w is string => typeof w === 'string')
          : [],
      };
    } catch (e) {
      // Окончательный отказ (адрес в блок-листе, нет права, точка занята) приходит понятной ошибкой — ничего не
      // изменено, изменение снова можно править. Раньше он приходил общей ошибкой сервиса, записывался как
      // «результат неизвестен» и запирал редактор. Всё прочее (обрыв связи) — итог неизвестен.
      if (e instanceof BadRequestException) {
        change.started = false;
        delete change.result;
        await this.save(id, change);
        throw e;
      }
      change.result = {
        status: 'uncertain',
        changed: null,
        version: null,
        warnings: [
          'Ответ не получен. Повтор использует тот же ключ изменения; состояние применения показано в карточке точки.',
        ],
      };
    }
    await this.save(id, change);
    return change.result;
  }
  async checkResult(id: string, checkId: string) {
    const response = await this.bs.rentalRequest(`/rentals/${validId(id)}/check/${validId(checkId)}`);
    return response.check ?? response;
  }
  async check(id: string) {
    const response = await this.bs.rentalRequest(`/rentals/${validId(id)}/check?wait=25`, {});
    return response.check ?? response;
  }

  /** Точки входа WebSocket (/v1/ws, с 12.10.2026): в списке аренды их нет — у них свой раздел. */
  async wsList() {
    const raw = await this.bs.rentalRequest('/ws');
    const items = Array.isArray(raw.ws) ? raw.ws : [];
    const parsed = items.map((w) => bsWsSchema.safeParse(w));
    return {
      ws: parsed.flatMap((p) => (p.success ? [p.data] : [])),
      unreadable: parsed.filter((p) => !p.success).length,
    };
  }
  async wsGet(id: string): Promise<BsWs> {
    return this.read(
      bsWsSchema,
      await this.bs.rentalRequest(`/ws/${validId(id)}`),
      'Формат точки WebSocket BS Checker изменился — панель не смогла её прочитать.',
    );
  }
  /** Настройки подключения — секреты (путь точки работает как пароль). Нужно право ключа на изменение точек. */
  async wsConnect(id: string) {
    return this.read(
      bsWsConnectSchema,
      await this.bs.rentalRequest(`/ws/${validId(id)}/connect`),
      'Формат настроек подключения BS Checker изменился — панель не смогла их прочитать.',
    );
  }
  /** Подготовка смены серверов точки: что было и что станет — владелец подтверждает. */
  async wsPrepare(
    id: string,
    input: {
      exits: BsWsExitInput[];
      balancing?: 'weighted' | 'sticky' | undefined;
      health_check?: 'fast' | 'standard' | 'tolerant' | undefined;
    },
  ) {
    const ws = await this.wsGet(id);
    if (!input.exits.some((e) => e.enabled && !e.backup))
      throw new BadRequestException('Нужен хотя бы один включённый основной сервер.');
    if ((input.balancing ?? ws.balancing) === 'sticky' && input.exits.some((e) => e.backup))
      throw new BadRequestException(
        'При закреплении клиентов за сервером запасные не используются — уберите их или выберите распределение по весу.',
      );
    if (input.exits.some((e) => e.port === 22))
      throw new BadRequestException('Порт 22 нельзя указать сервером точки.');
    if (new Set(input.exits.map((e) => `${e.host}:${e.port}`)).size !== input.exits.length)
      throw new BadRequestException('Серверы не должны повторяться.');
    const before: BsWsExitInput[] = ws.exits.map((e) => ({
      host: e.host,
      port: e.port,
      weight: e.weight ?? 1,
      max_connections: e.max_connections ?? null,
      backup: e.backup,
      enabled: e.enabled,
    }));
    const changeId = randomUUID(),
      expiresAt = new Date(Date.now() + 10 * 60000).toISOString();
    await this.saveWs(changeId, {
      identity: await this.integrations.identity('bschecker'),
      wsId: id,
      before,
      after: input.exits,
      balancing: input.balancing,
      health_check: input.health_check,
      expiresAt,
      started: false,
    });
    return { id: changeId, wsId: id, before, after: input.exits, expiresAt };
  }
  async wsExecute(changeId: string) {
    const row = await this.db.query.appMeta.findFirst({
      where: eq(appMeta.key, `bschecker.ws-change.${changeId}`),
    });
    if (!row) throw new BadRequestException('Сначала подготовьте изменение.');
    const change: WsChange = JSON.parse(row.value);
    if (change.identity !== (await this.integrations.identity('bschecker')))
      throw new BadRequestException('Подключение изменилось. Подготовьте изменение заново.');
    if (change.result?.status === 'submitted') return change.result;
    if (!change.started && Date.parse(change.expiresAt) < Date.now())
      throw new BadRequestException('Подтверждение устарело.');
    change.started = true;
    await this.saveWs(changeId, change);
    try {
      const ws = bsWsSchema.safeParse(
        await this.bs.rentalRequest(
          `/ws/${validId(change.wsId)}/exits`,
          {
            exits: change.after,
            ...(change.balancing ? { balancing: change.balancing } : {}),
            ...(change.health_check ? { health_check: change.health_check } : {}),
          },
          changeId,
          'PUT',
        ),
      );
      change.result = {
        status: 'submitted',
        applied: ws.success ? (ws.data.applied ?? null) : null,
        warnings: ws.success && ws.data.issue ? [ws.data.issue] : [],
      };
    } catch (e) {
      if (e instanceof BadRequestException) {
        change.started = false;
        delete change.result;
        await this.saveWs(changeId, change);
        throw e;
      }
      change.result = {
        status: 'uncertain',
        applied: null,
        warnings: ['Ответ не получен. Повтор использует тот же ключ изменения — второго изменения не будет.'],
      };
    }
    await this.saveWs(changeId, change);
    return change.result;
  }
  private async saveWs(id: string, change: WsChange) {
    const value = JSON.stringify(change);
    await this.db
      .insert(appMeta)
      .values({ key: `bschecker.ws-change.${id}`, value })
      .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: new Date() } });
  }
}
