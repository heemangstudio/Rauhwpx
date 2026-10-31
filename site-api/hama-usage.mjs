import { promises as fs } from 'node:fs';
import path from 'node:path';

import { defineTable } from './pg-store.mjs';

/**
 * The Hama usage log: one entry per billed call `{at, id, route, provider, model, inputTokens,
 * outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, costSource}`, written after the ledger
 * commits. As JSONL files (`hama-usage/<keyId>.jsonl`) or as hama_usage rows in Postgres mode.
 *
 *   append(keyId, entry)  adds one entry
 *   read(keyId, limit)    → the newest `limit` entries, newest first
 */

const MAX_USAGE_LOG_BYTES = 4 * 1024 * 1024;

/** Usage log file name for a key id: anything outside [A-Za-z0-9_-] becomes `_`. */
export function usageLogName(keyId) {
  return `${String(keyId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) || '_'}.jsonl`;
}

/**
 * Past MAX_USAGE_LOG_BYTES a file becomes `<key>.1.jsonl` (one generation kept). Appends run one at a
 * time so a rotation never races another write. Lines that do not parse are skipped.
 */
export function createFileUsageLog(dir) {
  const logPath = (keyId) => path.join(dir, usageLogName(keyId));
  const rotatedPath = (keyId) => logPath(keyId).replace(/\.jsonl$/, '.1.jsonl');
  let appending = Promise.resolve();

  return {
    append(keyId, entry) {
      const run = appending.then(async () => {
        await fs.mkdir(dir, { recursive: true });
        const file = logPath(keyId);
        const size = await fs.stat(file).then((s) => s.size, () => 0);
        if (size > MAX_USAGE_LOG_BYTES) await fs.rename(file, rotatedPath(keyId));
        await fs.appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      });
      appending = run.catch(() => {});
      return run;
    },
    async read(keyId, limit) {
      const lines = [];
      for (const file of [logPath(keyId), rotatedPath(keyId)]) {
        const text = await fs.readFile(file, 'utf8').catch(() => '');
        const parsed = text.split('\n').filter(Boolean).reverse().map((l) => {
          try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean);
        lines.push(...parsed);
        if (lines.length >= limit) break;
      }
      return lines.slice(0, limit);
    },
  };
}

const USAGE = defineTable('hama_usage', {
  key: ['key_id'],
  given: { key_id: 'text' },
  fields: {
    at: ['time', 'at'],
    call_id: ['text', 'id'],
    route: ['text', 'route'],
    provider: ['text', 'provider'],
    model: ['text', 'model'],
    input_tokens: ['int', 'inputTokens'],
    output_tokens: ['int', 'outputTokens'],
    cache_read_tokens: ['int', 'cacheReadTokens'],
    cache_write_tokens: ['int', 'cacheWriteTokens'],
    cost_usd: ['double', 'costUsd'],
    cost_source: ['text', 'costSource'],
  },
});
const USAGE_COLUMNS = USAGE.columns.map((c) => `"${c}"`).join(', ');

/**
 * One row per entry, read back exactly as the JSON line would (a value that does not fit its column,
 * an explicit null, stays in `extra`). Rows are never updated or pruned.
 */
export function createPostgresUsageLog(db) {
  return {
    async append(keyId, entry) {
      await db.ready();
      // What a JSON line would hold: undefined dropped, -0 → 0.
      const row = USAGE.pack(JSON.parse(JSON.stringify(entry)), { key_id: String(keyId) });
      await db.query(
        `INSERT INTO hama_usage (${USAGE_COLUMNS}) VALUES (${USAGE.columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        USAGE.columns.map((column) => USAGE.encode(column, row[column])),
      );
    },
    async read(keyId, limit) {
      await db.ready();
      const { rows } = await db.query(
        `SELECT ${USAGE_COLUMNS} FROM hama_usage WHERE key_id = $1 ORDER BY seq DESC LIMIT $2`,
        [String(keyId), limit],
      );
      return rows.map((row) => USAGE.unpack(row));
    },
  };
}
