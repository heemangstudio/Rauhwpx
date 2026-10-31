import { checkRoot, defineTable, mapEntries, setOwn } from '../pg-store.mjs';

/**
 * unique-installs.json `{ installs: { [sha256(installId)]: { official, firstSeenAt, appVersion, os, arch } } }`
 * ↔ unique_installs (migrations/002). licenses.mjs reads it for grandfathering.
 */

const INSTALLS = defineTable('unique_installs', {
  key: ['install_digest'],
  given: { install_digest: 'text' },
  fields: {
    official: ['bool', 'official'],
    first_seen_at: ['time', 'firstSeenAt'],
    app_version: ['text', 'appVersion'],
    os: ['text', 'os'],
    arch: ['text', 'arch'],
  },
});

export const uniqueInstallsMapper = Object.freeze({
  domain: 'unique_installs',
  tables: [INSTALLS],
  toRows(state) {
    checkRoot('unique_installs', state, ['installs']);
    return {
      unique_installs: mapEntries('unique_installs', 'installs', state.installs)
        .map(([digest, install]) => INSTALLS.pack(install, { install_digest: digest })),
    };
  },
  fromRows(rows) {
    const state = { installs: {} };
    for (const row of rows.unique_installs) setOwn(state.installs, row.install_digest, INSTALLS.unpack(row));
    return state;
  },
});
