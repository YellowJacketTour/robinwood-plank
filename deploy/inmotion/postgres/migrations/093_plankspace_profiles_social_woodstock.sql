ALTER TABLE plankspace_profiles ADD COLUMN IF NOT EXISTS banner_url TEXT NOT NULL DEFAULT '';
ALTER TABLE plankspace_profiles ADD COLUMN IF NOT EXISTS mobile_css TEXT NOT NULL DEFAULT '';
ALTER TABLE plankspace_profiles ADD COLUMN IF NOT EXISTS view_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS plankspace_profile_visits (
  id SERIAL PRIMARY KEY,
  profile_handle TEXT NOT NULL,
  visitor_wallet TEXT NOT NULL,
  visitor_handle TEXT NOT NULL,
  visited_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(profile_handle, visitor_wallet)
);
CREATE INDEX IF NOT EXISTS profile_visits_recent_idx ON plankspace_profile_visits(profile_handle, visited_at);

CREATE TABLE IF NOT EXISTS plankspace_publications (
  id SERIAL PRIMARY KEY,
  author_wallet TEXT NOT NULL,
  author_handle TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bulletin','blog')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  moderation_status TEXT NOT NULL DEFAULT 'approved',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS publications_profile_idx ON plankspace_publications(author_handle, kind, created_at);

CREATE TABLE IF NOT EXISTS plankspace_live_rooms (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  host_wallet TEXT NOT NULL,
  host_handle TEXT NOT NULL,
  jitsi_room TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'live',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS live_rooms_status_idx ON plankspace_live_rooms(status, created_at);

CREATE TABLE IF NOT EXISTS plankspace_live_room_members (
  id SERIAL PRIMARY KEY,
  room_slug TEXT NOT NULL,
  wallet TEXT NOT NULL,
  handle TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'listener' CHECK (role IN ('host','speaker','listener')),
  mic_status TEXT NOT NULL DEFAULT 'idle' CHECK (mic_status IN ('idle','requested','approved','muted')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(room_slug, wallet)
);
CREATE INDEX IF NOT EXISTS live_room_members_room_idx ON plankspace_live_room_members(room_slug, active, role);
