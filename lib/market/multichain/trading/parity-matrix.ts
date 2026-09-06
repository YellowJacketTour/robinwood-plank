import { CHAIN_MANIFESTS, chainManifest } from "@/lib/market/multichain/chains/manifest";

/**
 * Trading parity matrix -- chain × feature × state -- as a REGISTRY, never
 * a claim. "proven" means a real signer drove a real WRITE on that surface
 * and the evidence is named; "built-unproven" means the code path exists
 * end-to-end but no real write has been observed; "gated" means the owner
 * holds the key/flag; "unavailable" means no venue exists. Rendered in the
 * UI as coverage (components/market/TradingParityMatrix.tsx).
 *
 * Evidence lines cite the module and the date the proof was recorded in
 * this repo. Update this file when a proof lands; test/market/
 * parity-matrix.test.ts keeps every chain × feature cell present.
 */

export type TradeFeature =
  | "list" | "bulk-list" | "edit-listing" | "cancel" | "buy" | "offer" | "collection-offer" | "trait-bid"
  | "sweep-floor" | "sweep-tier" | "sweep-trait" | "sweep-multi-collection" | "sweep-cross-chain"
  | "bundle" | "swap" | "transfer" | "batch-transfer" | "bid-ladder";

export const TRADE_FEATURES: readonly TradeFeature[] = [
  "list", "bulk-list", "edit-listing", "cancel", "buy", "offer", "collection-offer", "trait-bid",
  "sweep-floor", "sweep-tier", "sweep-trait", "sweep-multi-collection", "sweep-cross-chain",
  "bundle", "swap", "transfer", "batch-transfer", "bid-ladder",
];

export type ParityState = "proven" | "built-unproven" | "gated" | "unavailable";

export type ParityCell = {
  chainSlug: string;
  feature: TradeFeature;
  state: ParityState;
  /** Where the code lives and what proved it (or what gates it). */
  evidence: string;
};

type Family = "robinhood" | "foreign-evm" | "zksync" | "solana" | "bitcoin";

function familyOf(chainSlug: string): Family {
  const m = chainManifest(chainSlug);
  if (!m) return "foreign-evm";
  if (m.kind === "custom-evm") return "robinhood";
  if (m.kind === "solana") return "solana";
  if (m.kind === "ordinals") return "bitcoin";
  if (!m.openSeaChain) return "zksync";
  return "foreign-evm";
}

const P = (evidence: string): [ParityState, string] => ["proven", evidence];
const B = (evidence: string): [ParityState, string] => ["built-unproven", evidence];
const G = (evidence: string): [ParityState, string] => ["gated", evidence];
const U = (evidence: string): [ParityState, string] => ["unavailable", evidence];

const SEAPORT_NATIVE = "lib/market/seaport.ts + native-orders route, Seaport 1.6 canonical address (live-verified 2026-08-17)";
const FOREIGN_FILL = "trading/foreign-fulfill.ts: direct Seaport fulfil + 1.8% fulfiller tip (rewired 2026-08-19)";
const BTC_TESTNET = "trading/native-bitcoin-listing.ts: OpenOrdex PSBT SIGHASH_SINGLE|ANYONECANPAY, proven end-to-end on testnet4 with a real UniSat wallet; mainnet behind NATIVE_BITCOIN_MAINNET_ENABLED";
const SOL_KEY = "MAGICEDEN_API_KEY never provided; instruction builders exist (solana-*-instruction routes) -- one real Phantom signature proves it the day the key arrives";

