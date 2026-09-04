ALTER TABLE plankspace_posts
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'plankspace',
  ADD COLUMN IF NOT EXISTS external_post_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS x_publish_status text NOT NULL DEFAULT 'not-requested',
  ADD COLUMN IF NOT EXISTS x_post_url text NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS plankspace_posts_external_unique
  ON plankspace_posts(source, external_post_id) WHERE external_post_id <> '';

CREATE TABLE IF NOT EXISTS plankspace_x_accounts (
  wallet text PRIMARY KEY,
  profile_handle text NOT NULL UNIQUE,
  x_user_id text NOT NULL,
  x_username text NOT NULL,
  access_token_encrypted text NOT NULL DEFAULT '',
  refresh_token_encrypted text NOT NULL DEFAULT '',
  token_expires_at text,
  sync_cursor text NOT NULL DEFAULT '',
  connected_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS plankspace_x_post_mappings (
  id serial PRIMARY KEY,
  wallet text NOT NULL,
  plankspace_post_id integer,
  x_post_id text NOT NULL UNIQUE,
  direction text NOT NULL,
  x_post_url text NOT NULL DEFAULT '',
  idempotency_key text NOT NULL UNIQUE,
  created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS plankspace_x_mappings_wallet_idx ON plankspace_x_post_mappings(wallet, created_at);

CREATE TABLE IF NOT EXISTS plankspace_x_oauth_states (
  state text PRIMARY KEY,
  wallet text NOT NULL,
  profile_handle text NOT NULL,
  pkce_verifier text NOT NULL,
  expires_at text NOT NULL,
  created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
