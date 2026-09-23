import { HttpStatus, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  type CreateProviderRequest,
  createProviderRequestSchema,
  PROVIDER_PROBLEM,
  type Provider,
  type ProviderIconPreviewResponse,
  providerSiteHost,
  type UpdateProviderRequest,
  updateProviderRequestSchema,
} from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';
import { diffChanges } from '../audit/audit.diff.js';
import { AuditService } from '../audit/audit.service.js';
import { type FetchedIcon, IconFetchService } from './icon-fetch.service.js';
import { ProvidersRepository, type ProviderWithCount } from './providers.repository.js';

const providerProblems = {
  notFound: () =>
    problem(HttpStatus.NOT_FOUND, {
      type: PROVIDER_PROBLEM.notFound,
      detail: 'Провайдер не найден — возможно, уже удалён.',
    }),
  nameTaken: (name: string) =>
    problem(HttpStatus.CONFLICT, {
      type: PROVIDER_PROBLEM.nameTaken,
      detail: `Провайдер «${name}» уже есть в справочнике.`,
      errors: [{ path: 'name', message: 'Название уже занято' }],
    }),
};

/**
 * Справочник провайдеров: CRUD, Журнал на каждое изменение. Иконка ищется в фоне — сохранение
 * не ждёт чужой сайт (у сайтов за защитой это секунды): в ответе `iconPending: true`, клиент
 * перечитывает список, пока флаг не снимется. Незавершённые поиски дожимаются при старте API.
 */
@Injectable()
export class ProvidersService implements OnModuleInit {
  private readonly log = new Logger(ProvidersService.name);
  private readonly inflight = new Set<string>();

