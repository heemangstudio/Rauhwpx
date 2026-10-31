import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { emptyAccountsState } from './accounts.mjs';
import { AVATAR_TYPES } from './avatars.mjs';
import {
  resolveAccountsDbPath,
  resolveAvatarDir,
  resolveDataDir,
  resolveDownloadsDbPath,
  resolveFeedbackDir,
  resolveGiftsDbPath,
  resolveHamaDbPath,
  resolveLicensesDbPath,
  resolveRauDbPath,
  resolveUniqueInstallsDbPath,
  resolveWaitlistDbPath,
  resolveWebhookLogDbPath,
} from './config.mjs';
import { emptyDownloadsState } from './downloads.mjs';
import { emptyFeedbackIndex } from './feedback.mjs';
import { emptyGiftsState } from './gifts.mjs';
import { emptyLicensesState } from './licenses.mjs';
import { accountsMapper } from './mappers/accounts.mjs';
import { downloadsMapper } from './mappers/downloads.mjs';
import { feedbackMapper } from './mappers/feedback.mjs';
import { giftsMapper } from './mappers/gifts.mjs';
import { hamaMapper } from './mappers/hama.mjs';
import { licensesMapper } from './mappers/licenses.mjs';
import { rauMapper } from './mappers/rau.mjs';
import { uniqueInstallsMapper } from './mappers/unique-installs.mjs';
import { waitlistMapper } from './mappers/waitlist.mjs';
import { webhookLogMapper } from './mappers/webhook-log.mjs';
import { canonicalJson, createPostgresStore, isPlainObject, setOwn } from './pg-store.mjs';
import { emptyRauState } from './rau.mjs';
import { createFileStore } from './store.mjs';
import { emptyUniqueInstallsState } from './unique-installs.mjs';
import { emptyWaitlistState } from './waitlist.mjs';
import { emptyWebhookLogState } from './webhook-log.mjs';

/**
 * The one-time move of the JSON files on RAU_SITE_DATA into Postgres. On startup with DATABASE_URL
 * (and from scripts/import-json-to-postgres.mjs) every domain whose file holds data and that Postgres
 * never had is written in one transaction through its mapper (createPostgresStore().update), under
 * the domain's advisory lock, so concurrent processes import it once. In the same transaction the
 * rows are counted and read back; any difference from the JSON rolls the domain back and refuses to
 * start. A `json_import:<domain>` row in site_meta records the counts. The files are only read: they
 * stay the rollback (unset DATABASE_URL).
 */

const MARKER_PREFIX = 'json_import:';

class DryRunRollback extends Error {}

/**
 * Every domain with a Postgres mapping and the file it replaces; profile pictures go with accounts.
 * hama.json is frozen but still a source of Rau grants (hama-legacy.mjs), so it is imported too. The
 * old plan's usage logs (`hama-usage/`) are read by nothing and stay behind, as do feedback attachments.
 */
export function importSources(env = process.env) {
  return [
    { mapper: licensesMapper, file: resolveLicensesDbPath(env), emptyState: emptyLicensesState },
    { mapper: accountsMapper, file: resolveAccountsDbPath(env), emptyState: emptyAccountsState, avatarDir: resolveAvatarDir(env) },
    { mapper: webhookLogMapper, file: resolveWebhookLogDbPath(env), emptyState: emptyWebhookLogState },
    { mapper: hamaMapper, file: resolveHamaDbPath(env), emptyState: () => ({ plans: {}, ledgers: {} }) },
    { mapper: rauMapper, file: resolveRauDbPath(env), emptyState: emptyRauState },
    { mapper: giftsMapper, file: resolveGiftsDbPath(env), emptyState: emptyGiftsState },
    { mapper: waitlistMapper, file: resolveWaitlistDbPath(env), emptyState: emptyWaitlistState },
    { mapper: uniqueInstallsMapper, file: resolveUniqueInstallsDbPath(env), emptyState: emptyUniqueInstallsState },
    { mapper: downloadsMapper, file: resolveDownloadsDbPath(env), emptyState: emptyDownloadsState },
    { mapper: feedbackMapper, file: path.join(resolveFeedbackDir(env), 'index.json'), emptyState: emptyFeedbackIndex },
  ];
}

async function isNonEmptyFile(file) {
  const info = await stat(file).catch(() => null);
  return Boolean(info?.isFile() && info.size > 0);
}

