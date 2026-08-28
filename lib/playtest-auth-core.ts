import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const PLAYTEST_SESSION_COOKIE = "__Host-plank_lab";
export const PLAYTEST_SESSION_SECONDS = 12 * 60 * 60;
export const PLAYTEST_CEREMONY_SECONDS = 5 * 60;

/** Server-only deployment gate. The unofficial laboratory is absent unless
 * an operator explicitly enables it in Passenger's protected runtime env. */
export function playtestEnabled(): boolean {
  return process.env.PLANK_PLAYTEST_ENABLED?.trim().toLowerCase() === "true";
}

/** Legacy enrollment is off by default after the laboratory moved to shared
 * PIN entry. Kept only as an explicit rollback switch. */
export function playtestPasskeysEnabled(): boolean {
  return process.env.PLANK_PLAYTEST_PASSKEYS_ENABLED?.trim().toLowerCase() === "true";
}

function configuredOrigin(): URL {
  const raw = process.env.PLANK_PLAYTEST_ORIGIN?.trim();
  if (!raw) throw new Error("PLANK_PLAYTEST_ORIGIN is not configured.");
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("PLANK_PLAYTEST_ORIGIN must use HTTPS outside localhost.");
  }
  return url;
}

export function playtestRp(): { rpID: string; origin: string; rpName: string } {
  if (!playtestEnabled()) throw new Error("The unofficial Plank playtest is disabled.");
  const origin = configuredOrigin();
  const configuredRpId = process.env.PLANK_PLAYTEST_RP_ID?.trim().toLowerCase();
  const rpID = configuredRpId || origin.hostname;
  if (origin.hostname !== rpID && !origin.hostname.endsWith(`.${rpID}`)) {
    throw new Error("PLANK_PLAYTEST_RP_ID must equal or contain the configured origin host.");
  }
  return { rpID, origin: origin.origin, rpName: "Plank Love Game Laboratory" };
}

/** Exact Origin check for every cookie-authenticated mutation. SameSite is a
 * useful browser defense, but it is not the authorization boundary. */
export function playtestMutationOriginAllowed(req: Request): boolean {
  if (!playtestEnabled()) return false;
  const supplied = req.headers.get("origin");
  if (!supplied) return false;
  try { return new URL(supplied).origin === configuredOrigin().origin; }
  catch { return false; }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The first admin claim additionally requires a high-entropy deployment
 * credential. A six-digit PIN alone is never allowed to claim an Internet
 * deployment because that would create a trivial first-visitor race. */
export function playtestBootstrapAllowed(value: unknown): boolean {
  if (typeof value !== "string" || value.length < 32 || value.length > 128) return false;
  const configured = process.env.PLANK_PLAYTEST_BOOTSTRAP_HASH?.trim().toLowerCase();
  if (!configured || !/^[0-9a-f]{64}$/.test(configured)) return false;
  return timingSafeEqual(Buffer.from(sha256(value), "hex"), Buffer.from(configured, "hex"));
}

export function normalizeInvite(value: string): string {
  return value.trim().normalize("NFKC");
}

export function inviteAllowed(invite: string): boolean {
  const normalized = normalizeInvite(invite);
  if (normalized.length < 20 || normalized.length > 512) return false;
  const candidate = Buffer.from(sha256(normalized), "hex");
  const hashes = (process.env.PLANK_PLAYTEST_INVITE_HASHES || "")
    .split(",").map((v) => v.trim().toLowerCase()).filter((v) => /^[0-9a-f]{64}$/.test(v));
  return hashes.some((hash) => timingSafeEqual(candidate, Buffer.from(hash, "hex")));
}

export function cleanPin(value: unknown, digits: 4 | 6): string | null {
  return typeof value === "string" && new RegExp(`^\\d{${digits}}$`).test(value) ? value : null;
}

export function cleanDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim().normalize("NFKC").replace(/\s+/g, " ");
  return clean.length >= 1 && clean.length <= 40 ? clean : null;
}

export function usernameKey(displayName: string): string {
  return displayName.normalize("NFKC").toLocaleLowerCase("en-US");
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sessionCookie(token: string): string {
  return `${PLAYTEST_SESSION_COOKIE}=${token}; Path=/; Max-Age=${PLAYTEST_SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookie(): string {
  return `${PLAYTEST_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