  constructor(
    private readonly repo: ProvidersRepository,
    private readonly icons: IconFetchService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      for (const row of await this.repo.listIconPending()) this.startIconJob(row.id);
    } catch (err) {
      this.log.warn(`не удалось возобновить поиск иконок: ${(err as Error).message}`);
    }
  }

  toDto(row: ProviderWithCount): Provider {
    return {
      id: row.id,
      name: row.name,
      siteUrl: row.siteUrl,
      siteHost: providerSiteHost(row.siteUrl),
      hasIcon: Boolean(row.iconData),
      iconUrl: row.iconUrl,
      iconSourceUrl: row.iconData ? row.iconSourceUrl : null,
      iconPending: row.iconPending,
      iconVersion: row.iconVersion,
      note: row.note,
      serversCount: row.serversCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async list(): Promise<Provider[]> {
    return (await this.repo.list()).map((r) => this.toDto(r));
  }

  async get(id: string): Promise<Provider> {
    const row = await this.repo.findById(id);
    if (!row) throw providerProblems.notFound();
    return this.toDto(row);
  }

  async create(input: CreateProviderRequest): Promise<Provider> {
    const req = createProviderRequestSchema.parse(input);
    if (await this.repo.findByName(req.name)) throw providerProblems.nameTaken(req.name);
    const row = await this.repo.insert({
      name: req.name,
      siteUrl: req.siteUrl,
      note: req.note?.trim() || null,
      iconUrl: req.iconUrl ?? null,
      iconPending: true,
    });
    await this.audit.record({
      action: 'provider.created',
      target: { type: 'provider', id: row.id, display: row.name },
      metadata: { siteUrl: req.siteUrl, ...(req.iconUrl ? { iconUrl: req.iconUrl } : {}) },
    });
    this.startIconJob(row.id);
    return this.get(row.id);
  }

  async update(id: string, input: UpdateProviderRequest): Promise<Provider> {
    const patch = updateProviderRequestSchema.parse(input);
    const row = await this.repo.findById(id);
    if (!row) throw providerProblems.notFound();
    if (
      patch.name &&
      patch.name.toLowerCase() !== row.name.toLowerCase() &&
      (await this.repo.findByName(patch.name))
    )
      throw providerProblems.nameTaken(patch.name);
    const before = { name: row.name, siteUrl: row.siteUrl, note: row.note, iconUrl: row.iconUrl };
    const siteChanged = patch.siteUrl !== undefined && patch.siteUrl !== row.siteUrl;
    const iconChanged = patch.iconUrl !== undefined && patch.iconUrl !== row.iconUrl;
    await this.repo.update(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.siteUrl !== undefined ? { siteUrl: patch.siteUrl } : {}),
      ...(patch.note !== undefined ? { note: patch.note?.trim() || null } : {}),
      ...(patch.iconUrl !== undefined ? { iconUrl: patch.iconUrl } : {}),
      ...(siteChanged || iconChanged ? { iconPending: true } : {}),
    });
    if (siteChanged || iconChanged) this.startIconJob(id);
    const after = {
      name: patch.name ?? row.name,
      siteUrl: patch.siteUrl ?? row.siteUrl,
      note: patch.note === undefined ? row.note : patch.note?.trim() || null,
      iconUrl: patch.iconUrl === undefined ? row.iconUrl : patch.iconUrl,
    };
    await this.audit.record({
      action: 'provider.updated',
      target: { type: 'provider', id, display: after.name },
      changes: diffChanges(before, after),
    });
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    const row = await this.repo.findById(id);
    if (!row) throw providerProblems.notFound();
    await this.repo.delete(id);
    await this.audit.record({
      action: 'provider.deleted',
      target: { type: 'provider', id, display: row.name },
      metadata: { serversDetached: row.serversCount },
    });
  }

  /**
   * Заново взять иконку по кнопке: по ручной ссылке, если она задана, иначе поиском на сайте.
   * Здесь ждём результат — пользователь нажал и хочет ответ. Не нашли — иконка сбрасывается.
   */
  async refreshIcon(id: string): Promise<Provider> {
    if (!(await this.repo.findById(id))) throw providerProblems.notFound();
    await this.fetchAndStore(id);
    return this.get(id);
  }

  /** Фоновый поиск: один на провайдера одновременно, ошибки только в лог, флаг снимается всегда. */
  private startIconJob(id: string): void {
    if (this.inflight.has(id)) return;
    this.inflight.add(id);
    void this.fetchAndStore(id)
      .catch((err) => this.log.warn(`иконка провайдера ${id}: ${(err as Error).message}`))
      .finally(() => this.inflight.delete(id));
  }

  private async fetchAndStore(id: string): Promise<void> {
    const row = await this.repo.findById(id);
    if (!row) return;
    let icon: FetchedIcon | null = null;
    try {
      ({ icon } = row.iconUrl
        ? await this.icons.fetchDirect(row.iconUrl)
        : await this.icons.fetch(row.siteUrl));
    } finally {
      await this.repo.setIcon(
        id,
        icon ? { type: icon.type, data: icon.data.toString('base64'), sourceUrl: icon.sourceUrl } : null,
      );
    }
  }

  async icon(id: string): Promise<{ type: string; data: Buffer; version: number } | null> {
    const row = await this.repo.findById(id);
    if (!row) throw providerProblems.notFound();
    if (!row.iconData || !row.iconType) return null;
    return { type: row.iconType, data: Buffer.from(row.iconData, 'base64'), version: row.iconVersion };
  }

  async preview(siteUrl: string, iconUrl?: string | null): Promise<ProviderIconPreviewResponse> {
    const { icon, reason } = iconUrl
      ? await this.icons.fetchDirect(iconUrl)
      : await this.icons.fetch(siteUrl);
    return {
      iconDataUrl: icon ? `data:${icon.type};base64,${icon.data.toString('base64')}` : null,
      sourceUrl: icon?.sourceUrl ?? null,
      reason: icon ? null : reason,
    };
  }

  async serversOf(id: string): Promise<Array<{ id: string; name: string }>> {
    return this.repo.serversOf(id);
  }
}
