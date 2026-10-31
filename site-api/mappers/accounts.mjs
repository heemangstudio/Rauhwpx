import { checkRoot, defineTable, isPlainObject, mapEntries, setOwn, storeMisfit } from '../pg-store.mjs';

/**
 * accounts.json ↔ accounts, account_devices, account_sessions, account_logins, account_grants,
 * account_email_index, account_workos_index (migrations/001), account_trial_emails and account_roots
 * (migrations/003). The two indexes have their own rules (byEmail holds verified emails only and the
 * first account wins), so they are stored, not derived. `trialEmails` outlives the accounts it names.
 * account_roots says whether the state holds `trialEmails`: a file written before the Rau trial has
 * none; without its row (a new database) it does. Profile pictures are not part of the state:
 * avatars.mjs keeps them in account_avatars.
 */

const DOMAIN = 'accounts';
const ROOT = ['accounts', 'byWorkosUser', 'byEmail', 'sessions', 'logins', 'grants', 'trialEmails'];

const ROOTS = defineTable('account_roots', {
  key: ['id'],
  given: { id: 'text', has_trial_emails: 'bool' },
  extra: false,
});

const ACCOUNTS = defineTable('accounts', {
  key: ['id'],
  fields: {
    id: ['text', 'id', { required: true }],
    workos_user_id: ['text', 'workosUserId'],
    email: ['text', 'email'],
    email_lower: ['text', 'emailLower'],
    email_verified: ['bool', 'emailVerified'],
    name: ['text', 'name'],
    name_source: ['text', 'nameSource'],
    provider: ['text', 'provider'],
    avatar: ['object', 'avatar'],
    last_avatar_rev: ['int', 'lastAvatarRev'],
    stats: ['object', 'stats'],
    created_at: ['time', 'createdAt'],
    last_sign_in_at: ['time', 'lastSignInAt'],
    rau_trial: ['object', 'rauTrial'],
  },
});

const DEVICES = defineTable('account_devices', {
  key: ['account_id', 'device_id'],
  group: ['account_id'],
  given: { account_id: 'text', device_id: 'text' },
  fields: {
    name: ['text', 'name'],
    platform: ['text', 'platform'],
    app_version: ['text', 'appVersion'],
    added_at: ['time', 'addedAt'],
    last_seen_at: ['time', 'lastSeenAt'],
    session_hash: ['text', 'sessionHash'],
  },
});

const SESSIONS = defineTable('account_sessions', {
  key: ['token_hash'],
  secretKey: true,
  given: { token_hash: 'text' },
  fields: {
    account_id: ['text', 'accountId'],
    device_id: ['text', 'deviceId'],
    created_at: ['time', 'createdAt'],
    last_used_at: ['time', 'lastUsedAt'],
  },
});

const LOGINS = defineTable('account_logins', {
  key: ['login_id'],
  secretKey: true,
  given: { login_id: 'text' },
  fields: {
    provider: ['text', 'provider'],
    challenge: ['text', 'challenge'],
    app_state: ['text', 'appState'],
    port: ['int', 'port'],
    created_at: ['time', 'createdAt'],
    expires_at: ['time', 'expiresAt'],
  },
});

const GRANTS = defineTable('account_grants', {
  key: ['grant_hash'],
  secretKey: true,
  given: { grant_hash: 'text' },
  fields: {
    account_id: ['text', 'accountId'],
    challenge: ['text', 'challenge'],
    attempts: ['int', 'attempts'],
    created_at: ['time', 'createdAt'],
    expires_at: ['time', 'expiresAt'],
  },
});

const EMAIL_INDEX = defineTable('account_email_index', {
  key: ['email_lower'],
  secretKey: true,
  given: { email_lower: 'text', account_id: 'text' },
  extra: false,
});

const WORKOS_INDEX = defineTable('account_workos_index', {
  key: ['workos_user_id'],
  given: { workos_user_id: 'text', account_id: 'text' },
  extra: false,
});

const TRIAL_EMAILS = defineTable('account_trial_emails', {
  key: ['email_hash'],
  secretKey: true,
  given: { email_hash: 'text' },
  fields: {
    account_id: ['text', 'accountId'],
    started_at: ['time', 'startedAt'],
  },
});

