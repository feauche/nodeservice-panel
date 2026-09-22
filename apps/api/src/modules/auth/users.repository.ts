import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import {
  recoveryCodes,
  setupTokens,
  type TrustedDeviceRow,
  trustedDevices,
  type UserRow,
  users,
} from '../../infra/db/schema/index.js';

export function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

/** Доступ к таблицам auth: users, recovery_codes, trusted_devices, setup_tokens. */
/** Код восстановления при записи: хеш для проверки + шифрованная копия для показа. */
export interface RecoveryCodeEntry {
  codeHash: string;
  codeEnc: string;
  position: number;
}

@Injectable()
export class UsersRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /* ---------- users ---------- */

  async countUsers(): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(users);
    return row?.n ?? 0;
  }

  /**
   * Есть ли «настоящий» администратор: TOTP подтверждён либо 2FA отключена через CLI
   * (secret = null). Строки с выданным, но не подтверждённым секретом — мусор старого мастера.
   */
  async hasConfirmedAdmin(): Promise<boolean> {
    const [row] = await this.db
      .select({ n: count() })
      .from(users)
      .where(or(isNotNull(users.totpConfirmedAt), isNull(users.totpSecretEnc)));
    return (row?.n ?? 0) > 0;
  }

  async findByLogin(login: string): Promise<UserRow | undefined> {
    return this.db.query.users.findFirst({ where: eq(users.login, normalizeLogin(login)) });
  }

  async findById(id: string): Promise<UserRow | undefined> {
    return this.db.query.users.findFirst({ where: eq(users.id, id) });
  }

  async listUsers(): Promise<UserRow[]> {
    return this.db.select().from(users).orderBy(asc(users.createdAt));
  }

  /**
   * Финал мастера первого запуска — одна транзакция: пользователь с подтверждённым TOTP,
   * коды восстановления, setup-токены помечены использованными. Если админ уже появился
   * (гонка двух вкладок) — null, ничего не записано.
   */
  async createConfirmedAdmin(input: {
    login: string;
    passwordHash: string;
    totpSecretEnc: string;
    totpKeyVersion: number;
    confirmedAt: Date;
    recoveryCodes: RecoveryCodeEntry[];
  }): Promise<UserRow | null> {
    return this.db.transaction(async (tx) => {
      // Сериализуем конкурентные confirm: одна транзакция на таблицу.
      await tx.execute(sql`lock table ${users} in share row exclusive mode`);
      const [existing] = await tx
        .select({ n: count() })
        .from(users)
        .where(or(isNotNull(users.totpConfirmedAt), isNull(users.totpSecretEnc)));
      if ((existing?.n ?? 0) > 0) return null;
      // Незавершённые строки старого мастера (секрет выдан, код не подтверждён) — удаляем.
      await tx.delete(users).where(and(isNull(users.totpConfirmedAt), isNotNull(users.totpSecretEnc)));
      const [row] = await tx
        .insert(users)
        .values({
          login: normalizeLogin(input.login),
          passwordHash: input.passwordHash,
          totpSecretEnc: input.totpSecretEnc,
          totpKeyVersion: input.totpKeyVersion,
          totpConfirmedAt: input.confirmedAt,
        })
        .returning();
      if (!row) throw new Error('Не удалось создать пользователя');
      if (input.recoveryCodes.length > 0)
        await tx.insert(recoveryCodes).values(input.recoveryCodes.map((c) => ({ userId: row.id, ...c })));
      await tx.update(setupTokens).set({ usedAt: input.confirmedAt }).where(isNull(setupTokens.usedAt));
      return row;
    });
  }

  async confirmTotp(userId: string, at: Date): Promise<void> {
    await this.db.update(users).set({ totpConfirmedAt: at }).where(eq(users.id, userId));
  }

  async setPassword(userId: string, passwordHash: string): Promise<void> {
    await this.db
      .update(users)
      .set({ passwordHash, passwordChangedAt: new Date() })
      .where(eq(users.id, userId));
  }

  async disableTotp(userId: string): Promise<void> {
    await this.db
      .update(users)
      .set({ totpSecretEnc: null, totpConfirmedAt: null })
      .where(eq(users.id, userId));
  }

  /* ---------- recovery codes ---------- */

  async replaceRecoveryCodes(userId: string, entries: RecoveryCodeEntry[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
      if (entries.length > 0) await tx.insert(recoveryCodes).values(entries.map((c) => ({ userId, ...c })));
    });
  }

  /** Все коды пользователя (для повторного показа), в порядке выпуска. */
  async listRecoveryCodes(
    userId: string,
  ): Promise<Array<{ id: string; codeEnc: string | null; usedAt: Date | null }>> {
    return this.db
      .select({ id: recoveryCodes.id, codeEnc: recoveryCodes.codeEnc, usedAt: recoveryCodes.usedAt })
      .from(recoveryCodes)
      .where(eq(recoveryCodes.userId, userId))
      .orderBy(asc(recoveryCodes.position), asc(recoveryCodes.createdAt));
  }

  async listUnusedRecoveryCodes(userId: string): Promise<Array<{ id: string; codeHash: string }>> {
    return this.db
      .select({ id: recoveryCodes.id, codeHash: recoveryCodes.codeHash })
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
      .orderBy(asc(recoveryCodes.createdAt));
  }

  async markRecoveryCodeUsed(id: string): Promise<void> {
    await this.db.update(recoveryCodes).set({ usedAt: new Date() }).where(eq(recoveryCodes.id, id));
  }

  async countUnusedRecoveryCodes(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));
    return row?.n ?? 0;
  }

  /* ---------- trusted devices ---------- */

  async findTrustedDevice(tokenHash: string): Promise<TrustedDeviceRow | undefined> {
    return this.db.query.trustedDevices.findFirst({ where: eq(trustedDevices.tokenHash, tokenHash) });
  }

  async touchTrustedDevice(id: string): Promise<void> {
    await this.db.update(trustedDevices).set({ lastUsedAt: new Date() }).where(eq(trustedDevices.id, id));
  }

  /** Добавляет устройство; если их больше max — удаляет самые старые. */
  async addTrustedDevice(
    input: { userId: string; tokenHash: string; userAgent: string; ipPrefix: string; expiresAt: Date },
    max: number,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(trustedDevices).values(input);
      const rows = await tx
        .select({ id: trustedDevices.id })
        .from(trustedDevices)
        .where(eq(trustedDevices.userId, input.userId))
        .orderBy(asc(trustedDevices.createdAt));
      const excess = rows.slice(0, Math.max(0, rows.length - max));
      for (const r of excess) await tx.delete(trustedDevices).where(eq(trustedDevices.id, r.id));
    });
  }

  async listTrustedDevices(userId: string): Promise<TrustedDeviceRow[]> {
    return this.db
      .select()
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, userId))
      .orderBy(desc(trustedDevices.lastUsedAt));
  }

  /** Перевыпуск 2FA: новый зашифрованный секрет, подтверждённый кодом. */
  async replaceTotp(
    userId: string,
    totpSecretEnc: string,
    totpKeyVersion: number,
    confirmedAt: Date,
  ): Promise<void> {
    await this.db
      .update(users)
      .set({ totpSecretEnc, totpKeyVersion, totpConfirmedAt: confirmedAt })
      .where(eq(users.id, userId));
  }

  async deleteTrustedDevices(userId: string): Promise<void> {
    await this.db.delete(trustedDevices).where(eq(trustedDevices.userId, userId));
  }

  async deleteTrustedDevice(id: string): Promise<void> {
    await this.db.delete(trustedDevices).where(eq(trustedDevices.id, id));
  }

  /* ---------- setup tokens ---------- */

  async hasUnusedSetupToken(): Promise<boolean> {
    const [row] = await this.db.select({ n: count() }).from(setupTokens).where(isNull(setupTokens.usedAt));
    return (row?.n ?? 0) > 0;
  }

  /** Новый токен делает все предыдущие неиспользованные недействительными. */
  async replaceSetupToken(tokenHash: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(setupTokens).set({ usedAt: new Date() }).where(isNull(setupTokens.usedAt));
      await tx.insert(setupTokens).values({ tokenHash });
    });
  }

  async listUnusedSetupTokens(): Promise<Array<{ id: string; tokenHash: string }>> {
    return this.db
      .select({ id: setupTokens.id, tokenHash: setupTokens.tokenHash })
      .from(setupTokens)
      .where(isNull(setupTokens.usedAt));
  }

  async markSetupTokenUsed(id: string): Promise<void> {
    await this.db.update(setupTokens).set({ usedAt: new Date() }).where(eq(setupTokens.id, id));
  }
}
