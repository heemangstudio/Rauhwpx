import { checkRoot, defineTable, isPlainObject, mapEntries, setOwn, storeMisfit } from '../pg-store.mjs';

/**
 * downloads.json `{ days: { [KST day]: { ['platform|version']: count } } }` ↔ download_counts
 * (migrations/002), one row per day and `platform|version`. A day exists only through its counts:
 * record() always counts one download in the day it adds and pruning drops whole days, so an empty
 * day cannot be stored and is refused.
 */

const DOWNLOADS = defineTable('download_counts', {
  key: ['day', 'key'],
  group: ['day'],
  given: { day: 'date', key: 'text' },
  fields: { count: ['int', 'count'] },
});

export const downloadsMapper = Object.freeze({
  domain: 'downloads',
  tables: [DOWNLOADS],
  toRows(state) {
    checkRoot('downloads', state, ['days']);
    const rows = [];
    for (const [day, counts] of mapEntries('downloads', 'days', state.days)) {
      if (!isPlainObject(counts)) throw storeMisfit(`download_counts (${day}): counts are not an object`);
      const entries = Object.entries(counts).filter(([, count]) => count !== undefined);
      if (!entries.length) throw storeMisfit(`download_counts (${day}): a day without counts`);
      for (const [key, count] of entries) rows.push(DOWNLOADS.pack({ count }, { day, key }));
    }
    return { download_counts: rows };
  },
  fromRows(rows) {
    const state = { days: {} };
    for (const row of rows.download_counts) {
      if (!Object.hasOwn(state.days, row.day)) setOwn(state.days, row.day, {});
      setOwn(state.days[row.day], row.key, DOWNLOADS.unpack(row).count);
    }
    return state;
  },
});