function toRows(state) {
  checkRoot(DOMAIN, state, ROOT);
  const hasTrialEmails = state.trialEmails !== undefined;
  const rows = {
    account_roots: [ROOTS.pack(null, { id: DOMAIN, has_trial_emails: hasTrialEmails })],
    accounts: [],
    account_devices: [],
    account_sessions: [],
    account_logins: [],
    account_grants: [],
    account_email_index: [],
    account_workos_index: [],
    account_trial_emails: [],
  };
  for (const [id, account] of mapEntries(DOMAIN, 'accounts', state.accounts)) {
    if (!isPlainObject(account) || account.id !== id) throw storeMisfit(`accounts (${id}): not an account with this id`);
    const { devices, ...rest } = account;
    if (isPlainObject(devices)) {
      for (const [deviceId, device] of Object.entries(devices)) {
        rows.account_devices.push(DEVICES.pack(device, { account_id: id, device_id: deviceId }));
      }
    } else if (devices === undefined) {
      // upsertAccount always sets it, so an absent map cannot be told from an empty one.
      throw storeMisfit(`accounts (${id}): devices is missing`);
    } else {
      setOwn(rest, 'devices', devices);
    }
    rows.accounts.push(ACCOUNTS.pack(rest));
  }
  for (const [hash, session] of mapEntries(DOMAIN, 'sessions', state.sessions)) {
    rows.account_sessions.push(SESSIONS.pack(session, { token_hash: hash }));
  }
  for (const [loginId, login] of mapEntries(DOMAIN, 'logins', state.logins)) {
    rows.account_logins.push(LOGINS.pack(login, { login_id: loginId }));
  }
  for (const [hash, grant] of mapEntries(DOMAIN, 'grants', state.grants)) {
    rows.account_grants.push(GRANTS.pack(grant, { grant_hash: hash }));
  }
  for (const [emailLower, accountId] of mapEntries(DOMAIN, 'byEmail', state.byEmail)) {
    rows.account_email_index.push(EMAIL_INDEX.pack(null, { email_lower: emailLower, account_id: accountId }));
  }
  for (const [workosUserId, accountId] of mapEntries(DOMAIN, 'byWorkosUser', state.byWorkosUser)) {
    rows.account_workos_index.push(WORKOS_INDEX.pack(null, { workos_user_id: workosUserId, account_id: accountId }));
  }
  if (hasTrialEmails) {
    for (const [hash, trial] of mapEntries(DOMAIN, 'trialEmails', state.trialEmails)) {
      rows.account_trial_emails.push(TRIAL_EMAILS.pack(trial, { email_hash: hash }));
    }
  }
  return rows;
}

function fromRows(rows) {
  const state = { accounts: {}, byWorkosUser: {}, byEmail: {}, sessions: {}, logins: {}, grants: {} };
  if (rows.account_roots[0]?.has_trial_emails ?? true) state.trialEmails = {};
  for (const row of rows.accounts) {
    const account = ACCOUNTS.unpack(row);
    if (!Object.hasOwn(account, 'devices')) account.devices = {};
    setOwn(state.accounts, row.id, account);
  }
  for (const row of rows.account_devices) {
    const { devices } = state.accounts[row.account_id];
    if (!isPlainObject(devices)) throw storeMisfit(`accounts (${row.account_id}): device rows for a devices value that is not a map`);
    setOwn(devices, row.device_id, DEVICES.unpack(row));
  }
  for (const row of rows.account_sessions) setOwn(state.sessions, row.token_hash, SESSIONS.unpack(row));
  for (const row of rows.account_logins) setOwn(state.logins, row.login_id, LOGINS.unpack(row));
  for (const row of rows.account_grants) setOwn(state.grants, row.grant_hash, GRANTS.unpack(row));
  for (const row of rows.account_email_index) setOwn(state.byEmail, row.email_lower, row.account_id);
  for (const row of rows.account_workos_index) setOwn(state.byWorkosUser, row.workos_user_id, row.account_id);
  for (const row of rows.account_trial_emails) {
    if (!state.trialEmails) throw storeMisfit('account_trial_emails rows for a state without trialEmails');
    setOwn(state.trialEmails, row.email_hash, TRIAL_EMAILS.unpack(row));
  }
  return state;
}

export const accountsMapper = Object.freeze({
  domain: DOMAIN,
  tables: [ROOTS, ACCOUNTS, DEVICES, SESSIONS, LOGINS, GRANTS, EMAIL_INDEX, WORKOS_INDEX, TRIAL_EMAILS],
  toRows,
  fromRows,
});
