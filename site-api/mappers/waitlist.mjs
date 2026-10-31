import { checkRoot, defineTable, mapEntries, setOwn } from '../pg-store.mjs';

/** waitlist.json `{ entries: { [email lower]: { email, joinedAt } } }` ↔ waitlist_entries (migrations/002). */

const WAITLIST = defineTable('waitlist_entries', {
  key: ['email_lower'],
  secretKey: true,
  given: { email_lower: 'text' },
  fields: {
    email: ['text', 'email'],
    joined_at: ['time', 'joinedAt'],
  },
});

export const waitlistMapper = Object.freeze({
  domain: 'waitlist',
  tables: [WAITLIST],
  toRows(state) {
    checkRoot('waitlist', state, ['entries']);
    return {
      waitlist_entries: mapEntries('waitlist', 'entries', state.entries)
        .map(([emailLower, entry]) => WAITLIST.pack(entry, { email_lower: emailLower })),
    };
  },
  fromRows(rows) {
    const state = { entries: {} };
    for (const row of rows.waitlist_entries) setOwn(state.entries, row.email_lower, WAITLIST.unpack(row));
    return state;
  },
});
