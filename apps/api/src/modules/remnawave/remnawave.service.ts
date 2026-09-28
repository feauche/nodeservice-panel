import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  REMNAWAVE_CERT_CHECK_INTERVAL_MIN,
  REMNAWAVE_PROBLEM,
  type RemnawaveConnectRequest,
  type RemnawaveStatus,
} from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';
import { AuditService } from '../audit/audit.service.js';
import {
  REMNAWAVE_CLIENT,
  RemnawaveApiError,
  type RemnawaveClient,
  type RemnawaveNodeInbound,
} from './remnawave-client.js';
import { RemnawaveSettingsStore } from './remnawave-settings.store.js';

@Injectable()
export class RemnawaveService {
  private readonly log = new Logger(RemnawaveService.name);
  /** Когда последний раз проверяли сертификат панели (0 — ещё не проверяли после запуска). */
  private certCheckedAt = 0;

  constructor(
    private readonly store: RemnawaveSettingsStore,
    @Inject(REMNAWAVE_CLIENT) private readonly client: RemnawaveClient,
    private readonly audit: AuditService,
  ) {}

  /** J10: SNI и порт ноды для проверки блокировки — только когда проверка реально запускается. */
  async nodeInbound(nodeUuid: string): Promise<RemnawaveNodeInbound | null> {
    const creds = await this.store.credentials();
    if (!creds) return null;
    try {
      return await this.client.findNodeInbound(creds.domain, creds.apiKey, nodeUuid);
    } catch (err) {
      this.log.warn(`Инбаунд ноды ${nodeUuid}: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  async status(): Promise<RemnawaveStatus> {
    const domain = await this.store.domain();
    if (!domain)
      return {
        connected: false,
        domain: null,
        checkedAt: null,
        error: null,
        stats: null,
        nodes: [],
        cert: null,
      };
    const snap = await this.store.snapshot();
    return {
      connected: true,
      domain,
      checkedAt: snap?.checkedAt ?? null,
      error: snap?.error ?? null,
      stats: snap?.stats ?? null,
      nodes: snap?.nodes ?? [],
      cert: snap?.cert ?? null,
    };
  }

  /** Первое подключение: проверяем домен и токен по-настоящему, сохраняем только при успехе. */
  async connect(req: RemnawaveConnectRequest): Promise<RemnawaveStatus> {
    const { domain, apiKey } = req;
    const { stats, nodes } = await this.fetchOrThrow(domain, apiKey);
    const cert = await this.client.checkCertificate(domain);
    const checkedAt = new Date().toISOString();
    await this.store.connect(domain, apiKey, { checkedAt, error: null, stats, nodes, cert });
    await this.audit.record({
      action: 'remnawave.connected',
      target: { type: 'settings', id: 'remnawave', display: domain },
      metadata: { domain, nodes: nodes.length, users: stats.users.total },
    });
    return this.status();
  }

  /** Кнопка «Обновить»: свежие данные по уже сохранённому домену и токену. */
  async refresh(): Promise<RemnawaveStatus> {
    const creds = await this.store.credentials();
    if (!creds)
      throw problem(HttpStatus.CONFLICT, {
        type: REMNAWAVE_PROBLEM.notConnected,
        detail: 'Remnawave не подключена.',
      });
    await this.sync(creds.domain, creds.apiKey);
    return this.status();
  }

  async disconnect(): Promise<void> {
    const domain = await this.store.domain();
    await this.store.disconnect();
    if (domain)
      await this.audit.record({
        action: 'remnawave.disconnected',
        target: { type: 'settings', id: 'remnawave', display: domain },
      });
  }

  /** Плановая перепроверка (джоба): тихо пишет ошибку в снимок, не роняет и не шумит в Журнале на каждый тик. */
  async syncQuiet(): Promise<void> {
    const creds = await this.store.credentials();
    if (!creds) return;
    const before = await this.store.snapshot();
    const wasOk = before ? !before.error : true;
    try {
      await this.sync(creds.domain, creds.apiKey);
      if (!wasOk)
        await this.audit.record({
          action: 'remnawave.reconnected',
          target: { type: 'settings', id: 'remnawave', display: creds.domain },
        });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.store.updateSnapshot({
        checkedAt: new Date().toISOString(),
        error: message,
        stats: before?.stats ?? null,
        nodes: before?.nodes ?? [],
        cert: before?.cert ?? null,
      });
      if (wasOk)
        await this.audit.record({
          action: 'remnawave.unreachable',
          severity: 'warn',
          target: { type: 'settings', id: 'remnawave', display: creds.domain },
          metadata: { error: message },
        });
      this.log.warn(`Remnawave (${creds.domain}) недоступна: ${message}`);
    }
  }

  private async sync(domain: string, apiKey: string): Promise<void> {
    const { stats, nodes } = await this.fetchOrThrow(domain, apiKey);
    // Онлайн нод читаем раз в минуту, а сертификат — раз в полчаса: он меняется раз в месяцы.
    const before = await this.store.snapshot();
    const fresh = Date.now() - this.certCheckedAt < REMNAWAVE_CERT_CHECK_INTERVAL_MIN * 60_000;
    const cert = fresh && before?.cert ? before.cert : await this.client.checkCertificate(domain);
    if (!fresh || !before?.cert) this.certCheckedAt = Date.now();
    await this.store.updateSnapshot({ checkedAt: new Date().toISOString(), error: null, stats, nodes, cert });
  }

  private async fetchOrThrow(domain: string, apiKey: string) {
    try {
      return await this.client.fetch(domain, apiKey);
    } catch (err) {
      if (err instanceof RemnawaveApiError) {
        if (err.kind === 'unauthorized')
          throw problem(HttpStatus.BAD_REQUEST, {
            type: REMNAWAVE_PROBLEM.unauthorized,
            detail: err.message,
          });
        throw problem(HttpStatus.BAD_GATEWAY, {
          type: REMNAWAVE_PROBLEM.domainUnreachable,
          detail: err.message,
        });
      }
      throw err;
    }
  }
}
