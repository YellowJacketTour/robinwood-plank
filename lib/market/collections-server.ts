import { getCollection, MARKET_COLLECTIONS } from "@/lib/market/collections";
import type { MarketCollection } from "@/lib/market/types";

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
 * DELIBERATELY A SEPARATE FILE FROM lib/market/collections.ts -- READ
 * BEFORE MOVING THIS BACK OR IMPORTING IT FROM ANY CLIENT-REACHABLE FILE
 * ---------------------------------------------------------------------------
 * This used to live in collections.ts itself, reached via a `await
 * import("@/lib/market/multichain/store")` inside the function body on the
 * theory that a dynamic import wouldn't be eagerly bundled. That assumption
 * was wrong: lib/wallet.ts (a Client Component dependency, via
 * lib/wallet-context.tsx) imports MARKET_COLLECTIONS from collections.ts,
 * and Next/Turbopack still resolves a same-file dynamic import's target
 * module into the CLIENT build graph to create its lazy chunk -- even
 * though the chunk itself only loads at runtime, the browser bundle build
 * still needs to type/module-resolve multichain/store.ts -> lib/postgres.ts
 * -> the `pg` package, which requires Node's `dns`/`net`/`tls` and has no
 * browser shim. Confirmed live: this broke the ENTIRE app with "Module not
 * found: Can't resolve 'dns'" the moment any client-rendered page loaded
 * wallet-context.tsx.
 *
 * NOT guarded by the `server-only` package on purpose: that package
 * unconditionally throws outside Next's own webpack/Turbopack bundler --
 * including under this repo's own `tsx --test` runner, which every test in
 * test/market/*.test.ts uses. It would break every test that imports this
 * file's exports directly (the whole point of collections-async.test.ts),
 * not just prevent an accidental client import. The real protection is
 * structural: nothing under components/ or any client-reachable lib file
 * imports this module -- keep it that way, and grep for
 * `collections-server` before adding a new caller to confirm it's a
 * server-side route/script/test, not a Client Component or something it
 * imports. The `native-collection`/`native-order` API routes are the only
 * sanctioned way for CLIENT code to reach this file's data.
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

// Re-exported so server-only call sites can import everything from one
// place if convenient; MARKET_COLLECTIONS/getCollection themselves stay
// defined in the client-safe collections.ts and are NOT duplicated here.
export { MARKET_COLLECTIONS, getCollection };
