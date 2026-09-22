import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type CreateServerRequest,
  ENROLLMENT_TOKEN_TTL_HOURS,
  type EnrollmentTokenResponse,
  SERVER_NAME_MAX,
  type Server,
  type ServerFacts,
  type SshAuth,
  type TestConnectionRequest,
  type TestConnectionResponse,
  type UpdateServerRequest,
} from '@nodeservice/shared';

import { CryptoService } from '../../common/crypto/crypto.service.js';
import type { Env } from '../../config/env.schema.js';
import type { ServerRow } from '../../infra/db/schema/index.js';
import { SYSTEM_ACTOR } from '../audit/audit.context.js';
import { diffChanges } from '../audit/audit.diff.js';
import { AuditService } from '../audit/audit.service.js';
import { PanelKeyService } from './panel-key.service.js';
import { serverProblems } from './servers.problems.js';
import { ServersRepository } from './servers.repository.js';
import { SshService, type SshSession, type SshTarget } from './ssh.service.js';

/**
 * Инвентарь серверов. Принципы этапа 4:
 *  - пароль SSH живёт один запрос: им ставится ключ панели, дальше только ключи;
 *  - host key фиксируется при добавлении (TOFU), смена — только явное «доверять» за step-up;
 *  - каждое действие — в Журнал (server.*).
 */
