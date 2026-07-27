import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
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
  },
  // Next collection added here defaults to MARKET_DEFAULT_FEE_BPS unless
  // given its own feeBps override, e.g. `feeBps: MARKET_DEFAULT_FEE_BPS`.
];

export function getCollection(slug: string): MarketCollection | undefined {
  return MARKET_COLLECTIONS.find((c) => c.slug === slug);
}
