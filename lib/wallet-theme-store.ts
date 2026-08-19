import { postgresQuery } from "@/lib/postgres";
import type { AccentTheme } from "@/lib/theme-accent";

/**
 * Server-side, per-wallet color theme -- migration 013_wallet_theme_prefs.
 * See that file's own header for why this exists (localStorage alone never
 * crosses browsers/devices) and why no wallet signature is required (a
 * low-stakes cosmetic preference, same posture as social_follows/
 * plank_referral_codes).
 */

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function normalizeAddress(addr: string): string {
  return addr.trim().toLowerCase();
}

/** Mirrors AccentTheme's own real range: hue is a full circle, sat/lightness are CSS percentages. Rejects anything outside what theme-accent.ts could ever legitimately produce, so a malformed write can never reach the table. */
function isValidTheme(t: Partial<AccentTheme>): t is AccentTheme {
  const inRange = (n: unknown, min: number, max: number) =>
    typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
  return (
    inRange(t.h, 0, 359) &&
    inRange(t.s, 0, 100) &&
    inRange(t.l600, 0, 100) &&
    inRange(t.l500, 0, 100) &&
    inRange(t.l400, 0, 100) &&
    inRange(t.l300, 0, 100)
  );
}

export async function getWalletTheme(walletAddress: string): Promise<AccentTheme | null> {
  const address = normalizeAddress(walletAddress);
  if (!HEX_ADDRESS.test(address)) return null;

  const result = await postgresQuery<{
    hue: number;
    saturation: number;
    lightness_600: number;
    lightness_500: number;
    lightness_400: number;
    lightness_300: number;
  }>(
    `SELECT hue, saturation, lightness_600, lightness_500, lightness_400, lightness_300
     FROM plank_wallet_theme_prefs WHERE wallet_address = $1`,
    [address]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    h: row.hue,
    s: row.saturation,
    l600: row.lightness_600,
    l500: row.lightness_500,
    l400: row.lightness_400,
    l300: row.lightness_300,
  };
}

export type SaveWalletThemeResult = { ok: true } | { ok: false; error: "BAD_ADDRESS" | "BAD_THEME" };

export async function saveWalletTheme(
  walletAddress: string,
  theme: Partial<AccentTheme>
): Promise<SaveWalletThemeResult> {
  const address = normalizeAddress(walletAddress);
  if (!HEX_ADDRESS.test(address)) return { ok: false, error: "BAD_ADDRESS" };
  if (!isValidTheme(theme)) return { ok: false, error: "BAD_THEME" };

  await postgresQuery(
    `INSERT INTO plank_wallet_theme_prefs
       (wallet_address, hue, saturation, lightness_600, lightness_500, lightness_400, lightness_300, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (wallet_address) DO UPDATE SET
       hue = EXCLUDED.hue,
       saturation = EXCLUDED.saturation,
       lightness_600 = EXCLUDED.lightness_600,
       lightness_500 = EXCLUDED.lightness_500,
       lightness_400 = EXCLUDED.lightness_400,
       lightness_300 = EXCLUDED.lightness_300,
       updated_at = NOW()`,
    [address, theme.h, theme.s, theme.l600, theme.l500, theme.l400, theme.l300]
  );
  return { ok: true };
}
