import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * The backstage door: a private username + PIN entrance to the gated
 * Marketplank in production, for the owner to explore and test before the
 * public gate opens. Issues a stateless HMAC cookie honoured by the same
 * places the admin preview cookie is (app/market/multichain/*, app/market),
 * and nothing else: a captured cookie unlocks browsing while gated, never a
 * mutation.
 *
 * Configuration (server env; each has a fallback so the door works on a
 * deploy whose env was not touched, which is the whole point of it):
 *   MARKET_PREVIEW_DOOR_SLUG        path segment of the door page (default below)
 *   MARKET_PREVIEW_DOOR_USER        username
 *   MARKET_PREVIEW_DOOR_PIN_SHA256  hex sha256 of the PIN
 *   MARKET_PREVIEW_DOOR_SECRET      HMAC key (falls back to PLANK_ADMIN_PREVIEW_SECRET,
 *                                   then to a key derived from user+pin hash)
 * Login attempts are rate-limited per IP in the route; comparisons are
 * constant-time.
 */

export const DOOR_COOKIE_NAME = "plank_market_door";
const DOOR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // a week of testing per login
export const DOOR_COOKIE_MAX_AGE_S = Math.floor(DOOR_WINDOW_MS / 1000);

const DEFAULT_SLUG = "backstage-7f3a9c2e";
const DEFAULT_USER = "OG";
// Owner-issued test PIN (2026-09-06) for a deploy whose env was not touched.
// Override with MARKET_PREVIEW_DOOR_PIN_SHA256 (preferred) or MARKET_PREVIEW_DOOR_PIN.
const DEFAULT_PIN = "220593";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function doorSlug(): string {
  return process.env.MARKET_PREVIEW_DOOR_SLUG?.trim() || DEFAULT_SLUG;
}

function doorUser(): string {
  return process.env.MARKET_PREVIEW_DOOR_USER?.trim() || DEFAULT_USER;
}

function doorPinHash(): string {
  const env = process.env.MARKET_PREVIEW_DOOR_PIN_SHA256?.trim().toLowerCase();
  if (env && /^[0-9a-f]{64}$/.test(env)) return env;
  return sha256(process.env.MARKET_PREVIEW_DOOR_PIN?.trim() || DEFAULT_PIN);
}

function doorSecret(): string {
  const explicit = process.env.MARKET_PREVIEW_DOOR_SECRET?.trim();
  if (explicit && explicit.length >= 16) return explicit;
  const admin = process.env.PLANK_ADMIN_PREVIEW_SECRET?.trim();
  if (admin && admin.length >= 16) return admin;
  return sha256(`door|${doorUser()}|${doorPinHash()}`);
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Constant-time check of a submitted username + PIN. */
export function verifyDoorCredentials(user: string, pin: string): boolean {
  const userOk = safeEqual(user.trim().toLowerCase(), doorUser().toLowerCase());
  const pinOk = safeEqual(sha256(pin.trim()), doorPinHash());
  return userOk && pinOk;
}

export function buildDoorCookieValue(user: string, now: number = Date.now()): string {
  const expiresAt = now + DOOR_WINDOW_MS;
  const subject = `door:${user.trim().toLowerCase()}`;
  const mac = createHmac("sha256", doorSecret()).update(`${subject}.${expiresAt}`).digest("hex");
  return `${subject}.${expiresAt}.${mac}`;
}

export function verifyDoorCookieValue(value: string | undefined | null, now: number = Date.now()): boolean {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [subject, expiresAtStr, mac] = parts;
  if (!subject.startsWith("door:")) return false;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt < now) return false;
  const expected = createHmac("sha256", doorSecret()).update(`${subject}.${expiresAt}`).digest("hex");
  const a = Buffer.from(mac, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** The exact sha256 the default PIN must hash to -- exported for the test that keeps the constant honest. */
export function sha256Hex(s: string): string {
  return sha256(s);
}