/** The path of a source's file relative to the data directory, as a list: empty when it holds no data. */
async function filesWithData(source, env) {
  return await isNonEmptyFile(source.file) ? [path.relative(resolveDataDir(env), source.file)] : [];
}

/**
 * The picture of every account whose record names one: `avatars/<accountId>.<ext>` for its
 * avatar.type. Files of other types or of unknown accounts (a prune that failed) are counted, not imported.
 */
async function readAvatars(dir, state) {
  const avatars = [];
  const names = new Set(dir ? await readdir(dir).catch(() => []) : []);
  for (const [accountId, account] of Object.entries(isPlainObject(state?.accounts) ? state.accounts : {})) {
    const type = account?.avatar?.type;
    if (!Object.hasOwn(AVATAR_TYPES, type)) continue;
    const name = `${accountId}.${AVATAR_TYPES[type]}`;
    if (!names.has(name)) continue;
    avatars.push({ accountId, type, bytes: await readFile(path.join(dir, name)) });
    names.delete(name);
  }
  const skipped = [...names].filter((name) => /\.(jpg|png|webp)$/.test(name)).length;
  return { avatars, skipped };
}

function rowCounts(tables, rowsByTable) {
  return Object.fromEntries(tables.map((table) => [table.name, (rowsByTable[table.name] ?? []).length]));
}

async function countRows(tx, table) {
  const { rows } = await tx.query(`SELECT count(*)::int AS n FROM "${table}"`);
  return rows[0].n;
}

async function readBack(tx, tables) {
  const rowsByTable = {};
  for (const table of tables) {
    const columns = table.columns.map((c) => `"${c}"`).join(', ');
    rowsByTable[table.name] = (await tx.query(`SELECT ${columns} FROM "${table.name}" ORDER BY "seq"`)).rows;
  }
  return rowsByTable;
}

function importError(domain, message) {
  return Object.assign(new Error(`JSON import of ${domain} rolled back: ${message}. Unset DATABASE_URL to keep serving the JSON files.`), { code: 'json_import_failed' });
}

/** Whether Postgres already holds the domain: imported before, or written by a server since. */
async function holdsDomain(tx, domain) {
  const { rows } = await tx.query(
    `SELECT EXISTS (SELECT 1 FROM site_store_versions WHERE domain = $1)
         OR EXISTS (SELECT 1 FROM site_meta WHERE key = $2) AS held`,
    [domain, `${MARKER_PREFIX}${domain}`],
  );
  return rows[0].held;
}

function held(domain, files, log) {
  log(`[site-api] JSON import ${domain}: already in Postgres, ${files.join(', ')} left as is`);
  return { domain, status: 'held' };
}

function describe(tables) {
  return Object.entries(tables).map(([name, n]) => `${name} ${n}`).join(', ');
}

/**
 * The JSON as the mapper can hold it: verbatim when it can, else with the top-level maps a file
 * written before they existed lacks added empty, as the service does on its first read. Mappers with
 * a roots table (accounts, rau) keep a missing map missing.
 */
function storable(mapper, json, emptyState) {
  try {
    mapper.toRows(json);
    return json;
  } catch (error) {
    const filled = structuredClone(json);
    for (const [key, value] of Object.entries(emptyState())) if (!Object.hasOwn(filled, key)) setOwn(filled, key, value);
    try {
      mapper.toRows(filled);
    } catch {
      throw error;
    }
    return filled;
  }
}

/**
 * Imports one domain. Resolves to `{ domain, status, tables, skippedAvatars? }` with
 * status `empty` (no file holds data), `held` (Postgres already has it), `imported` or `dry-run`.
 */
