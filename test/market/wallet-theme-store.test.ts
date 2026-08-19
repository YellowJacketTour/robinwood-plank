import assert from "node:assert/strict";
import test from "node:test";

import { saveWalletTheme, getWalletTheme } from "../../lib/wallet-theme-store";

/**
 * Only the validation paths that return before touching Postgres are unit
 * tested here -- same convention as referral-codes.test.ts's own header:
 * the real INSERT/SELECT round-trip needs a live database and is verified
 * against one directly (migration 013_wallet_theme_prefs.sql), not through
 * this suite.
 */

const VALID_THEME = { h: 40, s: 78, l600: 41, l500: 59, l400: 66, l300: 77 };
const WALLET_A = `0x${"11".repeat(20)}`;
const WALLET_B = `0x${"22".repeat(20)}`;

test("a malformed wallet address is rejected before any query", async () => {
  const result = await saveWalletTheme("not-an-address", VALID_THEME);
  assert.deepEqual(result, { ok: false, error: "BAD_ADDRESS" });
});

test("getWalletTheme returns null for a malformed address without querying", async () => {
  const result = await getWalletTheme("not-an-address");
  assert.equal(result, null);
});

test("theme values outside the real hue/saturation/lightness range are rejected", async () => {
  const wallet = WALLET_A;
  const cases = [
    { ...VALID_THEME, h: 360 }, // hue is 0-359, a full circle
    { ...VALID_THEME, h: -1 },
    { ...VALID_THEME, s: 101 },
    { ...VALID_THEME, l300: -5 },
    { ...VALID_THEME, h: Number.NaN },
  ];
  for (const bad of cases) {
    const result = await saveWalletTheme(wallet, bad);
    assert.deepEqual(result, { ok: false, error: "BAD_THEME" }, JSON.stringify(bad));
  }
});

test("a theme missing fields is rejected", async () => {
  const wallet = WALLET_B;
  const result = await saveWalletTheme(wallet, { h: 40, s: 78 });
  assert.deepEqual(result, { ok: false, error: "BAD_THEME" });
});
