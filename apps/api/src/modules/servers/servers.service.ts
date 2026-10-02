import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type CountryChoice,
  type CreateServerRequest,
  computeDrift,
  countryCodeSchema,
  ENROLLMENT_TOKEN_TTL_HOURS,
  type EnrollmentTokenResponse,
  isExitOnly,
  normalizeProfilePatch,
  SERVER_NAME_MAX,
  type Server,
  type ServerCountry,
  type ServerInventory,
  type ServerProfile,
  type ServerRole,
  type ServerUpstream,
  type SshAuth,
  type TestConnectionRequest,
  type TestConnectionResponse,
  type UpdateServerRequest,
} from '@nodeservice/shared';

import { CryptoService } from '../../common/crypto/crypto.service.js';
import { errorText, problem } from '../../common/filters/problem-details.filter.js';
import type { Env } from '../../config/env.schema.js';
import type { ServerRow, servers } from '../../infra/db/schema/index.js';
import { SYSTEM_ACTOR } from '../audit/audit.context.js';
import { diffChanges } from '../audit/audit.diff.js';
import { AuditService } from '../audit/audit.service.js';
import {
  AGENT_INSTALL_LABEL,
  AGENT_INSTALL_TIMEOUT_MS,
  agentInstallCommand,
  agentInstallScript,
  installFailure,
} from './agent-install.js';
import { PanelKeyService } from './panel-key.service.js';
import { ServerCountryService } from './server-country.service.js';
import { serverProblems } from './servers.problems.js';
import { ServersRepository } from './servers.repository.js';
import { type GatheredFacts, SshService, type SshSession, type SshTarget } from './ssh.service.js';
import { normalizePrivateKey } from './ssh-key.js';

/**
 * Инвентарь серверов. Принципы этапа 4:
 *  - пароль SSH живёт один запрос: им ставится ключ панели, дальше только ключи;
 *  - host key фиксируется при добавлении (TOFU), смена — только явное «доверять» за step-up;
 *  - каждое действие — в Журнал (server.*).
 */
@Injectable()
export class ServersService {
  /** Кого предупредить об удалении сервера: шлюз агентов закрывает соединение его агента. */
  private readonly deleteListeners: Array<(id: string) => void> = [];
  /** Когда на сервере закончилась последняя удачная установка агента (в памяти процесса). */
  private readonly installedAt = new Map<string, number>();
  /** Сколько установок агента идёт на сервере прямо сейчас — в этом процессе. */
  private readonly installsRunning = new Map<string, number>();

  constructor(
    private readonly repo: ServersRepository,
    private readonly ssh: SshService,
    private readonly panelKey: PanelKeyService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
    private readonly country: ServerCountryService,
  ) {}

  /** Значения колонок страны для новой записи: страна выбрана вручную или определится по IP после добавления. */
  private countryInsert(choice: CountryChoice | undefined): Partial<typeof servers.$inferInsert> {
    if (choice?.mode === 'manual')
      return {
        country: countryCodeSchema.parse(choice.code),
        countrySource: 'manual',
        countryStatus: 'ok',
        countryCheckedAt: new Date(),
      };
    return { countrySource: 'auto', countryStatus: 'detecting' };
  }

