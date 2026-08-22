import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Admin-only bypass for the site-wide market kill-switch (MARKET_ENABLED /
 * flags.marketEnabled — both app/market/page.tsx and
 * app/market/multichain/page.tsx). Lets an authenticated admin browse the
 * real, live marketplace surfaces while MARKET_ENABLED stays false for
 * every other visitor — e.g. while the production data pipeline is still
 * catching up on collection/chain coverage and the owner wants to watch it
 * fill in without exposing an incomplete surface publicly.
 *
 * Stateless HMAC cookie, not a session store (this app has none — see
 * lib/admin-auth.ts's own header): sign-in verifies a real wallet-signature
 * AdminProof once (lib/admin-auth.ts's existing scheme, same allowlist),
 * then issues a short-lived cookie whose value is
 * `${address}.${expiresAtMs}.${hmac}` — the HMAC binds address+expiry to
 * PLANK_ADMIN_PREVIEW_SECRET so a visitor cannot forge or extend it, and a
 * captured cookie authorizes nothing beyond "browse while gated," never a
 * mutation (those still require a fresh AdminProof per lib/admin-auth.ts).
 */

const COOKIE_NAME = "plank_admin_preview";
const PREVIEW_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h — long enough for a real browsing session, short enough that a leaked cookie ages out on its own.

function secret(): string | null {
  const s = process.env.PLANK_ADMIN_PREVIEW_SECRET;
  return s && s.length >= 16 ? s : null;
}

function hmac(input: string): string {
  return createHmac("sha256", secret()!).update(input).digest("hex");
}

/** Build the cookie value for a verified admin address. Caller must have already run verifyAdminProof(). */
export function buildPreviewCookieValue(address: string, now: number = Date.now()): string | null {
  if (!secret()) return null;
  const expiresAt = now + PREVIEW_WINDOW_MS;
  const addr = address.toLowerCase();
  const mac = hmac(`${addr}.${expiresAt}`);
  return `${addr}.${expiresAt}.${mac}`;
}

/** Verify a cookie value read back from the request. Fails closed on any malformed/expired/tampered input. */
export function verifyPreviewCookieValue(value: string | undefined | null, now: number = Date.now()): boolean {
  if (!value || !secret()) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [addr, expiresAtStr, mac] = parts;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt < now) return false;
  const expectedMac = hmac(`${addr}.${expiresAt}`);
  const a = Buffer.from(mac, "hex");
  const b = Buffer.from(expectedMac, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const MARKET_PREVIEW_COOKIE_NAME = COOKIE_NAME;
export const MARKET_PREVIEW_COOKIE_MAX_AGE_S = Math.floor(PREVIEW_WINDOW_MS / 1000);
export function marketPreviewConfigured(): boolean {
  return secret() !== null;
}