async function importDomain(db, source, env, { dryRun, log }) {
  const { mapper } = source;
  const { domain } = mapper;
  const files = await filesWithData(source, env);
  if (!files.length) return { domain, status: 'empty' };
  // Checked again under the domain's lock; this one spares a restart reading the files.
  if (await holdsDomain(db, domain)) return held(domain, files, log);

  const raw = await createFileStore(source.file, { emptyState: source.emptyState }).read().catch((error) => {
    throw importError(domain, `${path.basename(source.file)} could not be read (${error?.message ?? error})`);
  });
  if (!isPlainObject(raw)) throw importError(domain, `${path.basename(source.file)} is not a JSON object`);
  let json;
  let expected;
  try {
    json = storable(mapper, raw, source.emptyState);
    expected = rowCounts(mapper.tables, mapper.toRows(json));
  } catch (error) {
    throw importError(domain, `the JSON does not fit the tables (${error?.message ?? error})`);
  }
  const avatars = source.avatarDir ? await readAvatars(source.avatarDir, json) : null;
  if (avatars) expected.account_avatars = avatars.avatars.length;

  let report = null;
  const store = createPostgresStore({ db, mapper });
  try {
    await store.update(async (state, tx) => {
      if (await holdsDomain(tx, domain)) return { dirty: false, held: true };
      for (const key of Object.keys(state)) delete state[key];
      for (const [key, value] of Object.entries(structuredClone(json))) setOwn(state, key, value);
      return { held: false };
    }, {
      async afterSave(result, tx) {
        if (result.held) return;
        // Pictures after the save, so their account rows exist.
        for (const { accountId, type, bytes } of avatars?.avatars ?? []) {
          await tx.query('INSERT INTO account_avatars (account_id, type, bytes) VALUES ($1, $2, $3)', [accountId, type, bytes]);
        }
        const written = {};
        for (const table of Object.keys(expected)) written[table] = await countRows(tx, table);
        for (const [table, n] of Object.entries(expected)) {
          if (written[table] !== n) throw importError(domain, `${table} has ${n} JSON records but ${written[table]} rows`);
        }
        if (canonicalJson(mapper.fromRows(await readBack(tx, mapper.tables))) !== canonicalJson(json)) {
          throw importError(domain, 'the rows read back differ from the JSON');
        }
        const marker = {
          importedAt: new Date().toISOString(),
          tables: written,
          ...(avatars ? { skippedAvatars: avatars.skipped } : {}),
        };
        await tx.query('INSERT INTO site_meta (key, value) VALUES ($1, $2)', [`${MARKER_PREFIX}${domain}`, JSON.stringify(marker)]);
        report = { domain, status: dryRun ? 'dry-run' : 'imported', ...marker };
        if (dryRun) throw new DryRunRollback();
      },
    });
  } catch (error) {
    if (error?.code === 'json_import_failed') throw error;
    if (!(error instanceof DryRunRollback)) throw Object.assign(importError(domain, error?.message ?? String(error)), { cause: error });
  }
  if (!report) return held(domain, files, log);
  const extra = report.skippedAvatars ? ` (${report.skippedAvatars} unreferenced pictures skipped)` : '';
  log(`[site-api] JSON import ${domain}: ${dryRun ? 'would write' : 'wrote'} ${describe(report.tables)} from ${files.join(', ')}${extra}`);
  return report;
}

/**
 * Imports every domain not yet in Postgres, one transaction each, stopping at the first that fails
 * (domains imported before it stay imported; a rerun continues). `dryRun` does all of it, checks
 * included, and rolls every transaction back. Resolves to the per-domain reports.
 */
export async function importJsonToPostgres(db, env = process.env, { dryRun = false, log = () => {} } = {}) {
  await db.ready();
  const reports = [];
  for (const source of importSources(env)) reports.push(await importDomain(db, source, env, { dryRun, log }));
  return reports;
}

/** The `json_import:<domain>` markers: `{ [domain]: { importedAt, tables, ... } }`. */
export async function importMarkers(db) {
  const { rows } = await db.query('SELECT key, value FROM site_meta WHERE key LIKE $1 ORDER BY key', [`${MARKER_PREFIX}%`]);
  return Object.fromEntries(rows.map((row) => [row.key.slice(MARKER_PREFIX.length), row.value]));
}

/**
 * Refuses Postgres mode while a JSON file holds data its domain never got: serving without it would
 * start every customer from an empty database. Runs after the import, as its safety net.
 */
export async function checkImported(db, env = process.env) {
  const { rows } = await db.query(
    `SELECT domain FROM site_store_versions
     UNION SELECT substr(key, ${MARKER_PREFIX.length + 1}) FROM site_meta WHERE key LIKE $1`,
    [`${MARKER_PREFIX}%`],
  );
  const held = new Set(rows.map((row) => row.domain));
  const missing = [];
  for (const source of importSources(env)) {
    if (!held.has(source.mapper.domain)) missing.push(...await filesWithData(source, env));
  }
  if (missing.length) {
    throw new Error(`DATABASE_URL is set but ${missing.join(', ')} was never imported into Postgres. Import it first, or unset DATABASE_URL to keep the JSON files.`);
  }
}
