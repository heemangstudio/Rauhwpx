import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { syncDirectory } from './store.mjs';

/**
 * Account profile pictures, as files (`avatars/<accountId>.<ext>`) or as account_avatars rows in
 * Postgres mode. The account record keeps rev, type and size; these keep the bytes.
 *
 *   put(accountId, type, bytes, tx?)  stores the picture
 *   get(accountId, type)              → its bytes, or null
 *   prune(accountId, keepType, tx?)   removes every picture of the account except `keepType` (null: all)
 *
 * `tx` is the accounts store's update transaction (pg-store.mjs), so in Postgres mode the bytes
 * commit or roll back with the record. The file version ignores it.
 */

/** Accepted picture types and their file extensions. */
export const AVATAR_TYPES = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' });
const ACCOUNT_ID_RE = /^acct_[0-9a-f]{18}$/;

export function createFileAvatars(dir) {
  function avatarPath(accountId, ext) {
    if (!dir || !ACCOUNT_ID_RE.test(accountId)) throw new Error('avatar path unavailable');
    return path.join(dir, `${accountId}.${ext}`);
  }

  /** Temp file, fsync, rename, mode 0600: a reader never sees half a picture. */
  async function put(accountId, type, bytes) {
    const file = avatarPath(accountId, AVATAR_TYPES[type]);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
    let handle;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temp, file);
      await syncDirectory(dir);
    } catch (error) {
      await handle?.close().catch(() => {});
      await fs.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function get(accountId, type) {
    return fs.readFile(avatarPath(accountId, AVATAR_TYPES[type])).catch(() => null);
  }

  async function prune(accountId, keepType) {
    for (const [type, ext] of Object.entries(AVATAR_TYPES)) {
      if (type !== keepType) await fs.rm(avatarPath(accountId, ext), { force: true });
    }
  }

  return { put, get, prune };
}

/** One row per account; a new picture replaces the old one whatever its type. */
export function createPostgresAvatars(db) {
  return {
    async put(accountId, type, bytes, tx) {
      await (tx ?? db).query(
        `INSERT INTO account_avatars (account_id, type, bytes) VALUES ($1, $2, $3)
         ON CONFLICT (account_id) DO UPDATE SET type = EXCLUDED.type, bytes = EXCLUDED.bytes, updated_at = now()`,
        [accountId, type, bytes],
      );
    },
    async get(accountId, type) {
      await db.ready();
      const { rows } = await db.query('SELECT bytes FROM account_avatars WHERE account_id = $1 AND type = $2', [accountId, type]);
      return rows[0]?.bytes ?? null;
    },
    async prune(accountId, keepType, tx) {
      if (!tx) await db.ready();
      await (tx ?? db).query(
        'DELETE FROM account_avatars WHERE account_id = $1 AND ($2::text IS NULL OR type <> $2::text)',
        [accountId, keepType ?? null],
      );
    },
  };
}
