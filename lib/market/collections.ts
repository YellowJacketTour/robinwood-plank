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
 * "Stage B" resolution -- the async counterpart getCollection() itself
 * deliberately never became, so every EXISTING sync caller (royalty
 * annotation, etc.) keeps working unchanged. This is the new path: when
 * a slug isn't in the hand-curated MARKET_COLLECTIONS allowlist, check
 * whether it's a real, contract-address-shaped slug that
 * robinhood-chain-scan.ts's automated discovery has already vetted (real
 * ERC-721 interface, real per-token art -- see that file's own
 * isNotRealCollectibleArt gate) and registered into
 * plank_multichain_collections under chainSlug "robinhood".
 *
 * SECURITY NOTE, READ BEFORE EXTENDING: this is a real trust-boundary
 * change for app/api/market/orders/route.ts's BAD_COLLECTION gate --
 * before this function existed, ONLY a human-reviewed entry in
 * MARKET_COLLECTIONS could ever have a real signed order accepted by
 * that endpoint. Now, anything the automated Robinhood Chain scanner
 * discovers can too. This is the SAME trust bar the 7 foreign chains
 * already operate under (their own discovery is equally automated, no
 * human review gate) -- consistent, not a new lower bar, but worth
 * stating explicitly since this is the FIRST time that bar applies to
 * the home chain's own order-acceptance endpoint, not just a read-only
 * multichain index.
 */
export async function getCollectionAsync(slug: string): Promise<MarketCollection | undefined> {
  const curated = getCollection(slug);
  if (curated) return curated;

  if (!/^0x[0-9a-fA-F]{40}$/.test(slug)) return undefined;

  const { listTrackedCollections } = await import("@/lib/market/multichain/store");
  const all = await listTrackedCollections().catch(() => []);
  const found = all.find(
    (c) => c.chainSlug === "robinhood" && c.contractAddress.toLowerCase() === slug.toLowerCase()
  );
  if (!found) return undefined;

  const { MARKET_DEFAULT_FEE_BPS } = await import("@/lib/constants");
  return {
    // The contract address itself is the slug for an auto-discovered
    // collection -- there is no human-chosen friendly name to route by,
    // and using the address keeps this collision-free by construction
    // (unlike a discovered display NAME, which could plausibly collide
    // with "robinwood" or a future curated slug).
    slug: found.contractAddress,
    name: found.name ?? found.contractAddress,
    contractAddress: found.contractAddress,
    tokenStandard: "ERC721",
    image: found.imageUrl ?? "/images/plank-logo.webp",
    trustBadges: [],
    feeBps: MARKET_DEFAULT_FEE_BPS,
    // Real EIP-2981 royaltyInfo() has not been queried on-chain for an
    // auto-discovered collection -- 0/zero-address is the honest default
    // (no royalty enforced) rather than guessing a rate. A future pass
    // could query royaltyInfo() the same way art/name get resolved during
    // discovery, but that's real new work, not a safe assumption to bake
    // in here.
    royaltyBps: 0,
    royaltyRecipient: "0x0000000000000000000000000000000000000000",
  };
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
