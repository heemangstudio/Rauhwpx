-- 003: hosted Rau credits (rau.json `ledgers` and `spend`) and the Rau trial on accounts.
--
-- The conventions of 001 and 002 hold. Two files gained a top-level map that older files lack, so a
-- one-row table says which maps the file holds, the way gift_credit_events.has_grants does for an
-- event: an old file reads back without the map, and a new database (no row) reads as the empty
-- state the service starts from.

-- rau.json --------------------------------------------------------------------------------------
-- A file of the earlier Rau-0.1 holds only `allowances` (rau_allowances, 002), which nothing reads or
-- writes any more; the current service writes `ledgers` and `spend` and leaves `allowances` as it is.
-- No row: `{ ledgers: {}, spend: {} }`.

CREATE TABLE rau_roots (
  id text PRIMARY KEY CHECK (id = 'rau'),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  has_allowances boolean NOT NULL,
  has_ledgers boolean NOT NULL,
  has_spend boolean NOT NULL
);

-- One credit ledger per principal: a Rau license (its key id) or an account's trial (its account id),
-- so principal_id has no foreign key. period: the running totals of the current period; ids: recent
-- call ids, so a call is never billed twice.
CREATE TABLE rau_ledgers (
  principal_id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  source text,
  period json,
  ids json,
  total_usd double precision,
  calls integer,
  last_call_at timestamptz,
  extra json
);

-- Spend per UTC week (its Monday) and model, the newest 26 weeks. A week exists only through its
-- models. Token counts are bigint: a week of cache reads passes int4.
CREATE TABLE rau_spend (
  week date NOT NULL,
  model text NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  usd double precision,
  calls integer,
  input_tokens bigint,
  output_tokens bigint,
  cache_read_tokens bigint,
  cache_write_tokens bigint,
  routes json,
  extra json,
  PRIMARY KEY (week, model)
);

-- accounts.json ---------------------------------------------------------------------------------
-- An account's Rau trial, `{ startedAt, endsAt }`.

ALTER TABLE accounts ADD COLUMN rau_trial json;

-- trialEmails: sha256(lowercased email) → the account that started a trial with it. It outlives that
-- account (no foreign key), so an email gets one trial.
CREATE TABLE account_trial_emails (
  email_hash text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  account_id text,
  started_at timestamptz,
  extra json
);

-- Whether accounts.json holds `trialEmails`: a file written before the trial has none. No row: it does.
CREATE TABLE account_roots (
  id text PRIMARY KEY CHECK (id = 'accounts'),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  has_trial_emails boolean NOT NULL
);
