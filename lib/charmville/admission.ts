import type { Pool, PoolClient } from "pg";
import { YardError } from "./errors";

type Environment = Record<string, string | undefined>;
export type CharmvilleAdmissionMode = "disabled" | "private" | "local-development";

/** Server-only policy. Missing or malformed production configuration never opens the game. */
export function charmvilleAdmissionMode(env: Environment = process.env): CharmvilleAdmissionMode {
  const configured = env.CHARMVILLE_ACCESS_MODE?.trim();
  if (!configured) return env.NODE_ENV === "development" ? "local-development" : "disabled";
  if (configured === "private") return "private";
  if (configured === "local-development" && env.NODE_ENV === "development") return "local-development";
  return "disabled";
}

function wallets(raw: string | undefined): Set<string> {
  const entries = (raw ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  // A malformed list disables that entire authority source, rather than accepting a partial typo.
  if (!entries.every(value => /^0x[a-f0-9]{40}$/.test(value))) return new Set();
  return new Set(entries);
}

/** Call after session validation, inside the mutation transaction when one exists.
 * Profile identity and wallet are always database-derived. Grants do not mint a new account.
 */
export async function requireCharmvilleAdmission(
  db: Pool | PoolClient, profileId: string, env: Environment = process.env,
): Promise<{ profileId: string; wallet: string; role: "admin" | "player"; mode: "private" | "local-development" }> {
  const mode = charmvilleAdmissionMode(env);
  if (mode === "disabled") throw new YardError("Charmville is not open on this deployment",403);
  if (!/^[1-9]\d{0,17}$/.test(profileId)) throw new YardError("Sign in to your PlankSpace profile",401);
  const profile = (await db.query<{ wallet: string }>(
    "SELECT wallet FROM plankspace_profiles WHERE id=$1 AND moderation_status='approved'",[profileId],
  )).rows[0];
  if (!profile) throw new YardError("Your PlankSpace profile is unavailable",403);
  const wallet = profile.wallet.toLowerCase();
  const isAdmin = wallets(env.CHARMVILLE_ADMIN_WALLETS).has(wallet);
  if (mode === "local-development" || isAdmin || wallets(env.CHARMVILLE_ALLOWED_WALLETS).has(wallet))
    return {profileId,wallet,role:isAdmin ? "admin" : "player",mode};
  const grant = await db.query(`SELECT 1 FROM charmville_admission_grants
    WHERE profile_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()`,[profileId]);
  if (!grant.rowCount) throw new YardError("Charmville is invite-only. This account needs access",403);
  return {profileId,wallet,role:"player",mode};
}
