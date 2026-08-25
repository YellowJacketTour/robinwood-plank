/**
 * Real bug found live 2026-08-25 ("this isnt live time updating"): every
 * real page visit and viewport-visibility POST calls hydrationJobSources,
 * which used to import isAnchoredMembershipComplete straight from
 * anchored-membership-backfill.ts -- a file whose top-level imports pull
 * in the ENTIRE HyperSync client dependency chain (hypersync-evm-scan.ts
 * -> @envio-dev/hypersync-client, a native NAPI binding). Next.js's dev
 * bundler cannot resolve that native binding in the API-route execution
 * context (confirmed live: "Cannot find native binding" thrown and
 * SILENTLY swallowed by the route's own bare `.catch(() => {})`, on
 * every single real page visit) even though a plain tsx script resolves
 * it fine -- meaning the real demand-signal re-enqueue for anchored-
 * membership had been dying silently on every real visit through the
 * actual running app the whole time this feature existed.
 *
 * This file holds ONLY the cheap DB-flag check every page visit needs,
 * with zero import of anything HyperSync-related, so the real,
 * heavyweight scan-running code (anchored-membership-backfill.ts) stays
 * completely out of the live request path -- it is only ever reached
 * from the background mesh-lane.ts dispatcher, never from a browser-
 * facing API route.
 */
import { postgresQuery } from "@/lib/postgres";

const completeCache = new Map<string, { value: boolean; at: number }>();
const COMPLETE_CACHE_TTL_MS = 60_000;

export async function isAnchoredMembershipComplete(chainSlug: string, contractAddress: string): Promise<boolean> {
  const key = `${chainSlug}:${contractAddress.toLowerCase()}`;
  const cached = completeCache.get(key);
  if (cached && Date.now() - cached.at < COMPLETE_CACHE_TTL_MS) return cached.value;

  const result = await postgresQuery<{ anchored_membership_complete: boolean }>(
    `SELECT anchored_membership_complete FROM plank_contract_deploy_block WHERE chain_slug = $1 AND contract_address = $2`,
    [chainSlug, contractAddress.toLowerCase()]
  );
  const value = result.rows[0]?.anchored_membership_complete === true;
  completeCache.set(key, { value, at: Date.now() });
  return value;
}
