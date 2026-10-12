import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { type BsRental, type BsRentalTarget, bsRentalSchema, bsRentalsSchema } from '@nodeservice/shared';
import { eq } from 'drizzle-orm';
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
const validId = (id: string) => {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new BadRequestException('Некорректная точка аренды.');
  return encodeURIComponent(id);
};
@Injectable()
export class BsRentalsService {
  private active = new Map<string, Promise<NonNullable<Change['result']>>>();
  constructor(
    @Inject(DB) private db: Db,
    private bs: BsCheckerService,
    private integrations: IntegrationsService,
  ) {}
  private async save(id: string, change: Change) {
    const value = JSON.stringify(change);
    await this.db
      .insert(appMeta)
      .values({ key: 'bschecker.rental-change.' + id, value })
      .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: new Date() } });
  }
  private async load(id: string): Promise<Change> {
    const row = await this.db.query.appMeta.findFirst({
      where: eq(appMeta.key, 'bschecker.rental-change.' + id),
    });
    if (!row) throw new BadRequestException('Сначала подготовьте изменение.');
    return JSON.parse(row.value);
  }
  async list() {
    return bsRentalsSchema.parse(await this.bs.rentalRequest('/rentals'));
  }
  async get(id: string): Promise<BsRental> {
    return bsRentalSchema.parse(await this.bs.rentalRequest('/rentals/' + validId(id)));
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
        '/rentals/' + validId(change.rentalId) + '/targets',
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
      change.result = {
        status: 'uncertain',
        changed: null,
        version: null,
        warnings: [
          'Ответ не получен. Повтор использует тот же ключ изменения; состояние применения показано в карточке точки.',
        ],
      };
      if (e instanceof BadRequestException) {
        change.started = false;
        await this.save(id, change);
        throw e;
      }
    }
    await this.save(id, change);
    return change.result;
  }
  async checkResult(id: string, checkId: string) {
    const response = await this.bs.rentalRequest('/rentals/' + validId(id) + '/check/' + validId(checkId));
    return response.check ?? response;
  }
  async check(id: string) {
    const response = await this.bs.rentalRequest('/rentals/' + validId(id) + '/check?wait=25', {});
    return response.check ?? response;
  }
}
