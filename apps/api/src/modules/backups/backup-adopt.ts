import type pg from 'pg';

import type { CryptoService } from '../../common/crypto/crypto.service.js';

/**
 * Перенос копии от другой установки (например, со старой панели на новый сервер). У каждой установки свои
 * ключи шифрования, а свои ключи панель заменить не может: они в .env на сервере, закрытом от неё. Поэтому
 * данные копии перешифровываются ключом этой панели — во временной базе, до подмены. Вход остаётся
 * нынешний: пароль сверяется с солью из ключей установки, и пароль копии здесь всё равно бы не подошёл.
 */

/**
 * Шифротекст панели (CryptoService.encrypt): v{версия ключа}:{iv, 12 байт}:{tag, 16 байт}:{данные}, base64url.
 * Пустые данные панель и сама не расшифровывает — такие значения не трогаем.
 */
const CIPHERTEXT = /(?<![A-Za-z0-9_-])v\d+:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]+/g;
/** Отбор строк в базе — грубее: точную границу шифротекста проверяет CIPHERTEXT. */
const CIPHERTEXT_SQL = 'v[0-9]+:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:';

/** Таблицы входа: остаются от этой панели. Первой — users: на неё ссылаются остальные. */
export const LOGIN_TABLES = ['users', 'recovery_codes', 'trusted_devices'] as const;

export interface ReencryptResult {
  text: string;
  /** Сколько шифротекстов перешифровано. */
  reencrypted: number;
  /** Сколько похожих на шифротекст значений ключ копии не прочитал — они оставлены как были. */
  unreadable: number;
}

/** Каждый шифротекст копии в строке (поле целиком или внутри JSON настроек) — ключом этой панели. */
export function reencryptText(text: string, from: CryptoService, to: CryptoService): ReencryptResult {
  let reencrypted = 0;
  let unreadable = 0;
  const out = text.replace(CIPHERTEXT, (found) => {
    let plain: string;
    try {
      plain = from.decrypt(found);
    } catch {
      unreadable += 1;
      return found;
    }
    reencrypted += 1;
    return to.encrypt(plain);
  });
  return { text: out, reencrypted, unreadable };
}

const ident = (s: string) => `"${s.replaceAll('"', '""')}"`;

async function columns(client: pg.ClientBase, table: string): Promise<string[]> {
  const r = await client.query<{ name: string }>(
    `select column_name as name from information_schema.columns
      where table_schema = 'public' and table_name = $1 order by ordinal_position`,
    [table],
  );
  return r.rows.map((x) => x.name);
}

/** Все шифротексты копии — ключом этой панели. Таблицы входа пропускаются: их заменит takeLogin. */
async function reencryptAll(
  copy: pg.ClientBase,
  from: CryptoService,
  to: CryptoService,
): Promise<Omit<ReencryptResult, 'text'>> {
  const total = { reencrypted: 0, unreadable: 0 };
  // Обычные таблицы и разделы таблиц (relkind 'r'); у родителя разделов своих строк нет. Журнал действий
  // не трогаем: менять его записи запрещает сама база (триггер audit_log_readonly), и секретов в нём нет.
  const cols = await copy.query<{ tbl: string; col: string; type: string }>(
    `select c.relname as tbl, a.attname as col, format_type(a.atttypid, a.atttypmod) as type
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid
      where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
        and a.attgenerated = ''
        and a.atttypid in ('text'::regtype, 'varchar'::regtype, 'json'::regtype, 'jsonb'::regtype)
        and c.relname <> 'audit_log'
        and not exists (
          select 1 from pg_inherits i where i.inhrelid = c.oid and i.inhparent = to_regclass('public.audit_log')
        )
      order by 1, 2`,
  );
  const login: readonly string[] = LOGIN_TABLES;
  for (const { tbl, col, type } of cols.rows) {
    if (login.includes(tbl)) continue;
    const found = await copy.query<{ id: string; v: string }>(
      `select ctid::text as id, ${ident(col)}::text as v from public.${ident(tbl)} where ${ident(col)}::text ~ $1`,
      [CIPHERTEXT_SQL],
    );
    for (const row of found.rows) {
      const r = reencryptText(row.v, from, to);
      total.reencrypted += r.reencrypted;
      total.unreadable += r.unreadable;
      // Тип — из каталога базы (text, jsonb…): строка возвращается в том же виде.
      if (r.reencrypted > 0)
        await copy.query(`update public.${ident(tbl)} set ${ident(col)} = $1::${type} where ctid = $2::tid`, [
          r.text,
          row.id,
        ]);
    }
  }
  return total;
}

/**
 * Вход — нынешний: администратор копии уходит вместе со своими кодами и устройствами (ссылки на него —
 * с каскадом), на его место — записи этой панели. Колонки — общие для обеих баз: копия бывает старее.
 */
async function takeLogin(copy: pg.ClientBase, current: pg.ClientBase): Promise<void> {
  await copy.query('delete from public.users');
  for (const table of LOGIN_TABLES) {
    const have = new Set(await columns(current, table));
    const cols = (await columns(copy, table)).filter((c) => have.has(c));
    if (cols.length === 0) continue;
    const list = cols.map(ident).join(', ');
    const rows = await current.query<{ rows: unknown }>(
      `select coalesce(json_agg(t), '[]'::json) as rows from (select ${list} from public.${ident(table)}) t`,
    );
    await copy.query(
      `insert into public.${ident(table)} (${list})
       select ${list} from json_populate_recordset(null::public.${ident(table)}, $1::json)`,
      [JSON.stringify(rows.rows[0]?.rows ?? [])],
    );
  }
}

/**
 * Развёрнутую копию другой установки (copy — временная база) — к этой панели: шифротексты её ключом from
 * перешифровываются ключом to, вход берётся из нынешней базы (current). Вызывается до подмены базы: сбой
 * здесь оставляет рабочую базу нетронутой.
 */
export async function adoptForeignCopy(
  copy: pg.ClientBase,
  current: pg.ClientBase,
  from: CryptoService,
  to: CryptoService,
): Promise<Omit<ReencryptResult, 'text'>> {
  await copy.query('BEGIN');
  try {
    const result = await reencryptAll(copy, from, to);
    await takeLogin(copy, current);
    await copy.query('COMMIT');
    return result;
  } catch (err) {
    await copy.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}