const MATRIX: Record<Family, Record<TradeFeature, [ParityState, string]>> = {
  robinhood: {
    list: P("Native Seaport book live on Robinhood Chain since 2026-08-01; " + SEAPORT_NATIVE),
    "bulk-list": P("lib/market/bulk-list.ts, native book"),
    "edit-listing": B("cancel + re-list path; no atomic edit primitive in Seaport"),
    cancel: P("Seaport cancel via native-orders route"),
    buy: P("trading/native-fulfill.ts fulfillMarketplankNativeOrder + multi-vault Instant Swap V3 0xacE2…047D"),
    offer: P("native offers, orders-store.ts"),
    "collection-offer": P("criteria.ts Merkle collection offers"),
    "trait-bid": P("criteria.ts trait criteria bids using seaport-js's own tree"),
    "sweep-floor": P("SweepConfirm.tsx over the native book"),
    "sweep-tier": B("rarity-tier scoped sweep built on lib/rarity.ts tiers; no signed proof recorded"),
    "sweep-trait": B("trait-scoped sweep built; no signed proof recorded"),
    "sweep-multi-collection": B("sweepForeignListingsMultiCollection shape reusable; not exercised natively"),
    "sweep-cross-chain": G("across-quote.ts / debridge-quote.ts quoted; receiver/executor contracts undeployed (FOREIGN_ACROSS_RECEIVER_ADDRESS all null)"),
    bundle: P("native-bundle-orders route, fulfillMarketplankNativeBundleOrder"),
    swap: P("native-swap-orders route, fulfillMarketplankNativeSwapOrder"),
    transfer: P("ERC-721 transfer via lib/wallet.ts sendTransaction"),
    "batch-transfer": B("per-token transfer loop; no batch primitive on the contract"),
    "bid-ladder": B("trading/bid-ladder.ts pure planner (2026-09-05); UI submits rungs as N criteria offers"),
  },
  "foreign-evm": {
    list: B("native foreign listings (MARKETPLANK_NATIVE_LISTING_FEE_BPS=180) via foreign-orders + native-orders; no mainnet signed write recorded"),
    "bulk-list": B("bulk-list.ts reused for foreign chains"),
    "edit-listing": B("cancel + re-list"),
    cancel: B("Seaport cancel on foreign chain"),
    buy: B(FOREIGN_FILL + "; fork-proven (scripts/verify-foreign-fee-router-fork.ts), no mainnet fill recorded"),
    offer: B("trading/foreign-offer.ts buildForeignOffer (WETH-denominated)"),
    "collection-offer": B("criteria collection offer through OpenSea /offers/build"),
    "trait-bid": B("foreign trait offers, fetchForeignTraitOffers + criteria"),
    "sweep-floor": B("sweepForeignListings"),
    "sweep-tier": B("tier-scoped sweep via foreign rarity store"),
    "sweep-trait": B("fetchForeignTraitFilteredListings + sweep"),
    "sweep-multi-collection": B("sweepForeignListingsMultiCollection"),
    "sweep-cross-chain": G("buyCrossChainViaAcross / buyCrossChainViaDeBridge quoted; contracts undeployed"),
    bundle: U("bundle orders are native-only (native-bundle-orders route reads the Robinhood book)"),
    swap: U("swap orders are native-only"),
    transfer: B("trading/foreign-transfer.ts"),
    "batch-transfer": B("per-token loop"),
    "bid-ladder": B("trading/bid-ladder.ts planner; rungs submit as foreign offers"),
  },
  zksync: {
    list: B("Seaport 1.6 confirmed at canonical address on 324 (2026-08-19); native listings only, no OpenSea orderbook"),
    "bulk-list": B("bulk-list.ts"),
    "edit-listing": B("cancel + re-list"),
    cancel: B("Seaport cancel"),
    buy: B("native book only; no third-party fills"),
    offer: B("native offers, WETH 0x5AEa…9a91"),
    "collection-offer": B("native criteria"),
    "trait-bid": B("native criteria"),
    "sweep-floor": B("native book"),
    "sweep-tier": B("native book + rarity"),
    "sweep-trait": B("native book + traits"),
    "sweep-multi-collection": B("native book"),
    "sweep-cross-chain": G("bridges undeployed"),
    bundle: U("native-only feature on Robinhood Chain"),
    swap: U("native-only feature on Robinhood Chain"),
    transfer: B("foreign-transfer.ts"),
    "batch-transfer": B("per-token loop"),
    "bid-ladder": B("trading/bid-ladder.ts planner only; rungs submit as native offers"),
  },
  solana: {
    list: G("listSolanaTokenNow + solana-sell-instruction; " + SOL_KEY),
    "bulk-list": G("solana-tx-batch.ts planSolanaBatches; " + SOL_KEY),
    "edit-listing": G(SOL_KEY),
    cancel: G(SOL_KEY),
    buy: G("solana-buy-instruction; " + SOL_KEY),
    offer: G("placeSolanaOfferNow / solana-bid-instruction; " + SOL_KEY),
    "collection-offer": G("Tensor/ME collection bids not wired; " + SOL_KEY),
    "trait-bid": U("no venue exposes trait bids keylessly"),
    "sweep-floor": G("sweepSolanaListingsNow / sweepSolanaListingsBatched; " + SOL_KEY),
    "sweep-tier": G("tier scope over Helius rarity; " + SOL_KEY),
    "sweep-trait": G(SOL_KEY),
    "sweep-multi-collection": G(SOL_KEY),
    "sweep-cross-chain": U("no EVM to Solana sweep route exists"),
    bundle: U("no venue exposes this on this surface"),
    swap: U("no venue exposes this on this surface"),
    transfer: B("trading/solana-transfer.ts (keyless RPC path)"),
    "batch-transfer": B("solana-tx-batch.ts"),
    "bid-ladder": G("planner + N bids; " + SOL_KEY),
  },
  bitcoin: {
    list: P("testnet4: " + BTC_TESTNET),
    "bulk-list": B("per-inscription PSBT loop"),
    "edit-listing": B("cancel + re-list"),
    cancel: P("testnet4 cancel proven with the listing engine"),
    buy: P("testnet4 buy via bitcoin-buy-psbt route; mainnet gated"),
    offer: B("bitcoin-confirm-bid route; no testnet bid proof recorded"),
    "collection-offer": U("no PSBT collection-offer primitive exists"),
    "trait-bid": U("no venue exposes this on this surface"),
    "sweep-floor": G("sweepBitcoinListingsNow; mainnet gated"),
    "sweep-tier": G("UniSat rarity is structurally partial; mainnet gated"),
    "sweep-trait": U("no trait-scoped book exists on this surface"),
    "sweep-multi-collection": G("mainnet gated"),
    "sweep-cross-chain": U("no bridge route exists for this pair"),
    bundle: U("no venue exposes this on this surface"),
    swap: U("no venue exposes this on this surface"),
    transfer: P("testnet4: trading/bitcoin-transfer.ts + bitcoin-utxo-safety.ts dummy-UTXO sat preservation"),
    "batch-transfer": B("per-inscription loop"),
    "bid-ladder": U("no venue exposes this on this surface"),
  },
};

export function parityCell(chainSlug: string, feature: TradeFeature): ParityCell {
  const [state, evidence] = MATRIX[familyOf(chainSlug)][feature];
  return { chainSlug, feature, state, evidence };
}

export function parityForChain(chainSlug: string): ParityCell[] {
  return TRADE_FEATURES.map((f) => parityCell(chainSlug, f));
}

export function fullParityMatrix(): ParityCell[] {
  return CHAIN_MANIFESTS.flatMap((m) => parityForChain(m.chainSlug));
}

export function paritySummary(cells: ParityCell[]): Record<ParityState, number> {
  const out: Record<ParityState, number> = { proven: 0, "built-unproven": 0, gated: 0, unavailable: 0 };
  for (const c of cells) out[c.state] += 1;
  return out;
}
