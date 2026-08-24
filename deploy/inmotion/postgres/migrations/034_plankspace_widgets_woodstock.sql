CREATE TABLE IF NOT EXISTS plankspace_profile_widgets (
  id bigserial PRIMARY KEY,
  owner_wallet text NOT NULL,
  profile_handle text NOT NULL,
  type text NOT NULL,
  title text NOT NULL DEFAULT '',
  config_json text NOT NULL DEFAULT '{}',
  style_json text NOT NULL DEFAULT '{}',
  sort_order integer NOT NULL DEFAULT 0,
  visible boolean NOT NULL DEFAULT true,
  desktop_visible boolean NOT NULL DEFAULT true,
  mobile_visible boolean NOT NULL DEFAULT true,
  created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS profile_widgets_handle_order_idx ON plankspace_profile_widgets(profile_handle, sort_order);
CREATE INDEX IF NOT EXISTS profile_widgets_owner_idx ON plankspace_profile_widgets(owner_wallet);

CREATE TABLE IF NOT EXISTS plankspace_profile_tips (
  id bigserial PRIMARY KEY,
  recipient_handle text NOT NULL,
  recipient_wallet text NOT NULL,
  sender_wallet text NOT NULL,
  sender_handle text NOT NULL DEFAULT '',
  chain_id integer NOT NULL,
  token_symbol text NOT NULL DEFAULT 'NATIVE',
  amount text NOT NULL,
  tx_hash text NOT NULL UNIQUE,
  public_sender boolean NOT NULL DEFAULT true,
  verified_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS profile_tips_recipient_idx ON plankspace_profile_tips(recipient_handle, verified_at);

CREATE TABLE IF NOT EXISTS plankspace_live_rooms (
  id bigserial PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  host_wallet text NOT NULL,
  host_handle text NOT NULL,
  status text NOT NULL DEFAULT 'live',
  jitsi_room text NOT NULL,
  created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS live_rooms_status_idx ON plankspace_live_rooms(status, updated_at);

CREATE TABLE IF NOT EXISTS plankspace_live_room_members (
  id bigserial PRIMARY KEY,
  room_slug text NOT NULL,
  wallet text NOT NULL,
  handle text NOT NULL,
  role text NOT NULL DEFAULT 'listener',
  mic_status text NOT NULL DEFAULT 'muted',
  requested_mic boolean NOT NULL DEFAULT false,
  removed boolean NOT NULL DEFAULT false,
  last_seen_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(room_slug, wallet)
);
CREATE INDEX IF NOT EXISTS live_room_members_room_idx ON plankspace_live_room_members(room_slug, last_seen_at);
