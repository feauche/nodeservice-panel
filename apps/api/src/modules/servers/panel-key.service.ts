import { createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { CryptoService } from '../../common/crypto/crypto.service.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';

const KEY = 'panel.ssh-key';
const COMMENT = 'nodeservice-panel';

export interface PanelSshKey {
  /** OpenSSH-формат — его понимает ssh2 и обычный ssh. */
  privateKeyOpenSsh: string;
  /** Строка для authorized_keys. */
  publicKeyLine: string;
}

/**
 * Один SSH-ключ панели (ed25519) на все серверы — как у Coolify. Генерируется при первом
 * обращении, приватная часть хранится в app_meta зашифрованной (AES-256-GCM, ENCRYPTION_KEY) —
 * попадает в бэкап БД вместе со всем остальным.
 */
@Injectable()
export class PanelKeyService {
  private readonly log = new Logger(PanelKeyService.name);
  private cache: PanelSshKey | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly crypto: CryptoService,
  ) {}

  async get(): Promise<PanelSshKey> {
    if (this.cache) return this.cache;
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, KEY) });
    if (row) {
      try {
        const parsed = JSON.parse(row.value) as { privateKeyEnc: string; publicKeyLine: string };
        this.cache = {
          privateKeyOpenSsh: this.crypto.decrypt(parsed.privateKeyEnc),
          publicKeyLine: parsed.publicKeyLine,
        };
        return this.cache;
      } catch (err) {
        // Повреждённая запись или сменившийся ENCRYPTION_KEY: не перегенерируем молча —
        // старый публичный ключ уже лежит на серверах, тихая замена оставит панель без доступа.
        this.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          'Не удалось прочитать SSH-ключ панели (сменился ENCRYPTION_KEY?)',
        );
        throw new Error(
          'SSH-ключ панели недоступен: проверь ENCRYPTION_KEY или восстанови app_meta из бэкапа',
        );
      }
    }
    const generated = this.generate();
    const serialized = JSON.stringify({
      privateKeyEnc: this.crypto.encrypt(generated.privateKeyOpenSsh),
      publicKeyLine: generated.publicKeyLine,
    });
    await this.db
      .insert(appMeta)
      .values({ key: KEY, value: serialized })
      .onConflictDoNothing({ target: appMeta.key });
    // Гонка двух запросов: перечитываем то, что реально записано.
    const winner = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, KEY) });
    if (winner && winner.value !== serialized) return this.get();
    this.cache = generated;
    this.log.log('Сгенерирован SSH-ключ панели (ed25519)');
    return generated;
  }

  async publicKeyLine(): Promise<string> {
    return (await this.get()).publicKeyLine;
  }

  private generate(): PanelSshKey {
    const { privateKey } = generateKeyPairSync('ed25519');
    return {
      privateKeyOpenSsh: toOpenSshPrivate(privateKey),
      publicKeyLine: toAuthorizedKeysLine(privateKey),
    };
  }
}

/* ---------- OpenSSH-формат ed25519 (node:crypto экспортирует только PKCS8, ssh2 его не читает) ---------- */

function sshString(data: Buffer | string): Buffer {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length);
  return Buffer.concat([len, b]);
}

function rawKeys(privateKey: KeyObject): { seed: Buffer; pub: Buffer } {
  const jwk = privateKey.export({ format: 'jwk' }) as { d?: string; x?: string };
  if (!jwk.d || !jwk.x) throw new Error('Ожидался ed25519-ключ');
  return { seed: Buffer.from(jwk.d, 'base64url'), pub: Buffer.from(jwk.x, 'base64url') };
}

/** RFC draft-miller-ssh-agent / PROTOCOL.key: незашифрованный openssh-key-v1 с одним ключом. */
export function toOpenSshPrivate(privateKey: KeyObject, comment = COMMENT): string {
  const { seed, pub } = rawKeys(privateKey);
  const pubBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(0x4e534b59);
  let priv = Buffer.concat([
    check,
    check,
    sshString('ssh-ed25519'),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(comment),
  ]);
  for (let i = 1; priv.length % 8 !== 0; i++) priv = Buffer.concat([priv, Buffer.from([i])]);
  const blob = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'latin1'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    Buffer.from([0, 0, 0, 1]),
    sshString(pubBlob),
    sshString(priv),
  ]);
  const b64 = blob.toString('base64').replace(/(.{70})/g, '$1\n');
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

export function toAuthorizedKeysLine(privateKey: KeyObject, comment = COMMENT): string {
  const { pub } = rawKeys(privateKey);
  const blob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]);
  return `ssh-ed25519 ${blob.toString('base64')} ${comment}`;
}

/** Для тестов: собрать KeyObject из PKCS8 PEM. */
export function privateKeyFromPem(pem: string): KeyObject {
  return createPrivateKey(pem);
}