@Injectable()
export class ServersService {
  constructor(
    private readonly repo: ServersRepository,
    private readonly ssh: SshService,
    private readonly panelKey: PanelKeyService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  toDto(row: ServerRow): Server {
    return {
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      sshUser: row.sshUser,
      authMethod: row.authMethod as Server['authMethod'],
      tags: row.tags ?? [],
      notes: row.notes,
      facts: {
        hostname: row.hostname,
        os: row.os,
        osVersion: row.osVersion,
        arch: row.arch,
        kernel: row.kernel,
        cpuCores: row.cpuCores,
        memoryMb: row.memoryMb,
      },
      hostKeyFingerprint: row.hostKeyFp,
      agentStatus: row.agentStatus as Server['agentStatus'],
      agentVersion: row.agentVersion,
      agentLastSeenAt: row.agentLastSeenAt?.toISOString() ?? null,
      sshOk: row.sshOk,
      lastSshCheckAt: row.lastSshCheckAt?.toISOString() ?? null,
      lastSshOkAt: row.lastSshOkAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async list(): Promise<Server[]> {
    return (await this.repo.list()).map((r) => this.toDto(r));
  }

  async get(id: string): Promise<Server> {
    const row = await this.repo.findById(id);
    if (!row) throw serverProblems.notFound();
    return this.toDto(row);
  }

  /* ---------- подключение ---------- */

  private async resolveAuth(
    auth: SshAuth,
  ): Promise<Pick<SshTarget, 'password' | 'privateKey' | 'passphrase'>> {
    switch (auth.method) {
      case 'password':
        return { password: auth.password };
      case 'key':
        return { privateKey: auth.privateKey, ...(auth.passphrase ? { passphrase: auth.passphrase } : {}) };
      case 'panel-key':
        return { privateKey: (await this.panelKey.get()).privateKeyOpenSsh };
    }
  }

  /** Проверка доступов до создания: подключаемся, собираем факты, ничего не сохраняем. */
  async testConnection(req: TestConnectionRequest): Promise<TestConnectionResponse> {
    const session = await this.ssh.connect({
      host: req.host,
      port: req.port,
      user: req.sshUser,
      ...(await this.resolveAuth(req.auth)),
    });
    try {
      const facts = await this.ssh.gatherFacts(session);
      return { hostKeyFingerprint: session.hostKeyFp, facts };
    } finally {
      session.end();
    }
  }

  async create(req: CreateServerRequest): Promise<Server> {
    if (await this.repo.findByName(req.name)) throw serverProblems.nameTaken(req.name);

    // Добавление без подключения: доступы проверит автопроверка SSH или ручная проверка.
    if (!req.verify) {
      if (req.auth.method === 'password') throw serverProblems.passwordNeedsVerify();
      const row = await this.repo.insert({
        sortOrder: await this.repo.nextSortOrder(),
        name: req.name,
        host: req.host,
        port: req.port,
        sshUser: req.sshUser,
        authMethod: req.auth.method,
        sshPrivateKeyEnc: req.auth.method === 'key' ? this.crypto.encrypt(req.auth.privateKey) : null,
        tags: req.tags,
        notes: req.notes?.trim() ? req.notes.trim() : null,
        agentStatus: 'not_installed',
        sshOk: null,
      });
      await this.audit.record({
        action: 'server.created',
        target: { type: 'server', id: row.id, display: row.name },
        metadata: {
          host: `${req.host}:${req.port}`,
          sshUser: req.sshUser,
          authMethod: row.authMethod,
          verified: false,
        },
      });
      return this.toDto(row);
    }

    // Пароль не сохраняется — значит, ключ панели ставится обязательно.
    const installPanelKey = req.auth.method === 'password' ? true : req.installPanelKey;

    const first = await this.ssh.connect({
      host: req.host,
      port: req.port,
      user: req.sshUser,
      ...(await this.resolveAuth(req.auth)),
    });
    let facts: ServerFacts;
    const hostKeyFp = first.hostKeyFp;
    try {
      facts = await this.ssh.gatherFacts(first);
      if (installPanelKey) await this.ssh.installAuthorizedKey(first, await this.panelKey.publicKeyLine());
    } finally {
      first.end();
    }

    if (installPanelKey) {
      // Ключ должен реально работать до того, как мы забудем пароль.
      const verify = await this.ssh.connect({
        host: req.host,
        port: req.port,
        user: req.sshUser,
        privateKey: (await this.panelKey.get()).privateKeyOpenSsh,
        expectedHostKeyFp: hostKeyFp,
      });
      verify.end();
    }

    const now = new Date();
    const row = await this.repo.insert({
      sortOrder: await this.repo.nextSortOrder(),
      name: req.name,
      host: req.host,
      port: req.port,
      sshUser: req.sshUser,
      authMethod: installPanelKey ? 'panel-key' : 'key',
      sshPrivateKeyEnc:
        !installPanelKey && req.auth.method === 'key' ? this.crypto.encrypt(req.auth.privateKey) : null,
      tags: req.tags,
      notes: req.notes?.trim() ? req.notes.trim() : null,
      ...facts,
      hostKeyFp,
      agentStatus: 'not_installed',
      sshOk: true,
      lastSshCheckAt: now,
      lastSshOkAt: now,
    });
    await this.audit.record({
      action: 'server.created',
      target: { type: 'server', id: row.id, display: row.name },
      metadata: {
        host: `${req.host}:${req.port}`,
        sshUser: req.sshUser,
        authMethod: row.authMethod,
        os: facts.os ?? '—',
        arch: facts.arch ?? '—',
      },
    });
    // Агент ставится автоматически, фоном: успех/неудача — в Журнале (server.agent.install),
    // запасной путь — кнопка «Установить агента» в карточке.
    this.autoInstallAgent(row.id);
    return this.toDto(row);
  }

  /** Дубль: копия записи (адрес, доступы, факты), имя получает номер -2/-3/… Один клик — новый сервер. */
  async duplicate(id: string): Promise<Server> {
    const row = await this.repo.findById(id);
    if (!row) throw serverProblems.notFound();
    const name = this.copyName(
      row.name,
      (await this.repo.list()).map((r) => r.name),
    );
    await this.repo.shiftOrderAfter(row.sortOrder);
    const copy = await this.repo.insert({
      sortOrder: row.sortOrder + 1,
      name,
      host: row.host,
      port: row.port,
      sshUser: row.sshUser,
      authMethod: row.authMethod,
      sshPrivateKeyEnc: row.sshPrivateKeyEnc,
      tags: row.tags ?? [],
      notes: row.notes,
      hostname: row.hostname,
      os: row.os,
      osVersion: row.osVersion,
      arch: row.arch,
      kernel: row.kernel,
      cpuCores: row.cpuCores,
      memoryMb: row.memoryMb,
      hostKeyFp: row.hostKeyFp,
      // Агент привязан к конкретной записи — копия начинает без него.
      agentStatus: 'not_installed',
      sshOk: row.sshOk,
      lastSshCheckAt: row.lastSshCheckAt,
      lastSshOkAt: row.lastSshOkAt,
    });
    await this.audit.record({
      action: 'server.duplicated',
      target: { type: 'server', id: copy.id, display: copy.name },
      metadata: { sourceId: id, sourceName: row.name, host: `${row.host}:${row.port}` },
    });
    return this.toDto(copy);
  }

  /** Ручной порядок карточек (drag-and-drop на странице серверов). */
  async reorder(ids: string[]): Promise<Server[]> {
    await this.repo.setOrder(ids);
    await this.audit.record({ action: 'server.reordered', metadata: { count: ids.length } });
    return this.list();
  }

  /** Имя копии: хвост «-2» без ведущего нуля — номер копии, «-01» — часть имени (de-fra-01 → de-fra-01-2). */
  private copyName(source: string, existing: string[]): string {
    const base = source.replace(/-[1-9]\d*$/, '');
    const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-([1-9]\\d*)$`);
    let max = 1;
    for (const n of existing) {
      const m = re.exec(n);
      if (m?.[1]) max = Math.max(max, Number(m[1]));
    }
    const suffix = `-${max + 1}`;
    return `${base.slice(0, SERVER_NAME_MAX - suffix.length)}${suffix}`;
  }

  async update(id: string, patch: UpdateServerRequest): Promise<Server> {
    const row = await this.repo.findById(id);
    if (!row) throw serverProblems.notFound();
    if (patch.name && patch.name !== row.name && (await this.repo.findByName(patch.name)))
      throw serverProblems.nameTaken(patch.name);
    const host = patch.host ?? row.host;
    const port = patch.port ?? row.port;

    // Сменился адрес или пользователь — это другая машина: отпечаток и статус проверки сбрасываются.
    const endpointChanged =
      host !== row.host || port !== row.port || (patch.sshUser ?? row.sshUser) !== row.sshUser;

    // Новые доступы SSH: проверяем их настоящим подключением (и, для пароля, ставим ключ панели).
    let authUpdate: Partial<typeof row> = {};
    if (patch.auth) {
      const sshUser = patch.sshUser ?? row.sshUser;
      const first = await this.ssh.connect({
        host,
        port,
        user: sshUser,
        ...(await this.resolveAuth(patch.auth)),
      });
      const hostKeyFp = first.hostKeyFp;
      let facts: ServerFacts;
      const installPanelKey = patch.auth.method === 'password';
      try {
        facts = await this.ssh.gatherFacts(first);
        if (installPanelKey) await this.ssh.installAuthorizedKey(first, await this.panelKey.publicKeyLine());
      } finally {
        first.end();
      }
      if (installPanelKey) {
        const verify = await this.ssh.connect({
          host,
          port,
          user: sshUser,
          privateKey: (await this.panelKey.get()).privateKeyOpenSsh,
          expectedHostKeyFp: hostKeyFp,
        });
        verify.end();
      }
      const now = new Date();
      authUpdate = {
        authMethod: patch.auth.method === 'key' ? 'key' : 'panel-key',
        sshPrivateKeyEnc: patch.auth.method === 'key' ? this.crypto.encrypt(patch.auth.privateKey) : null,
        ...facts,
        hostKeyFp,
        sshOk: true,
        lastSshCheckAt: now,
        lastSshOkAt: now,
      };
    }
    const before = {
      name: row.name,
      host: row.host,
      port: row.port,
      sshUser: row.sshUser,
      tags: row.tags,
      notes: row.notes,
    };
    const updated = await this.repo.update(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.host !== undefined ? { host: patch.host } : {}),
      ...(patch.port !== undefined ? { port: patch.port } : {}),
      ...(patch.sshUser !== undefined ? { sshUser: patch.sshUser } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes?.trim() ? patch.notes.trim() : null } : {}),
      ...(endpointChanged && !patch.auth
        ? { hostKeyFp: null, sshOk: null, lastSshCheckAt: null, lastSshOkAt: null }
        : {}),
      ...authUpdate,
    });
    if (!updated) throw serverProblems.notFound();
    const after = {
      name: updated.name,
      host: updated.host,
      port: updated.port,
      sshUser: updated.sshUser,
      tags: updated.tags,
      notes: updated.notes,
    };
    await this.audit.record({
      action: 'server.updated',
      target: { type: 'server', id, display: updated.name },
      changes: diffChanges(before, after),
      metadata: {
        ...(endpointChanged && !patch.auth ? { hostKeyReset: true } : {}),
        ...(patch.auth ? { authChanged: true, authMethod: patch.auth.method } : {}),
      },
    });
    return this.toDto(updated);
  }

  async delete(id: string): Promise<void> {
    const row = await this.repo.findById(id);
    if (!row) throw serverProblems.notFound();
    await this.repo.delete(id);
    await this.audit.record({
      action: 'server.deleted',
      severity: 'warn',
      target: { type: 'server', id, display: row.name },
      metadata: { host: `${row.host}:${row.port}` },
    });
  }

  /* ---------- проверка связи ---------- */

  private async storedTarget(row: ServerRow): Promise<SshTarget> {
    const auth =
      row.authMethod === 'key' && row.sshPrivateKeyEnc
        ? { privateKey: this.crypto.decrypt(row.sshPrivateKeyEnc) }
        : { privateKey: (await this.panelKey.get()).privateKeyOpenSsh };
    return {
      host: row.host,
      port: row.port,
      user: row.sshUser,
      ...auth,
      ...(row.hostKeyFp ? { expectedHostKeyFp: row.hostKeyFp } : {}),
    };
  }

  /** SSH-таргет и подпись сервера — для веб-терминала (этап 7). */
  async sshTargetFor(id: string): Promise<{ target: SshTarget; name: string }> {
    const row = await this.repo.findById(id);
    if (!row) throw serverProblems.notFound();
    return { target: await this.storedTarget(row), name: row.name };
  }

  /** Повторная проверка SSH: обновляет факты и статус; смена host key → 409. */
  async check(id: string): Promise<Server> {
    const row = await this.repo.findById(id);
    if (!row) throw serverProblems.notFound();
    const now = new Date();
    let session: SshSession;
    try {
      session = await this.ssh.connect(await this.storedTarget(row));
    } catch (err) {
      await this.repo.update(id, { sshOk: false, lastSshCheckAt: now });
      await this.audit.record({
        action: 'server.ssh.checked',
        result: 'failed',
        severity: 'warn',
        target: { type: 'server', id, display: row.name },
        metadata: { host: `${row.host}:${row.port}` },
      });
      throw err;
    }
    try {
      const facts = await this.ssh.gatherFacts(session);
      const updated = await this.repo.update(id, {
        ...facts,
        ...(row.hostKeyFp ? {} : { hostKeyFp: session.hostKeyFp }),
        sshOk: true,
        lastSshCheckAt: now,
        lastSshOkAt: now,
      });
      await this.audit.record({
        action: 'server.ssh.checked',
        target: { type: 'server', id, display: row.name },
        metadata: { host: `${row.host}:${row.port}`, os: facts.os ?? '—' },
      });
      if (!updated) throw serverProblems.notFound();
      return this.toDto(updated);
    } finally {
      session.end();
    }
  }

  /**
   * Фоновая автопроверка SSH (Настройки → Автопроверки): без 409 при смене отпечатка,
   * в Журнал — только смены статуса, не каждый прогон.
   */
  async autocheck(row: ServerRow): Promise<void> {
    const before = row.sshOk;
    const now = new Date();
    const report = async (became: 'ok' | 'failed', reason?: string) => {
      await this.audit.record({
        action: 'server.autocheck.ssh',
        ...(became === 'failed' ? { severity: 'warn' as const, result: 'failed' as const } : {}),
        actor: SYSTEM_ACTOR,
        source: 'auto',
        target: { type: 'server', id: row.id, display: row.name },
        metadata: { became, ...(reason ? { reason: reason.slice(0, 200) } : {}) },
      });
    };
    try {
      const session = await this.ssh.connect(await this.storedTarget(row));
      try {
        const facts = await this.ssh.gatherFacts(session);
        await this.repo.update(row.id, {
          ...facts,
          ...(row.hostKeyFp ? {} : { hostKeyFp: session.hostKeyFp }),
          sshOk: true,
          lastSshCheckAt: now,
          lastSshOkAt: now,
        });
      } finally {
        session.end();
      }
      if (before !== true) await report('ok');
    } catch (err) {
      await this.repo.update(row.id, { sshOk: false, lastSshCheckAt: now });
      if (before !== false) await report('failed', (err as Error).message);
    }
  }

  /** Доверять новому отпечатку (после переустановки сервера). Требует step-up на контроллере. */
  async trustHostKey(id: string, fingerprint: string): Promise<Server> {
    const row = await this.repo.findById(id);
    if (!row) throw serverProblems.notFound();
    const target = await this.storedTarget(row);
    delete target.expectedHostKeyFp;
    const session = await this.ssh.connect(target);
    try {
      if (session.hostKeyFp !== fingerprint)
        throw serverProblems.hostKeyMismatch(fingerprint, session.hostKeyFp);
      const facts = await this.ssh.gatherFacts(session);
      const now = new Date();
      const updated = await this.repo.update(id, {
        ...facts,
        hostKeyFp: session.hostKeyFp,
        sshOk: true,
        lastSshCheckAt: now,
        lastSshOkAt: now,
      });
      await this.audit.record({
        action: 'server.host_key.trusted',
        severity: 'warn',
        target: { type: 'server', id, display: row.name },
        metadata: { previousFingerprint: row.hostKeyFp ?? '—', fingerprint },
      });
      if (!updated) throw serverProblems.notFound();
      return this.toDto(updated);
    } finally {
      session.end();
    }
  }

  /* ---------- токен агента (этап 5 подключит установку) ---------- */

  /** Фоновая автоустановка после добавления: не блокирует ответ, причины неудач уже пишет installAgent. */
  private autoInstallAgent(id: string): void {
    void this.installAgent(id).catch(() => {});
  }

  /** Установка агента кнопкой: панель сама заходит по SSH и выполняет установочный скрипт из релизов. */
  async installAgent(id: string): Promise<Server> {
    const row = await this.repo.findById(id);
    if (!row) throw serverProblems.notFound();
    const issued = await this.issueEnrollmentToken(id);
    const session = await this.ssh.connect(await this.storedTarget(row));
    try {
      const res = await session.exec(issued.installCommand);
      if (res.code !== 0)
        throw serverProblems.sshCommand(
          'install.sh',
          (res.stderr || res.stdout).slice(-300) || `код ${res.code}`,
        );
    } catch (err) {
      await this.audit.record({
        action: 'server.agent.install',
        result: 'failed',
        severity: 'warn',
        target: { type: 'server', id, display: row.name },
        metadata: { reason: String((err as Error).message ?? err).slice(0, 300) },
      });
      throw err;
    } finally {
      session.end();
    }
    const updated = await this.repo.update(id, {
      agentStatus: row.agentStatus === 'online' ? 'online' : 'pending',
    });
    await this.audit.record({
      action: 'server.agent.install',
      target: { type: 'server', id, display: row.name },
      metadata: { repo: this.config.get('AGENT_REPO') },
    });
    if (!updated) throw serverProblems.notFound();
    return this.toDto(updated);
  }

  async issueEnrollmentToken(id: string): Promise<EnrollmentTokenResponse> {
    const row = await this.repo.findById(id);
    if (!row) throw serverProblems.notFound();
    const token = `nse_${this.crypto.randomToken(24)}`;
    const expiresAt = new Date(Date.now() + ENROLLMENT_TOKEN_TTL_HOURS * 3_600_000);
    const revoked = await this.repo.revokeActiveTokens(id);
    await this.repo.insertEnrollmentToken({
      serverId: id,
      tokenHash: this.crypto.sha256Hex(token),
      expiresAt,
    });
    await this.audit.record({
      action: 'server.enrollment.issued',
      target: { type: 'server', id, display: row.name },
      metadata: { expiresAt: expiresAt.toISOString(), replacedTokens: revoked },
    });
    const base = this.config.get('PUBLIC_URL');
    return {
      token,
      serverId: id,
      expiresAt: expiresAt.toISOString(),
      installCommand: `curl -fsSL https://github.com/${this.config.get('AGENT_REPO')}/releases/latest/download/install.sh | sh -s -- --token ${token} --panel ${base}`,
    };
  }
}
