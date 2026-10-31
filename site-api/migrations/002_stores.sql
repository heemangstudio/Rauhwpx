-- 002: the Hama plan and its usage log, hosted Rau-0.1, gift credits, the waitlist, unique installs,
-- download counts and the feedback index.
--
-- The conventions of 001 hold: each service owns its tables and writes them only in its own
-- transactions under its domain's advisory lock; foreign keys stay inside one domain; key ids from
-- the licenses domain (hama_plans.key_id, rau_allowances.key_id, ...) are plain indexed columns with
-- no foreign key, so every service is written and tested on its own. Fields without a column and
-- values that do not fit theirs stay verbatim in `extra`; `seq` keeps the JSON order.

-- hama.json -------------------------------------------------------------------------------------
-- A ledger may exist without a plan (a call billed for a key the admin never enrolled), so the two
-- are separate maps with no foreign key between them.

CREATE TABLE hama_plans (
  key_id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  status text,
  allowance_usd double precision,
  period_anchor timestamptz,
  enrolled_at timestamptz,
  disabled_at timestamptz,
  disabled_reason text,
  extra json
);

-- minutes/hours: spend buckets of the rolling caps; ids: recent call ids (idempotency); period: the
-- running totals of the current billing period.
CREATE TABLE hama_ledgers (
  key_id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  minutes json,
  hours json,
  ids json,
  period json,
  total_usd double precision,
  calls integer,
  last_call_at timestamptz,
  extra json
);

-- hama-usage/<keyId>.jsonl: one row per billed call, appended after the ledger commits and never
-- updated. Not a state document: hama-usage.mjs reads it newest first by seq.
CREATE TABLE hama_usage (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key_id text NOT NULL,
  at timestamptz,
  call_id text,
  route text,
  provider text,
  model text,
  input_tokens integer,
  output_tokens integer,
  cache_read_tokens integer,
  cache_write_tokens integer,
  cost_usd double precision,
  cost_source text,
  extra json
);
CREATE INDEX hama_usage_key_id ON hama_usage (key_id, seq DESC);

-- rau.json --------------------------------------------------------------------------------------
-- One OpenRouter key per license. `openrouter_key` is the key itself, as rau.json holds it.

CREATE TABLE rau_allowances (
  key_id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  status text,
  name text,
  openrouter_hash text,
  openrouter_key text,
  cap_usd double precision,
  period text,
  ledger json,
  started_at timestamptz,
  created_at timestamptz,
  limit_set_at timestamptz,
  last_used_at timestamptz,
  extra json
);

-- gifts.json (gift credits, not gift codes) -----------------------------------------------------
-- An event row exists for every event, also one whose grants and allocations are empty. has_grants
-- and has_allocations say whether the event holds that map at all: events written before per-license
-- amounts have no `allocations`.

CREATE TABLE gift_credit_events (
  event_id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  has_grants boolean NOT NULL,
  has_allocations boolean NOT NULL,
  extra json
);

CREATE TABLE gift_credit_grants (
  event_id text NOT NULL REFERENCES gift_credit_events (event_id) ON DELETE CASCADE,
  key_id text NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  status text,
  name text,
  limit_usd double precision,
  pending_limit_usd double precision,
  source text,
  device_id text,
  openrouter_hash text,
  openrouter_key text,
  started_at timestamptz,
  claimed_at timestamptz,
  limit_changed_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  extra json,
  PRIMARY KEY (event_id, key_id)
);
CREATE INDEX gift_credit_grants_key_id ON gift_credit_grants (key_id);

-- The admin-set gift amount per license (0 = no gift).
CREATE TABLE gift_credit_allocations (
  event_id text NOT NULL REFERENCES gift_credit_events (event_id) ON DELETE CASCADE,
  key_id text NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  amount_usd double precision,
  extra json,
  PRIMARY KEY (event_id, key_id)
);

-- waitlist.json ---------------------------------------------------------------------------------

CREATE TABLE waitlist_entries (
  email_lower text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  email text,
  joined_at timestamptz,
  extra json
);

-- unique-installs.json --------------------------------------------------------------------------
-- sha256(installId) → the first launch of an install. licenses reads it for grandfathering.

CREATE TABLE unique_installs (
  install_digest text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  official boolean,
  first_seen_at timestamptz,
  app_version text,
  os text,
  arch text,
  extra json
);

-- downloads.json --------------------------------------------------------------------------------
-- Counts only, by KST day and `platform|version` (`platform|other` past 64 pairs a day).

CREATE TABLE download_counts (
  day date NOT NULL,
  key text NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  count integer,
  extra json,
  PRIMARY KEY (day, key)
);

-- feedback/index.json ---------------------------------------------------------------------------
-- The inbox index. Each report's report.json and attachments stay files in feedback/<id>/.

CREATE TABLE feedback_reports (
  id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  received_at timestamptz,
  created_at timestamptz,
  status text,
  install_hash text,
  email text,
  preview text,
  app_version text,
  os text,
  os_version text,
  arch text,
  attachments json,
  bytes integer,
  extra json
);
