/**
 * Server-only single-use guard for admin wallet-signature proofs (audit
 * finding M2, 2026-08-19).
 *
 * WHY THIS IS ITS OWN MODULE, not a function in lib/admin-auth.ts
 * ------------------------------------------------------------------
 * admin-auth.ts is imported by CLIENT components (components/admin/
 * sections/SystemSection.tsx via AdminConsole.tsx) for its pure
 * message-shaping helpers. Putting a Postgres-touching function there --
 * even behind a dynamic `await import("@/lib/postgres")` -- makes the
 * webpack client bundle follow the edge anyway and fail to resolve `pg`'s
 * node-only dependencies. That is not a bundler quirk to work around; it
 * is the bundler correctly reporting that database code has no business
 * in a browser bundle. So the datastore half lives here, imported only by
 * route handlers, and admin-auth.ts stays isomorphic.
 *
 * See 025_admin_proof_replay_guard.sql for the full threat description.
 */
import { createHash } from "node:crypto";
import { postgresQuery } from "@/lib/postgres";

/**
 * Marks an admin proof as consumed, making it single-use. Returns false if
 * this exact proof was already used.
 *
 * verifyAdminProof alone is stateless and therefore replayable for the
 * whole ADMIN_SIGNATURE_WINDOW_MS -- fine for idempotent admin actions,
 * NOT fine for anything that mints or moves value (the points grant).
 * Call this AFTER verifyAdminProof succeeds and BEFORE performing the
 * action; treat false as "reject, this is a replay".
 *
 * Fails CLOSED: if the datastore is unavailable this returns false rather
 * than silently allowing an unguarded replay.
 */
export async function consumeAdminProof(
  action: string,
  address: string,
  signature: string
): Promise<boolean> {
  try {
    const proofHash = createHash("sha256").update(signature).digest("hex");
    const result = await postgresQuery(
      `INSERT INTO plank_admin_proof_nonces (proof_hash, action, address)
       VALUES ($1, $2, $3)
       ON CONFLICT (proof_hash) DO NOTHING`,
      [proofHash, action, address.toLowerCase()]
    );
    return (result.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}
