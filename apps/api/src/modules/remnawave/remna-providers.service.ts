import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { type RemnaProvider, type RemnaProviderUpdate, type RemnawaveStatus } from '@nodeservice/shared';
import { RemnaPermissionsService } from './remna-permissions.service.js';
import { RemnaProviderAssetsService } from './remna-provider-assets.service.js';
import { getJson, RemnawaveApiError } from './remnawave-client.js';
import { RemnawaveSettingsStore } from './remnawave-settings.store.js';

const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const text = (v: unknown) => (typeof v === 'string' ? v : '');
export function safeProviderUrl(v: unknown) {
  try {
    const url = new URL(text(v));
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
export function parseProviders(
  providersBody: Record<string, unknown>,
  billingBody: Record<string, unknown>,
): RemnaProvider[] {
  const payload = object(providersBody.response);
  const providers = Array.isArray(payload.providers)
    ? payload.providers
    : Array.isArray(providersBody.response)
      ? providersBody.response
      : null;
  const nodes = billingBody.response;
  if (!providers || !Array.isArray(nodes))
    throw new BadGatewayException('Remnawave вернула неверный формат провайдеров или нод.');
  return providers.map((raw) => {
    const p = object(raw);
    return {
      uuid: text(p.uuid),
      name: text(p.name),
      loginUrl: safeProviderUrl(p.loginUrl),
      faviconLink: safeProviderUrl(p.faviconLink),
      nodes: nodes
        .filter((raw) => {
          const node = object(raw);
          return text(node.providerUuid ?? object(node.provider).uuid) === p.uuid;
        })
        .map((raw) => {
          const node = object(raw);
          return {
            uuid: text(node.uuid),
            name: text(node.name),
            countryCode: text(node.countryCode) || null,
          };
        }),
    };
  });
}

@Injectable()
export class RemnaProvidersService {
  private cache: { domain: string; key: string; at: number; providers: RemnaProvider[] } | null = null;
  private revision = 0;
  private pending: { domain: string; key: string; promise: Promise<RemnaProvider[]> } | null = null;
  constructor(
    private readonly store: RemnawaveSettingsStore,
    private readonly assets: RemnaProviderAssetsService,
    @Optional() private readonly permissions?: RemnaPermissionsService,
  ) {}
  private async credentials() {
    const creds = await this.store.credentials();
    if (!creds) throw new ConflictException('Подключите Remnawave в разделе «Ноды».');
    return creds;
  }
  private fail(error: unknown): never {
    if (error instanceof RemnawaveApiError && error.kind === 'unauthorized')
      throw new ForbiddenException(
        'Ключу Remnawave нужны права infra-billing: list-providers, а также чтение нод; для действий — create-provider, update-provider и delete-provider.',
      );
    if (error instanceof ForbiddenException || error instanceof NotFoundException) throw error;
    throw new BadGatewayException('Не удалось получить ответ биллинга Remnawave. Повторите запрос.');
  }
  async list(force = false, snapshot?: { domain: string; apiKey: string }): Promise<RemnaProvider[]> {
    const creds = snapshot ?? (await this.credentials());
    if (
      !force &&
      this.cache?.domain === creds.domain &&
      this.cache.key === creds.apiKey &&
      Date.now() - this.cache.at < 14_000
    )
      return this.cache.providers;
    if (!force && this.pending?.domain === creds.domain && this.pending.key === creds.apiKey)
      return this.pending.promise;
    const revision = this.revision;
    const promise = (async () => {
      try {
        const [providers, billing] = await Promise.all([
          getJson(`https://${creds.domain}/api/infra-billing/providers`, creds.apiKey),
          getJson(`https://${creds.domain}/api/nodes`, creds.apiKey),
        ]);
        const result = parseProviders(providers, billing);
        if (this.revision === revision)
          this.cache = { domain: creds.domain, key: creds.apiKey, at: Date.now(), providers: result };
        return result;
      } catch (error) {
        return this.fail(error);
      }
    })();
    this.pending = { domain: creds.domain, key: creds.apiKey, promise };
    try {
      return await promise;
    } finally {
      if (this.pending?.promise === promise) this.pending = null;
    }
  }
  invalidate() {
    this.revision++;
    this.cache = null;
    this.pending = null;
  }
  private write(scope: string, url: string, key: string, options: { method: string; body: string }) {
    return this.permissions
      ? this.permissions.observe(scope, { domain: new URL(url).host, apiKey: key }, () =>
          getJson(url, key, options),
        )
      : getJson(url, key, options);
  }
  async create(
    body: { name: string; loginUrl: string; faviconLink: string },
    snapshot?: { domain: string; apiKey: string },
  ) {
    const creds = snapshot ?? (await this.credentials());
    try {
      const result = await this.write(
        'infra-billing:create-provider',
        `https://${creds.domain}/api/infra-billing/providers`,
        creds.apiKey,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      );
      this.invalidate();
      const p = object(result.response);
      if (!text(p.uuid))
        throw new BadGatewayException('Remnawave не вернула идентификатор созданного провайдера.');
      return {
        uuid: text(p.uuid),
        name: text(p.name),
        loginUrl: safeProviderUrl(p.loginUrl),
        faviconLink: safeProviderUrl(p.faviconLink),
        nodes: [],
      };
    } catch (error) {
      return this.fail(error);
    }
  }
  async remove(uuid: string) {
    const creds = await this.credentials();
    try {
      await this.write(
        'infra-billing:delete-provider',
        `https://${creds.domain}/api/infra-billing/providers/${uuid}`,
        creds.apiKey,
        {
          method: 'DELETE',
          body: '',
        },
      );
      this.invalidate();
    } catch (error) {
      return this.fail(error);
    }
  }
  async update(uuid: string, body: RemnaProviderUpdate) {
    const creds = await this.credentials();
    try {
      // This is the same provider UUID; only the two editable fields are sent.
      await this.write(
        'infra-billing:update-provider',
        `https://${creds.domain}/api/infra-billing/providers`,
        creds.apiKey,
        {
          method: 'PATCH',
          body: JSON.stringify({
            uuid,
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.loginUrl !== undefined ? { loginUrl: body.loginUrl, faviconLink: body.loginUrl } : {}),
          }),
        },
      );
      this.invalidate();
    } catch (error) {
      return this.fail(error);
    }
    return { saved: true };
  }
  async enrich(status: RemnawaveStatus): Promise<RemnawaveStatus> {
    if (!status.connected) return status;
    try {
      const providers = await this.list();
      const assetList = await Promise.all(providers.map((p) => this.assets.dto(p)));
      const assetById = new Map(assetList.map((p) => [p.id, p]));
      const byNode = new Map(providers.flatMap((p) => p.nodes.map((n) => [n.uuid, p] as const)));
      return {
        ...status,
        providerError: null,
        nodes: status.nodes.map((node) => {
          const p = byNode.get(node.uuid);
          return {
            ...node,
            providerUuid: p?.uuid ?? null,
            providerName: p?.name ?? node.providerName ?? null,
            providerUrl: p?.loginUrl ?? null,
            providerIcon:
              p && assetById.get(p.uuid)?.hasIcon
                ? `/api/nodes/providers/catalog/${p.uuid}/icon?v=${assetById.get(p.uuid)?.iconVersion}`
                : null,
          };
        }),
      };
    } catch (error) {
      return {
        ...status,
        providerError: error instanceof Error ? error.message : 'Биллинг Remnawave недоступен.',
      };
    }
  }
}
