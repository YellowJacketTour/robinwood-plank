import { MARKET_VAULT_ADDRESS } from "@/lib/constants";
import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import {
  ROBINWOOD_ROYALTY_BPS,
  ROBINWOOD_ROYALTY_RECEIVER,
} from "@/lib/market/royalty";
import type { MarketCollection } from "@/lib/market/types";

// See lib/constants.ts MARKET_DEFAULT_FEE_BPS for the default new
// collections below should use, e.g. `feeBps: MARKET_DEFAULT_FEE_BPS`.

/**
 * Curated allowlist — Stage A of the rollout in docs/marketplank/SPEC.md §7.
 * Add a collection here manually; there is no admin panel or database yet,
 * on purpose, until Stage B (chain-wide permissionless) is its own scoped project.
 *
 * Fee toggle: set `feeBps: 0` to turn a collection's fee off, or any other
 * value (basis points, 100 = 1%) to turn it on/adjust it — takes effect on
 * the next deploy. $PLANK/RobinWood stays 0 by design; MARKET_DEFAULT_FEE_BPS
 * is the starting point for every collection added after it.
 */
export const MARKET_COLLECTIONS: MarketCollection[] = [
  {
    slug: "robinwood",
    name: "RobinWood",
    contractAddress: NFT_CONTRACT_ADDRESS,
    tokenStandard: "ERC721",
    image: "/images/plank-logo.webp",
    trustBadges: ["lp-burned", "ownership-renounced", "verified"],
    feeBps: 0, // $PLANK trades are always free — this is the one collection that never changes.
    // The collection entry is the source of the vault link (Instant Swap).
    // RobinWood's is the env-configured V2 vault; a future collection's
    // vault goes here directly when its release promotes it.
    vaultAddress: MARKET_VAULT_ADDRESS ?? undefined,
    royaltyBps: ROBINWOOD_ROYALTY_BPS,
    royaltyRecipient: ROBINWOOD_ROYALTY_RECEIVER,
  },
  // Next collection added here defaults to MARKET_DEFAULT_FEE_BPS unless
  // given its own feeBps override, e.g. `feeBps: MARKET_DEFAULT_FEE_BPS`.
];

export function getCollection(slug: string): MarketCollection | undefined {
  return MARKET_COLLECTIONS.find((c) => c.slug === slug);
}

/**
 * Every vault address linked from a collection entry (lowercased). Combined
 * with the env-derived MARKET_VAULT_ADDRESSES at validation sites so a
 * per-collection vault is accepted the moment its collection entry ships —
 * no extra env var required.
 */
export function collectionVaultAddresses(): string[] {
  return MARKET_COLLECTIONS.flatMap((c) =>
    c.vaultAddress ? [c.vaultAddress.toLowerCase()] : []
  );
}
