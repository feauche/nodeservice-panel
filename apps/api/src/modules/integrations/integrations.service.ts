import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { IntegrationConnection, IntegrationProvider, IntegrationStatus } from '@nodeservice/shared';
import { eq } from 'drizzle-orm';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import { problem } from '../../common/filters/problem-details.filter.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';

export type IntegrationSession = { identity: string; credentials: IntegrationConnection };
type Stored = { credentialsEnc: string; status: IntegrationStatus };
const empty = (provider: IntegrationProvider): IntegrationStatus => ({
  provider,
  connected: false,
  checkedAt: null,
  domains: [],
  balance: null,
});
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const array = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(object) : []);

@Injectable()
export class IntegrationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly crypto: CryptoService,
  ) {}
  private key(provider: IntegrationProvider) {
    return `settings.integration.${provider}`;
  }
  private async stored(provider: IntegrationProvider): Promise<Stored | null> {
    const [row] = await this.db
      .select()
      .from(appMeta)
      .where(eq(appMeta.key, this.key(provider)))
      .limit(1);
    return row ? (JSON.parse(row.value) as Stored) : null;
  }
  async identity(provider: IntegrationProvider) {
    return (await this.session(provider)).identity;
  }
  async session(provider: IntegrationProvider): Promise<IntegrationSession> {
    const c = await this.credentials(provider);
    return { credentials: c, identity: createHash('sha256').update(JSON.stringify(c)).digest('hex') };
  }
  async credentials(provider: IntegrationProvider): Promise<IntegrationConnection> {
    const saved = await this.stored(provider);
    if (!saved) throw new BadRequestException('Сначала подключите сервис.');
    return JSON.parse(this.crypto.decrypt(saved.credentialsEnc));
  }
  async providerRequest(
    provider: IntegrationProvider,
    path: string,
    method = 'GET',
    body?: unknown,
    idempotency?: string,
    session?: IntegrationSession,
  ) {
    if (session && method !== 'GET' && (await this.identity(provider)) !== session.identity)
      throw new BadRequestException('Подключение изменилось. Повторите действие из обновлённой страницы.');
    const credentials = session?.credentials ?? (await this.credentials(provider));
    const base = provider === 'bschecker' ? 'https://bsbord.com/v1' : provider === 'dpi' ? 'https://dpichecker.st/api/v1' : 'https://api.cloudflare.com/client/v4';
    return this.json(base + path, {
      method,
      headers: {
        ...(provider === 'dpi'
          ? { 'X-API-Key': credentials.apiKey ?? '' }
          : { Authorization: `Bearer ${credentials.apiKey}` }),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(idempotency ? { 'Idempotency-Key': idempotency } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async reg(method: string, params: Record<string, unknown>, session?: IntegrationSession) {
    if (session && (await this.identity('regru')) !== session.identity)
      throw new BadRequestException('Подключение REG.RU изменилось. Проверьте записи.');
    const c = session?.credentials ?? (await this.credentials('regru'));
    const data = await this.json('https://api.reg.ru/api/regru2/' + method, {
      method: 'POST',
      body: new URLSearchParams({
        username: c.username ?? '',
        password: c.password ?? '',
        input_format: 'json',
        output_format: 'json',
        io_encoding: 'utf8',
        input_data: JSON.stringify(params),
      }),
    });
    if (data.result !== 'success')
      throw problem(502, {
        type: 'urn:nodeservice:integration:regru',
        detail: 'REG.RU отклонил операцию. Проверьте доступ к домену и права API.',
      });
    const answer = object(data.answer);
    if (
      Array.isArray(answer.domains) &&
      answer.domains.some((d: unknown) => {
        const row = object(d);
        return row.result === 'error' || row.error_code || row.error_text;
      })
    )
      throw problem(502, {
        type: 'urn:nodeservice:integration:regru-domain',
        detail: 'REG.RU отклонил операцию для домена. Запись не подтверждена; проверьте домен и права API.',
      });
    return answer;
  }
  async status(provider: IntegrationProvider): Promise<IntegrationStatus> {
    return (await this.stored(provider))?.status ?? empty(provider);
  }
  async list() {
    return { items: await Promise.all((['dpi', 'regru', 'cloudflare', 'bschecker'] as const).map((p) => this.status(p))) };
  }
  async disconnect(provider: IntegrationProvider) {
    await this.db.delete(appMeta).where(eq(appMeta.key, this.key(provider)));
  }
  async refresh(provider: IntegrationProvider) {
    const saved = await this.stored(provider);
    if (!saved) throw new BadRequestException('Сначала подключите сервис.');
    return this.connect(
      provider,
      JSON.parse(this.crypto.decrypt(saved.credentialsEnc)) as IntegrationConnection,
    );
  }
  async connect(
    provider: IntegrationProvider,
    credentials: IntegrationConnection,
  ): Promise<IntegrationStatus> {
    if (provider === 'regru' ? !credentials.username || !credentials.password : !credentials.apiKey)
      throw new BadRequestException('Заполните данные подключения.');
    const status = await this.probe(provider, credentials);
    const value = JSON.stringify({
      credentialsEnc: this.crypto.encrypt(JSON.stringify(credentials)),
      status,
    });
    await this.db
      .insert(appMeta)
      .values({ key: this.key(provider), value })
      .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: new Date() } });
    return status;
  }
  /** Fixed provider URLs; no credential-bearing query strings or redirect following. */
  async json(url: string, options: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!response.ok)
      throw problem(response.status === 429 ? 429 : 502, {
        type: 'urn:nodeservice:integration:provider',
        detail:
          response.status === 401 || response.status === 403
            ? 'Сервис отклонил доступ. Проверьте API-токен и разрешения для нужных зон. Cloudflare: Zone Read для списка зон, DNS Read для записей, DNS Edit для изменения.'
            : response.status === 429
              ? 'Лимит запросов сервиса. Повторите позже.'
              : `Внешний сервис вернул HTTP ${response.status}. Повторите запрос позже.`,
      });
    if (!response.body) throw new Error('Empty response');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 2_000_000) throw new Error('Provider response too large');
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return Array.isArray(parsed) ? { items: parsed } : object(parsed);
  }
  async probe(provider: IntegrationProvider, credentials: IntegrationConnection): Promise<IntegrationStatus> {
    try {
      const status: IntegrationStatus = {
        ...empty(provider),
        connected: true,
        checkedAt: new Date().toISOString(),
      };
      if (provider === 'bschecker') {
        const data = await this.json('https://bsbord.com/v1/account', {headers:{Authorization:`Bearer ${credentials.apiKey}`}});
        const total = data.balance_total;
        if (typeof total !== 'number' || !Number.isFinite(total)) throw new Error('Неверный ответ аккаунта BS Checker');
        status.balance = String(total / 100);
      } else if (provider === 'dpi') {
        const data = await this.json('https://dpichecker.st/api/v1/profile', {
          headers: { 'X-API-Key': credentials.apiKey ?? '' },
        });
        const profile = data.data && typeof data.data === 'object' ? object(data.data) : data;
        const raw =
          profile.balance ?? profile.usd_balance ?? profile.balance_usd ?? profile.available_balance;
        if (
          (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) ||
          (typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw))
        )
          status.balance = String(raw);
        else throw new Error('Invalid profile response');
      } else if (provider === 'cloudflare') {
        let page = 1,
          totalPages = 1;
        do {
          const data = await this.json(
            `https://api.cloudflare.com/client/v4/zones?per_page=50&page=${page}`,
            { headers: { Authorization: `Bearer ${credentials.apiKey}` } },
          );
          if (data.success !== true || !Array.isArray(data.result)) throw new Error('Provider refused');
          status.domains.push(
            ...array(data.result)
              .map((x) => String(x.name ?? ''))
              .filter(Boolean),
          );
          totalPages = Number(object(data.result_info).total_pages ?? 1);
          if (!Number.isFinite(totalPages) || totalPages > 100) throw new Error('Too many zones');
          page++;
        } while (page <= totalPages);
      } else {
        const body = new URLSearchParams({
          username: credentials.username ?? '',
          password: credentials.password ?? '',
          input_format: 'json',
          output_format: 'json',
          io_encoding: 'utf8',
          input_data: JSON.stringify({ servtype: 'domain' }),
        });
        const data = await this.json('https://api.reg.ru/api/regru2/service/get_list', {
          method: 'POST',
          body,
        });
        if (data.result !== 'success' || !Array.isArray(object(data.answer).services))
          throw new Error('Provider refused');
        status.domains = array(object(data.answer).services)
          .map((x) => String(x.dname ?? ''))
          .filter(Boolean);
      }
      return status;
    } catch (e) {
      if (e && typeof e === 'object' && 'getStatus' in e) throw e;
      throw problem(502, {
        type: 'urn:nodeservice:integration:unreachable',
        detail:
          'Сервис не ответил или вернул неожиданный ответ. Проверьте доступность API и повторите подключение.',
      });
    }
  }
}
