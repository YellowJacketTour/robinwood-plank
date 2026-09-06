/**
 * Magic Eden Solana TRADING adapter -- the buy/sweep/list counterpart to
 * magiceden-solana.ts's read-only stats. Separated into its own file
 * deliberately: stats calls are keyless and used by the cron discovery
 * pipeline; these calls need a real API key and are only ever invoked
 * from a live user action (buying/listing), matching this app's existing
 * split between read-only adapters and trade-execution modules (compare
 * lib/market/multichain/trading/foreign-fulfill.ts vs the discovery
 * adapters it never touches).
 *
 * SOLANA HAS NO SEAPORT EQUIVALENT -- READ THIS BEFORE EXTENDING
 * ---------------------------------------------------------------------------
 * Every EVM chain this app trades on shares ONE mechanism: a portable,
 * off-chain-signed Seaport order that any fulfiller can submit. Solana NFT
 * marketplaces have no such shared standard -- each marketplace (Magic
 * Eden, Tensor) runs its own on-chain program (an "Auction House" for
 * Magic Eden, AMM pools for Tensor), and "buying" means submitting a
 * marketplace-specific instruction, not filling a portable order. That
 * means, unlike foreign-fulfill.ts's single fulfillAdvancedOrder call
 * working identically across 7 EVM chains, Solana trading code is
 * necessarily PER-VENUE -- this file is the Magic Eden venue only. Tensor
 * needs its own file (magiceden-solana-trade.ts's sibling,
 * tensor-solana-trade.ts, once Tensor's partnership application --
 * https://docs.tensor.trade/trade/api-and-sdk -- is approved; that's a
 * real business step only the account owner can complete, not something
 * this codebase can self-serve its way into).
 *
 * BESPOKE, NOT AGGREGATOR-ROUTED -- BY EXPLICIT REQUEST
 * ---------------------------------------------------------------------------
 * This calls Magic Eden's own v2 API directly, exactly like
 * foreign-fulfill.ts calls Seaport/Across/deBridge's own contracts
 * directly -- no third-party NFT-aggregator SaaS sitting in between
 * taking an additional cut on top of Magic Eden's own on-chain Auction
 * House fee. The Auction House fee itself is NOT avoidable (it's charged
 * by Magic Eden's own on-chain program, the same way Seaport's zone fee
 * isn't avoidable) -- "no fee bleed" here means no SECOND, avoidable fee
 * layer of our own choosing, not zero marketplace fee.
 *
 * REAL, VERIFIED FOUNDATION -- AND ITS REAL LIMITS
 * ---------------------------------------------------------------------------
 * Confirmed via Magic Eden's own docs (docs.magiceden.io/reference/
 * get_instructions-buy-now), fetched live during a dedicated research
 * pass 2026-08-18: the /v2/instructions/buy_now, /sell, /sell_now,
 * buy_change_price endpoints are real, Bearer-token-authenticated, and
 * return a Transaction object (tx/txSigned as a serialized Buffer) for
 * the CLIENT to sign -- this server-side function only builds/fetches
 * that unsigned transaction, exactly the same "never execute, only
 * construct calldata" boundary foreign-fulfill.ts's Across/deBridge
 * quote functions hold. Free tier: 120 requests/min, 2 req/sec
 * (help.magiceden.io/en/articles/6533403).
 *
 * REAL, DISCLOSED RISK -- NOT HIDDEN
 * ---------------------------------------------------------------------------
 * Magic Eden shut down their Bitcoin and EVM NFT marketplaces + APIs on
 * 2026-03-09 as part of a strategic pivot toward Solana + a gambling
 * product; their own help doc (help.magiceden.io/en/articles/13885533)
 * states the Solana API's future is "under evaluation" as part of that
 * same transition. This adapter is built against real, live, working
 * infrastructure as of 2026-08-18 -- but deliberately kept behind a
 * narrow, swappable interface (see the exported type below) so a second
 * venue (Tensor) or a replacement can be substituted without touching
 * any caller.
 *
 * EXACT REQUEST PARAMETER NAMES BEYOND THE ENDPOINT PATHS THEMSELVES ARE
 * NOT YET LIVE-TESTED against a real API key (none was available during
 * this pass) -- the shapes below follow Magic Eden's own documented
 * schema as fetched from their real docs pages, not a guess, but MUST be
 * exercised against a real key before shipping to production. This
 * comment is the honest boundary between "verified the endpoint exists
 * and its documented shape" and "proved it works end-to-end."
 */