  toDto(row: ServerRow): Server {
    const profile: ServerProfile = {
      roles: (row.roles as ServerProfile['roles']) ?? [],
      importance: (row.importance as ServerProfile['importance']) ?? 'normal',
      maintenanceWindow: row.maintenanceWindow,
      expectedContainers: row.expectedContainers ?? [],
      expectedPorts: row.expectedPorts ?? [],
      upstream: row.upstream ?? null,
    };
    const inventory =
      row.inventory && row.inventoryAt ? { at: row.inventoryAt.toISOString(), ...row.inventory } : null;
    return {
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      sshUser: row.sshUser,
      authMethod: row.authMethod as Server['authMethod'],
      tags: row.tags ?? [],
      notes: row.notes,
      providerId: row.providerId ?? null,
      nodeWatch: row.nodeWatch as Server['nodeWatch'],
      nodeLink: row.nodeLink,
      country: {
        code: row.country,
        source: row.countrySource as ServerCountry['source'],
        status: row.countryStatus as ServerCountry['status'],
        agree: row.countryAgree,
        total: row.countryTotal,
        checkedAt: row.countryCheckedAt?.toISOString() ?? null,
        note: row.countryNote,
      },
      profile,
      inventory,
      drift: computeDrift(profile, inventory),
      node: row.nodeWatch === 'off' ? null : ((row.nodeState as Server['node']) ?? null),
      facts: {
        hostname: row.hostname,
        os: row.os,
        osVersion: row.osVersion,
        arch: row.arch,
        kernel: row.kernel,
        cpuCores: row.cpuCores,
        memoryMb: row.memoryMb,
        addresses: row.addresses ?? [],
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
        sshPrivateKeyEnc:
          req.auth.method === 'key' ? this.crypto.encrypt(normalizePrivateKey(req.auth.privateKey)) : null,
        tags: req.tags,
        notes: req.notes?.trim() ? req.notes.trim() : null,
        providerId: await this.resolveProvider(req.providerId),
        nodeWatch: req.nodeWatch,
        ...this.countryInsert(req.country),
        agentStatus: 'not_installed',
        sshOk: null,
      });
      if (row.countrySource === 'auto') this.country.kick(row.id);
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
    let facts: GatheredFacts;
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
        !installPanelKey && req.auth.method === 'key'
          ? this.crypto.encrypt(normalizePrivateKey(req.auth.privateKey))
          : null,
      tags: req.tags,
      notes: req.notes?.trim() ? req.notes.trim() : null,
      providerId: await this.resolveProvider(req.providerId),
      nodeWatch: req.nodeWatch,
      ...this.countryInsert(req.country),
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
    if (row.countrySource === 'auto') this.country.kick(row.id);
    return this.toDto(row);
  }

  /** Дубль: копия записи (адрес, доступы, факты), имя получает номер -2/-3/… Один клик — новый сервер. */
  /** Записать снимок фактического состояния сервера (кто запущен, какие порты слушаются). */
  async saveInventory(id: string, inventory: Omit<ServerInventory, 'at'>): Promise<Server> {
    const updated = await this.repo.update(id, { inventory, inventoryAt: new Date() });
    if (!updated) throw serverProblems.notFound();
    return this.toDto(updated);
  }

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
      nodeWatch: row.nodeWatch,
      country: row.country,
      countrySource: row.countrySource,
      countryStatus: row.countryStatus,
      countryAgree: row.countryAgree,
      countryTotal: row.countryTotal,
      countryCheckedAt: row.countryCheckedAt,
      countryNote: row.countryNote,
      roles: row.roles ?? [],
      importance: row.importance,
      maintenanceWindow: row.maintenanceWindow,
      expectedContainers: row.expectedContainers ?? [],
      expectedPorts: row.expectedPorts ?? [],
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

  /**
   * «Управление тегами»: переименовать тег на всех серверах. Если новый уже есть у сервера — слить (без
   * повтора). Одна запись в Журнале на всю операцию.
   */
  async renameTag(from: string, to: string): Promise<{ updated: number }> {
    if (from === to) return { updated: 0 };
    const all = await this.repo.list();
    const rows = all.filter((r) => r.tags.includes(from));
    // Новый тег уже был в парке — это слияние, а не переименование.
    const merged = all.some((r) => r.tags.includes(to));
    for (const r of rows)
      await this.repo.update(r.id, { tags: [...new Set(r.tags.map((t) => (t === from ? to : t)))] });
    await this.audit.record({
      action: 'server.tags.renamed',
      metadata: { from, to, servers: rows.length, merged: merged ? 'да' : 'нет' },
    });
    return { updated: rows.length };
  }

