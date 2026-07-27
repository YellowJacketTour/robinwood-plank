import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import type { MarketCollection } from "@/lib/market/types";

/**
 * Curated allowlist — Stage A of the rollout in docs/marketplank/SPEC.md §7.
 * Add a collection here manually; there is no admin panel or database yet,
 * on purpose, until Stage B (chain-wide permissionless) is its own scoped project.
 */
export const MARKET_COLLECTIONS: MarketCollection[] = [
  {
    slug: "robinwood",
    name: "RobinWood",
    contractAddress: NFT_CONTRACT_ADDRESS,
    tokenStandard: "ERC721",
    image: "/images/plank-logo.webp",
    trustBadges: ["lp-burned", "ownership-renounced", "verified"],
  },
];

export function getCollection(slug: string): MarketCollection | undefined {
  return MARKET_COLLECTIONS.find((c) => c.slug === slug);
}
