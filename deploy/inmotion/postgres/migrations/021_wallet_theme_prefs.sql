-- Per-wallet color theme preference, synced across devices/browsers.
--
-- WHY
-- ---
-- ThemeAccentPicker.tsx originally persisted only to localStorage keyed by
-- address -- correct for "remember this browser," but never survives a
-- different browser or device connecting the same wallet, which a user
-- flagged live ("stays their last wallet connected style for next wallet
-- connect session any device any browser?"). This table is the real fix:
-- one row per wallet, read on connect from any device, written on every
-- pick. localStorage stays as a fast-path/offline fallback in the client,
-- never the source of truth once a wallet is connected.
--
-- NO SIGNATURE REQUIRED
-- ----------------------
-- This is a low-stakes cosmetic preference, not a fund-moving or
-- identity-asserting action -- the same posture social_follows and
-- plank_referral_codes already take for address-keyed writes with no
-- wallet signature. Worst case if someone writes a bogus theme against an
-- address they don't own: that wallet's owner sees an unexpected accent
-- color next time they connect, correctable in one click. Rate-limited and
-- shape-validated at the API layer (see app/api/wallet-theme/route.ts) the
-- same way every other public write in this app is.
--
-- Additive only; a build that has never heard of this table never queries
-- it.

CREATE TABLE IF NOT EXISTS plank_wallet_theme_prefs (
  wallet_address TEXT PRIMARY KEY,

  -- The six AccentTheme fields (lib/theme-accent.ts), stored flat rather
  -- than as one JSONB blob so a malformed/partial value is impossible by
  -- construction -- every column is NOT NULL, so a row either has a
  -- complete, valid theme or doesn't exist.
  hue            SMALLINT NOT NULL,
  saturation     SMALLINT NOT NULL,
  lightness_600  SMALLINT NOT NULL,
  lightness_500  SMALLINT NOT NULL,
  lightness_400  SMALLINT NOT NULL,
  lightness_300  SMALLINT NOT NULL,

  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