  /** Убрать тег со всех серверов. */
  async deleteTag(tag: string): Promise<{ updated: number }> {
    const rows = (await this.repo.list()).filter((r) => r.tags.includes(tag));
    for (const r of rows) await this.repo.update(r.id, { tags: r.tags.filter((t) => t !== tag) });
    await this.audit.record({ action: 'server.tags.deleted', metadata: { tag, servers: rows.length } });
    return { updated: rows.length };
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
      let facts: GatheredFacts;
      // Пароль ключа панель не хранит: ключ с паролем используем один раз — чтобы поставить свой ключ панели.
      const installPanelKey =
        patch.auth.method === 'password' || (patch.auth.method === 'key' && Boolean(patch.auth.passphrase));
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
        authMethod: !installPanelKey && patch.auth.method === 'key' ? 'key' : 'panel-key',
        sshPrivateKeyEnc:
          !installPanelKey && patch.auth.method === 'key'
            ? this.crypto.encrypt(normalizePrivateKey(patch.auth.privateKey))
            : null,
        ...facts,
        hostKeyFp,
        sshOk: true,
        lastSshCheckAt: now,
        lastSshOkAt: now,
      };
    }
    const profilePatch = patch.profile ? normalizeProfilePatch(patch.profile) : undefined;
    // Вход имеет смысл только у чистого выхода: сняли «выпускает трафик» или поставили «принимает
    // подключения» — сохранённый вход убираем, чтобы он не путал проверку и Джарвиса.
    const rolesAfter = (profilePatch?.roles ?? row.roles ?? []) as ServerRole[];
    let upstream: ServerUpstream | null | undefined = profilePatch?.upstream as
      | ServerUpstream
      | null
      | undefined;
    if (!isExitOnly(rolesAfter) && (row.upstream || upstream)) upstream = null;
    if (upstream?.kind === 'bridge') {
      const bridge = upstream.serverId ? await this.repo.findById(upstream.serverId) : undefined;
      if (!bridge || bridge.id === id)
        throw problem(HttpStatus.BAD_REQUEST, {
          detail: 'Мост не найден среди серверов NodeService — выберите другой.',
        });
    }
    const audited = (r: ServerRow) => ({
      name: r.name,
      host: r.host,
      port: r.port,
      sshUser: r.sshUser,
      tags: r.tags,
      notes: r.notes,
      providerId: r.providerId,
      nodeWatch: r.nodeWatch,
      nodeLink: r.nodeLink,
      country: r.country,
      countrySource: r.countrySource,
      roles: r.roles,
      importance: r.importance,
      maintenanceWindow: r.maintenanceWindow,
      expectedContainers: r.expectedContainers,
      expectedPorts: r.expectedPorts,
      upstream: r.upstream,
    });
    const before = audited(row);
    const updated = await this.repo.update(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.host !== undefined ? { host: patch.host } : {}),
      ...(patch.port !== undefined ? { port: patch.port } : {}),
      ...(patch.sshUser !== undefined ? { sshUser: patch.sshUser } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes?.trim() ? patch.notes.trim() : null } : {}),
      ...(patch.providerId !== undefined ? { providerId: await this.resolveProvider(patch.providerId) } : {}),
      ...(patch.nodeWatch !== undefined ? { nodeWatch: patch.nodeWatch } : {}),
      ...(patch.nodeLink !== undefined ? { nodeLink: patch.nodeLink } : {}),
      ...(patch.country !== undefined
        ? {
            ...this.countryInsert(patch.country),
            countryAgree: null,
            countryTotal: null,
            countryNote: null,
            countryCandidate: null,
            countryCandidateCount: 0,
            // Автоматика: страна остаётся прежней, пока определение не даст новую; ручной выбор с нуля.
            ...(patch.country.mode === 'auto' ? { countryCheckedAt: null } : {}),
          }
        : // Сменился адрес сервера: при автоопределении страну нужно определить заново.
          host !== row.host && row.countrySource === 'auto'
          ? {
              countryStatus: 'detecting',
              countryAgree: null,
              countryTotal: null,
              countryCheckedAt: null,
              countryNote: null,
              countryCandidate: null,
              countryCandidateCount: 0,
            }
          : {}),
      ...(profilePatch?.roles !== undefined ? { roles: profilePatch.roles } : {}),
      ...(profilePatch?.importance !== undefined ? { importance: profilePatch.importance } : {}),
      ...(profilePatch?.maintenanceWindow !== undefined
        ? { maintenanceWindow: profilePatch.maintenanceWindow }
        : {}),
      ...(profilePatch?.expectedContainers !== undefined
        ? { expectedContainers: profilePatch.expectedContainers }
        : {}),
      ...(profilePatch?.expectedPorts !== undefined ? { expectedPorts: profilePatch.expectedPorts } : {}),
      ...(upstream !== undefined ? { upstream } : {}),
      ...(endpointChanged && !patch.auth
        ? { hostKeyFp: null, sshOk: null, lastSshCheckAt: null, lastSshOkAt: null }
        : {}),
      ...authUpdate,
    });
    if (!updated) throw serverProblems.notFound();
    const after = audited(updated);
    await this.audit.record({
      action: 'server.updated',
      target: { type: 'server', id, display: updated.name },
      changes: diffChanges(before, after),
      metadata: {
        ...(endpointChanged && !patch.auth ? { hostKeyReset: true } : {}),
        ...(patch.auth ? { authChanged: true, authMethod: patch.auth.method } : {}),
      },
    });
    if (updated.name !== row.name) await this.repo.propagateRename(id, row.name, updated.name);
    if (updated.countrySource === 'auto' && updated.countryStatus === 'detecting') this.country.kick(id);
    return this.toDto(updated);
  }

  onDeleted(listener: (id: string) => void): void {
    this.deleteListeners.push(listener);
  }

  async delete(id: string): Promise<void> {
    const row = await this.repo.findById(id);
    if (!row) throw serverProblems.notFound();
    await this.repo.delete(id);
    // Агент удалённого сервера оставался на связи, пока соединение не оборвётся само, — закрываем сразу.
    for (const listener of this.deleteListeners) {
      try {
        listener(id);
      } catch {
        // Сервер уже удалён: сбой слушателя не должен превращать удаление в ошибку.
      }
    }
    this.installedAt.delete(id);
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
      // Не root — всё, что панель делает на сервере, идёт через sudo.
      ...(row.sshUser !== 'root' ? { sudo: true } : {}),
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

  /** Провайдер должен существовать в справочнике; null — «без провайдера». */
  private async resolveProvider(id: string | null | undefined): Promise<string | null> {
    if (!id) return null;
    if (!(await this.repo.providerExists(id))) throw serverProblems.providerNotFound();
    return id;
  }

  /** Фоновая автоустановка после добавления: не блокирует ответ, причины неудач уже пишет installAgent. */
  private autoInstallAgent(id: string): void {
    void this.installAgent(id).catch(() => {});
  }

  /**
   * Установка агента кнопкой: панель сама заходит по SSH и выполняет установочный скрипт из релизов.
   * «Установлено» — только когда скрипт действительно отработал (ненулевой код и таймаут — неудача с
   * причиной); в ошибках нет ни команды, ни токена; токен неудавшейся установки отзывается.
   */
  async installAgent(id: string): Promise<Server> {
    // Пока установка идёт, статус «Агент устанавливается…» — её; по этой отметке AgentPendingJob отличает
    // идущую установку от оборванной перезапуском панели.
    this.installsRunning.set(id, (this.installsRunning.get(id) ?? 0) + 1);
    try {
      return await this.runAgentInstall(id);
    } finally {
      const left = (this.installsRunning.get(id) ?? 1) - 1;
      if (left > 0) this.installsRunning.set(id, left);
      else this.installsRunning.delete(id);
    }
  }

  private async runAgentInstall(id: string): Promise<Server> {
    const row = await this.repo.findById(id);
    if (!row) throw serverProblems.notFound();
    const issued = await this.issueToken(row);
    // Пока идёт установка — карточка показывает «Агент устанавливается…» (по живому потоку).
    if (row.agentStatus !== 'online') await this.repo.update(id, { agentStatus: 'installing' });
    let session: Awaited<ReturnType<SshService['connect']>> | undefined;
    try {
      session = await this.ssh.connect(await this.storedTarget(row));
      let output = '';
      const res = await session.execStream(agentInstallScript(this.agentInstallParams(issued.token)), {
        label: AGENT_INSTALL_LABEL,
        timeoutMs: AGENT_INSTALL_TIMEOUT_MS,
        // Нужен только хвост вывода — причина неудачи.
        onData: (chunk) => {
          output = (output + chunk).slice(-2_000);
        },
      });
      if (res.code !== 0)
        throw serverProblems.sshCommand(AGENT_INSTALL_LABEL, installFailure(output, res.code));
    } catch (err) {
      // Установка не состоялась — её токен больше не нужен (после таймаута скрипт мог остаться на сервере).
      await this.repo.revokeToken(issued.tokenId).catch(() => undefined);
      // Прежний статус возвращаем, только если его не сменил сам агент (успел выйти на связь). Прежнее
      // «устанавливается» (осталось от оборванной установки) не возвращаем — оно висело бы вечно.
      const current = await this.repo.findById(id);
      if (current?.agentStatus === 'installing') {
        const before =
          row.agentStatus !== 'installing' ? row.agentStatus : row.agentPubkey ? 'offline' : 'not_installed';
        await this.repo.update(id, { agentStatus: before });
      }
      await this.audit.record({
        action: 'server.agent.install',
        result: 'failed',
        severity: 'warn',
        target: { type: 'server', id, display: row.name },
        metadata: { reason: errorText(err).slice(0, 300) },
      });
      throw err;
    } finally {
      session?.end();
    }
    // Новый агент мог выйти на связь раньше, чем вернулась команда, — тогда он уже «в сети». Иначе ждём его:
    // прежний агент (если был) скриптом остановлен, показывать «в сети» по старой памяти нельзя.
    const fresh = await this.repo.findById(id);
    const updated =
      fresh?.agentStatus === 'online' ? fresh : await this.repo.update(id, { agentStatus: 'pending' });
    this.installedAt.set(id, Date.now());
    await this.audit.record({
      action: 'server.agent.install',
      target: { type: 'server', id, display: row.name },
      metadata: { repo: this.config.get('AGENT_REPO') },
    });
    if (!updated) throw serverProblems.notFound();
    return this.toDto(updated);
  }

  /** С этого момента «Ожидает агента» отсчитывает свои три минуты (AgentPendingJob); нет — установки не было. */
  agentInstalledAt(id: string): number | undefined {
    return this.installedAt.get(id);
  }

  /** Идёт ли установка агента на сервере прямо сейчас (после перезапуска панели — заведомо нет). */
  agentInstallRunning(id: string): boolean {
    return this.installsRunning.has(id);
  }

  async issueEnrollmentToken(id: string): Promise<EnrollmentTokenResponse> {
    const row = await this.repo.findById(id);
    if (!row) throw serverProblems.notFound();
    const issued = await this.issueToken(row);
    return {
      token: issued.token,
      serverId: id,
      expiresAt: issued.expiresAt.toISOString(),
      installCommand: agentInstallCommand(this.agentInstallParams(issued.token)),
    };
  }

  private agentInstallParams(token: string) {
    return {
      repo: this.config.get('AGENT_REPO'),
      token,
      panel: this.config.get('AGENT_PUBLIC_URL') ?? this.config.get('PUBLIC_URL'),
    };
  }

  /** Новый токен подключения агента (прежние живые отзываются); `tokenId` — чтобы отозвать именно его. */
  private async issueToken(row: ServerRow): Promise<{ token: string; tokenId: string; expiresAt: Date }> {
    const token = `nse_${this.crypto.randomToken(24)}`;
    const expiresAt = new Date(Date.now() + ENROLLMENT_TOKEN_TTL_HOURS * 3_600_000);
    const revoked = await this.repo.revokeActiveTokens(row.id);
    const saved = await this.repo.insertEnrollmentToken({
      serverId: row.id,
      tokenHash: this.crypto.sha256Hex(token),
      expiresAt,
    });
    await this.audit.record({
      action: 'server.enrollment.issued',
      target: { type: 'server', id: row.id, display: row.name },
      metadata: { expiresAt: expiresAt.toISOString(), replacedTokens: revoked },
    });
    return { token, tokenId: saved.id, expiresAt };
  }
}