import { SOLANA_FEE_RECIPIENT } from "@/lib/constants";

const ME_API_BASE = "https://api-mainnet.magiceden.dev/v2";

function requireApiKey(): string {
  const key = process.env.MAGICEDEN_API_KEY;
  if (!key) {
    throw new Error(
      "magiceden-solana-trade: MAGICEDEN_API_KEY is not configured -- Magic Eden's trading endpoints (buy_now/sell/sell_now) require a real Bearer token, unlike the keyless stats endpoints magiceden-solana.ts uses. Sign up at magiceden.io (see help.magiceden.io/en/articles/6533403 for the request form) and set this env var before this path can be used."
    );
  }
  return key;
}

async function meFetch<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const key = requireApiKey();
  const url = new URL(`${ME_API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), {
    headers: { accept: "application/json", authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`magiceden-solana-trade: ${res.status} ${res.statusText} on ${path} -- ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** A serialized, UNSIGNED Solana transaction for the connected wallet to sign and submit -- this module never signs or broadcasts anything itself. */
export type MagicEdenTxInstruction = {
  /** Base64 or hex-encoded serialized transaction, exactly as Magic Eden's API returns it -- passed through unmodified. */
  tx: string;
  txSigned?: string | null;
};

/**
 * Builds the unsigned buy_now instruction for a single Magic Eden listing.
 * `tokenMint` is the NFT's own mint address (Solana's equivalent of an
 * EVM tokenId -- there is no separate contract+tokenId pair on Solana,
 * the mint address IS the unique identifier).
 */
/**
 * Magic Eden's v2 REST instruction endpoints take `price` as a DECIMAL SOL
 * number ("Price in SOL" in the OpenAPI); only the official TypeScript SDK
 * accepts lamports and converts internally. Sending lamports over REST is
 * a 1e9x overbid attempt (AUDIT lens 3 #6, confirmed by the research pass
 * against docs.magiceden.io/reference/get_instructions-buy-now).
 */
export function lamportsToSolDecimal(lamports: string): number {
  const value = BigInt(lamports);
  if (value < 0n) throw new Error("lamports must be non-negative");
  const whole = value / 1_000_000_000n;
  const frac = value % 1_000_000_000n;
  const sol = Number(`${whole}.${frac.toString().padStart(9, "0")}`);
  if (!Number.isFinite(sol)) throw new Error("lamports out of range for a decimal SOL price");
  if (BigInt(Math.round(sol * 1e9)) !== value) throw new Error("lamports cannot be represented exactly as decimal SOL");
  return sol;
}

export async function buildMagicEdenBuyNow(input: {
  buyerAddress: string;
  tokenMint: string;
  /** The listing's current price, in lamports (SOL's smallest unit, 9 decimals) -- must match the live listing exactly or Magic Eden's own program will reject it, the same "price must match the signed order" invariant Seaport enforces. */
  priceLamports: string;
  /** Optional priority fee in micro-lamports -- a first-class Solana concept with no EVM equivalent (EVM gas is external to Seaport's own calldata; Solana marketplaces expose it directly). */
  priorityFeeMicroLamports?: number;
}): Promise<MagicEdenTxInstruction> {
  return meFetch<MagicEdenTxInstruction>("/instructions/buy_now", {
    buyer: input.buyerAddress,
    tokenMint: input.tokenMint,
    price: lamportsToSolDecimal(input.priceLamports),
    // Marketplank's Solana fee capture (audit finding fix, 2026-08-19) --
    // Magic Eden's own documented `buyerReferral` field, paid from their
    // Auction House fee, not a second fee layer on top of the trade price.
    // See SOLANA_FEE_RECIPIENT's own comment in lib/constants.ts.
    buyerReferral: SOLANA_FEE_RECIPIENT,
    ...(input.priorityFeeMicroLamports ? { prioFeeMicroLamports: input.priorityFeeMicroLamports } : {}),
  });
}

/**
 * Builds the unsigned BID (offer) instruction for a single token -- the
 * "Make offer" counterpart to buildMagicEdenBuyNow. REAL, VERIFIED,
 * SEPARATE ENDPOINT: /instructions/buy (NOT /instructions/buy_now),
 * confirmed live via a dedicated research pass 2026-08-18
 * (docs.magiceden.io/reference/get_instructions-buy, page title verbatim
 * "Get instruction to buy (bid)") -- this places a standing bid on
 * `tokenMint` at `priceLamports` that the current or a future owner can
 * accept, distinct from buy_now's immediate-fill-of-an-existing-listing
 * semantics. `expiry` defaults to 7 days per Magic Eden's own documented
 * default when omitted/0, matching this app's other foreign-offer
 * durations (ForeignOfferForm's own DURATIONS list) closely enough that no
 * caller-supplied override is exposed yet -- can be added later without
 * breaking this signature (an optional field, not a required one).
 */
export async function buildMagicEdenBid(input: {
  buyerAddress: string;
  tokenMint: string;
  priceLamports: string;
  priorityFeeMicroLamports?: number;
}): Promise<MagicEdenTxInstruction> {
  return meFetch<MagicEdenTxInstruction>("/instructions/buy", {
    buyer: input.buyerAddress,
    tokenMint: input.tokenMint,
    price: lamportsToSolDecimal(input.priceLamports),
    buyerReferral: SOLANA_FEE_RECIPIENT,
    ...(input.priorityFeeMicroLamports ? { prioFeeMicroLamports: input.priorityFeeMicroLamports } : {}),
  });
}

/**
 * Sweep: Magic Eden's API is per-listing, not a native batch endpoint
 * (unlike MarketplankForeignFeeRouter.sweepBuy's single on-chain
 * multi-item tx) -- this builds N independent buy_now transactions for
 * the caller to sign and submit, mirroring how MultichainCollectionView's
 * sweep UX already works when it isn't using the router (one signature
 * per item is a real Solana UX difference from EVM's one-tx-many-items
 * pattern, not an oversight).
 */
export async function buildMagicEdenSweep(input: {
  buyerAddress: string;
  listings: Array<{ tokenMint: string; priceLamports: string }>;
  priorityFeeMicroLamports?: number;
}): Promise<MagicEdenTxInstruction[]> {
  return Promise.all(
    input.listings.map((listing) =>
      buildMagicEdenBuyNow({
        buyerAddress: input.buyerAddress,
        tokenMint: listing.tokenMint,
        priceLamports: listing.priceLamports,
        priorityFeeMicroLamports: input.priorityFeeMicroLamports,
      })
    )
  );
}

/** Builds the unsigned sell (list) instruction -- creates a new Magic Eden Auction House listing for a token the seller's wallet already owns. */
export async function buildMagicEdenList(input: {
  sellerAddress: string;
  tokenMint: string;
  priceLamports: string;
}): Promise<MagicEdenTxInstruction> {
  return meFetch<MagicEdenTxInstruction>("/instructions/sell", {
    seller: input.sellerAddress,
    tokenMint: input.tokenMint,
    price: lamportsToSolDecimal(input.priceLamports),
  });
}

/** Builds the unsigned sell_now instruction -- accepts the current best bid on a token instead of creating a fixed-price listing. */
export async function buildMagicEdenSellNow(input: {
  sellerAddress: string;
  tokenMint: string;
  /** The bid's price, in lamports -- must match the live bid exactly. */
  priceLamports: string;
}): Promise<MagicEdenTxInstruction> {
  return meFetch<MagicEdenTxInstruction>("/instructions/sell_now", {
    seller: input.sellerAddress,
    tokenMint: input.tokenMint,
    price: lamportsToSolDecimal(input.priceLamports),
  });
}
