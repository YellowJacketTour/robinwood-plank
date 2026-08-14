import crypto from "node:crypto";
import { hasPostgresConfig, postgresQuery } from "@/lib/postgres";
import { TradeApiError } from "@/lib/uniswap-server";

/**
 * Opaque referral codes (migration 012_referral_codes.sql).
 *
 * An invite link used to carry the referrer's wallet address, so sharing one
 * publicly published that address to everyone who saw it. A code carries no
 * information about the wallet it resolves to; the mapping lives here, on the
 * server.
 *
 * The code is RANDOM rather than derived from the address. A plain hash would
 * be computable by anyone: every $PLANK holder is public chain data, so an
 * attacker hashes a list of known wallets and matches against a shared code
 * to recover the address, which defeats the point entirely. A keyed hash
 * closes that but adds a production secret to provision and rotate. Random
 * needs neither.
 */

/**
 * Crockford-style alphabet: no I, L, O, U, or digits 0/1. These codes get
 * read off one screen and typed into another, and O/0 and I/1 are the pairs
 * people get wrong. Excluding U additionally avoids a whole category of
 * accidental words.
 */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;

/** 30^8 ≈ 6.5e11. At any realistic user count, collisions are rare enough
 * that the retry loop below effectively never runs twice — and unguessable
 * enough that enumerating codes is not a way to discover wallets. */
export function generateReferralCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/** Accepts what a user might paste: any case, surrounding whitespace. */
export function normalizeReferralCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isReferralCode(value: string): boolean {
  const code = normalizeReferralCode(value);
  return code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c));
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function requireConfigured(): void {
  if (!hasPostgresConfig()) {
    throw new TradeApiError(
      503,
      "REFERRAL_NOT_CONFIGURED",
      "Referral tracking is not configured on the server."
    );
  }
}

/**
 * This wallet's code, creating one on first request.
 *
 * Stable for the life of the wallet: regenerating on each view would
 * invalidate every link already shared, and a referral link that stops
 * working is worse than no referral link. The ON CONFLICT on wallet_address
 * makes concurrent first-views converge on one code rather than racing to
 * create two.
 */
/**
 * This wallet's code if it already has one, WITHOUT allocating.
 *
 * Exists so a read endpoint can stay a read. Allocation used to happen
 * inside /api/referral/me, which meant querying any address minted a row —
 * an unauthenticated public GET that writes, and one an attacker can point
 * at an enumerated list of wallets to grow the table indefinitely.
 */
export async function peekReferralCode(walletAddress: string): Promise<string | null> {
  requireConfigured();
  const wallet = walletAddress.trim().toLowerCase();
  if (!HEX_ADDRESS.test(wallet)) return null;
  const result = await postgresQuery<{ code: string }>(
    `SELECT code FROM plank_referral_codes WHERE wallet_address = $1`,
    [wallet]
  );
  return result.rows[0]?.code ?? null;
}

export async function getOrCreateReferralCode(walletAddress: string): Promise<string> {
  requireConfigured();
  const wallet = walletAddress.trim().toLowerCase();
  if (!HEX_ADDRESS.test(wallet)) {
    throw new TradeApiError(400, "BAD_WALLET_ADDRESS", "wallet must be a valid 0x address.");
  }

  const existing = await postgresQuery<{ code: string }>(
    `SELECT code FROM plank_referral_codes WHERE wallet_address = $1`,
    [wallet]
  );
  if (existing.rows[0]) return existing.rows[0].code;

  // Retry only guards a code collision (PRIMARY KEY on code). A concurrent
  // insert for the SAME wallet is handled by the wallet_address conflict
  // clause returning nothing, after which the re-read below wins.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateReferralCode();
    const inserted = await postgresQuery<{ code: string }>(
      `INSERT INTO plank_referral_codes (code, wallet_address)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING code`,
      [code, wallet]
    );
    if (inserted.rows[0]) return inserted.rows[0].code;

    const raced = await postgresQuery<{ code: string }>(
      `SELECT code FROM plank_referral_codes WHERE wallet_address = $1`,
      [wallet]
    );
    if (raced.rows[0]) return raced.rows[0].code;
  }
  throw new TradeApiError(500, "CODE_GENERATION_FAILED", "Could not allocate a referral code.");
}

/** The wallet a code belongs to, or null if the code is not real. */
export async function resolveReferralCode(rawCode: string): Promise<string | null> {
  requireConfigured();
  const code = normalizeReferralCode(rawCode);
  if (!isReferralCode(code)) return null;
  const result = await postgresQuery<{ wallet_address: string }>(
    `SELECT wallet_address FROM plank_referral_codes WHERE code = $1`,
    [code]
  );
  return result.rows[0]?.wallet_address ?? null;
}

/**
 * Resolve whatever arrived in `?ref=` to a referrer address.
 *
 * Accepts a raw 0x address as well as a code. Address links are what 010
 * shipped, and some are already in circulation — rejecting them would break
 * real invites to protect a privacy property their sender already gave up.
 * Nothing GENERATES an address link any more (see components/trade/
 * ReferralPanel.tsx), so the exposure stops growing.
 *
 * @returns the referrer address, or null when the input resolves to nothing.
 */
export async function resolveReferrer(rawRef: string): Promise<string | null> {
  const ref = rawRef.trim();
  if (HEX_ADDRESS.test(ref)) return ref.toLowerCase();
  return resolveReferralCode(ref);
}
