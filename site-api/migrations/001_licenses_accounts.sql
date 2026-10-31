-- 001: store versions, meta, the licenses domain, the webhook log and the accounts domain.
--
-- Each service owns its tables and writes them only in its own transactions, under its domain's
-- advisory lock (pg-store.mjs). Foreign keys stay inside one domain: a child row is a record nested
-- in its parent's JSON (a license's devices and subscription, an account's devices, an avatar), and
-- deleting the parent deletes it. Ids that point into another domain (licenses.account_id,
-- grandfathered_installs.key_id, ...) and references between entries of one domain that the code
-- does not guarantee (sessions, grants, refs, orders.key_id) are plain indexed columns, so every
-- service can be written and tested on its own and no stale reference blocks a write.
--
-- A record's fields without a column, and values that do not fit their column exactly (a time that
-- is not a canonical ISO string, an explicit null, a value of another type), stay verbatim in
-- `extra` (json: it keeps NUL characters, unpaired surrogates and key order, which text and jsonb
-- would reject or change). `seq` keeps the order entries were written, so maps and arrays load in
-- their JSON order. Times are timestamptz, epoch-ms numbers bigint, money double precision.

CREATE TABLE site_store_versions (
  domain text PRIMARY KEY,
  version bigint NOT NULL CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Markers such as a finished JSON import.
CREATE TABLE site_meta (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- licenses.json ---------------------------------------------------------------------------------
-- keyIndex is not stored: it is derived from licenses.key (createLicense is its only writer).

CREATE TABLE licenses (
  key_id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  key text NOT NULL UNIQUE,
  status text,
  tier text,
  source text,
  edition text,
  product_id text,
  name text,
  email text,
  merchant_uid text,
  ref text,
  amount double precision,
  device_limit integer,
  billing_cycle_months integer,
  install_digest text,
  account_id text,
  linked_by text,
  linked_at timestamptz,
  unlinked_by text,
  unlinked_at timestamptz,
  occurred_at timestamptz,
  created_at timestamptz,
  expires_at timestamptz,
  updates_until timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  restored_at timestamptz,
  note text,
  email_delivery json,
  support json,
  extensions json,
  extra json
);
CREATE INDEX licenses_email_lower ON licenses (lower(email));
CREATE INDEX licenses_account_id ON licenses (account_id);
CREATE INDEX licenses_merchant_uid ON licenses (merchant_uid);

CREATE TABLE license_subscriptions (
  key_id text PRIMARY KEY REFERENCES licenses (key_id) ON DELETE CASCADE,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  product_id text,
  status text,
  auto_renew boolean,
  manual boolean,
  billing_cycle_months integer,
  current_round integer,
  activated_at timestamptz,
  last_paid_at timestamptz,
  next_billing_date date,
  payment_grace_ends_at timestamptz,
  cancel_requested_at timestamptz,
  cancel_requested_by text,
  service_ends_at timestamptz,
  terminated_at timestamptz,
  termination_reason text,
  cancelled_by text,
  last_failure json,
  extra json
);

CREATE TABLE license_devices (
  key_id text NOT NULL REFERENCES licenses (key_id) ON DELETE CASCADE,
  device_id text NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  activated_at timestamptz,
  last_seen_at timestamptz,
  app_version text,
  platform text,
  extra json,
  PRIMARY KEY (key_id, device_id)
);

-- One row per Groble order id (merchantUid): the webhook idempotency anchor, one per paid round.
CREATE TABLE groble_orders (
  merchant_uid text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  status text,
  kind text,
  source text,
  key_id text,
  ref text,
  email text,
  content_id text,
  amount double precision,
  original_amount double precision,
  coupon_code text,
  billing_cycle_months integer,
  round integer,
  hold_reason text,
  released_hold_reason text,
  created_at timestamptz,
  purchased_at timestamptz,
  completed_at timestamptz,
  completed_event_id text,
  last_event_at timestamptz,
  acked_at timestamptz,
  grant_from timestamptz,
  grant_to timestamptz,
  refunded_at timestamptz,
  refunds json,
  cancel_requests json,
  extra json
);
CREATE INDEX groble_orders_key_id ON groble_orders (key_id);
CREATE INDEX groble_orders_email_lower ON groble_orders (lower(email));

-- sellerReference → the merchantUid of the order that claimed it first.
CREATE TABLE groble_refs (
  ref text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  merchant_uid text NOT NULL
);
CREATE INDEX groble_refs_merchant_uid ON groble_refs (merchant_uid);

-- Webhook deliveries of the last 8 days by X-Groble-Idempotency-Key (`event:<id>` without one).
CREATE TABLE groble_webhook_deliveries (
  idempotency_key text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  received_at timestamptz,
  type text,
  event_id text,
  merchant_uid text,
  action text,
  extra json
);

-- sha256(installId) → the grandfathered license.
CREATE TABLE grandfathered_installs (
  install_digest text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  key_id text NOT NULL
);
CREATE INDEX grandfathered_installs_key_id ON grandfathered_installs (key_id);

-- webhook-log.json ------------------------------------------------------------------------------
-- The newest rejected or held Groble webhooks, oldest first by seq.

CREATE TABLE webhook_log (
  id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  kind text,
  reason text,
  status integer,
  verified boolean,
  logged_at timestamptz,
  acked_at timestamptz,
  groble_timestamp text,
  idempotency_key text,
  event_type text,
  event_id text,
  merchant_uid text,
  action text,
  buyer_email text,
  amount double precision,
  headers json,
  extra json
);

-- accounts.json ---------------------------------------------------------------------------------
-- The license ↔ account link lives on licenses.account_id. The device limit is enforced in
-- accounts.mjs (ACCOUNT_DEVICE_LIMIT), never here.

CREATE TABLE accounts (
  id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  workos_user_id text,
  email text,
  email_lower text,
  email_verified boolean,
  name text,
  name_source text,
  provider text,
  avatar json,
  last_avatar_rev integer,
  stats json,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  extra json
);
CREATE INDEX accounts_email_lower ON accounts (email_lower);
CREATE INDEX accounts_workos_user_id ON accounts (workos_user_id);

CREATE TABLE account_devices (
  account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  device_id text NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  name text,
  platform text,
  app_version text,
  added_at timestamptz,
  last_seen_at timestamptz,
  session_hash text,
  extra json,
  PRIMARY KEY (account_id, device_id)
);

-- Sessions and grants are stored only as sha256 hex of the token.
CREATE TABLE account_sessions (
  token_hash text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  account_id text,
  device_id text,
  created_at timestamptz,
  last_used_at timestamptz,
  extra json
);
CREATE INDEX account_sessions_account_id ON account_sessions (account_id);

CREATE TABLE account_logins (
  login_id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  provider text,
  challenge text,
  app_state text,
  port integer,
  created_at timestamptz,
  expires_at timestamptz,
  extra json
);

CREATE TABLE account_grants (
  grant_hash text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  account_id text,
  challenge text,
  attempts integer,
  created_at timestamptz,
  expires_at timestamptz,
  extra json
);
CREATE INDEX account_grants_account_id ON account_grants (account_id);

-- byEmail (verified emails only, first account wins) and byWorkosUser: their own rules, so stored.
CREATE TABLE account_email_index (
  email_lower text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  account_id text NOT NULL
);
CREATE INDEX account_email_index_account_id ON account_email_index (account_id);

CREATE TABLE account_workos_index (
  workos_user_id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  account_id text NOT NULL
);
CREATE INDEX account_workos_index_account_id ON account_workos_index (account_id);

-- Profile pictures; accounts.avatar keeps rev, type and size.
CREATE TABLE account_avatars (
  account_id text PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  type text NOT NULL,
  bytes bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
