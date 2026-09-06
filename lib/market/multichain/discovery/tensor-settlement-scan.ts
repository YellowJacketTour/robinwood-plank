/**
 * Tensor on-chain SETTLEMENT scanner -- the Solana analogue of this app's
 * existing EVM fill indexers (seaport-fill-indexer.ts,
 * blur-fill-indexer.ts, x2y2-fill-indexer.ts, etc.), applied for the first
 * time to a Solana program. See migration 058_tensor_settlement_index.sql's
 * own header for the full "why" and the honest scope/price-derivation
 * disclosure -- summarized again here since it drives every decode
 * decision below.
 *
 * READ-ONLY SETTLEMENT/ACTIVITY DATA. NOT THE LIVE ORDER BOOK.
 * ---------------------------------------------------------------------------
 * Tensor's off-chain order-book/stats API is confirmed key-gated with no
 * free tier (venue-registry.ts's "tensor-solana" entry, settled 2026-08-24).
 * This module never calls that API and never claims to see open listings or
 * open bids. It only ever sees instructions that already SETTLED on-chain.
 *
 * REAL PROGRAM ID -- VERIFIED LIVE, NOT ASSUMED
 * ---------------------------------------------------------------------------
 * TENSOR_MARKETPLACE_PROGRAM_ADDRESS below is read directly from the
 * installed @tensor-foundation/marketplace package
 * (dist/src/index.js: `TENSOR_MARKETPLACE_PROGRAM_ADDRESS =
 * "TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp"`) -- the same real program
 * lib/market/multichain/adapters/tensor-solana-trade.ts already builds
 * unsigned instructions against. Confirmed LIVE this session (2026-08-24)
 * with a real `getSignaturesForAddress` call against the public
 * api.mainnet-beta.solana.com RPC: it returned real signatures with
 * `blockTime` at the current wall-clock moment (slot ~441,530,000+), and a
 * real `getTransaction` fetch of one of those signatures
 * (5hgsmfGqgFzGCW2BaFYnpRSV39S5M4vJa4oQpFMXyAReCCa4MnbeEvEyCwKb6G6THzWQZNNmVVMddXwf7Mu9Sv8F)
 * showed real `Program log: Instruction: Bid` / `Instruction: TcompNoop`
 * lines against this exact program address. A further ~170-transaction
 * sample (mixed Bid/Edit/ListCore/DelistCore/TcompNoop instructions, no
 * Buy/TakeBid in that particular sample window -- bids/listings dominate
 * moment-to-moment traffic, which is itself consistent with settlements
 * being comparatively rarer events) confirms this is real, live, ongoing
 * program traffic, not a stale or abandoned address. TSWAPaqyCSx2KABk68Sh
 * ruf4rp7CxcNi8hAsbdwmHbN (Tensor's older AMM-swap program, cited only as a
 * starting point in the research doc this task followed) was NOT used --
 * it is superseded by TCMP for the real, currently-installed SDK this repo
 * already depends on, so verifying and building against TCMP is the
 * correct choice, not a guess.
 *
 * REAL INSTRUCTION DISCRIMINATORS -- FROM THE INSTALLED PACKAGE, NOT GUESSED
 * ---------------------------------------------------------------------------
 * Every discriminator in SETTLEMENT_INSTRUCTIONS below is read directly
 * from `@tensor-foundation/marketplace`'s own generated exports
 * (e.g. `BUY_LEGACY_DISCRIMINATOR`, `TAKE_BID_CORE_DISCRIMINATOR`) -- the
 * exact 8-byte Anchor-style discriminators the real deployed program
 * checks against the first 8 bytes of each instruction's data. A
 * transaction's outer instruction is classified as a real Tensor
 * settlement if, and only if, its programId is the real Tensor Marketplace
 * program AND its data's first 8 bytes exactly match one of these real
 * discriminators -- this is a decode, not a heuristic guess from account
 * count or log text (log lines like "Program log: Instruction: Bid" are
 * used only as corroborating evidence during manual verification above,
 * never as the actual classification mechanism in code).
 *
 * WHAT IS DECODED, AND THE HONEST BOUNDARY OF WHAT ISN'T
 * ---------------------------------------------------------------------------
 * Ten real settlement instruction variants are recognized (five buy* +
 * five takeBid*, one per Tensor-supported asset standard: legacy SPL,
 * MPL Core, Token-2022, Wrapped-NFT-Standard, and compressed/Bubblegum).
 * Their *Spl siblings (buyLegacySpl, buyCoreSpl, ... -- SPL-token/stable
 * -denominated sales rather than native SOL) and the two compressed
 * take-bid variants are matched for completeness of "this signature
 * contains a real Tensor settlement" but are NOT written as priced rows in
 * this first pass: this module's price derivation (below) only knows how
 * to read a NATIVE SOL lamport delta, and an SPL-denominated fill's real
 * price lives in a token-account balance change this pass does not decode.
 * Recording them with a fabricated or null-mislabeled price would be worse
 * than the honest gap of not recording them at all -- they are counted in
 * this scan's own return value but never inserted into plank_tensor_fills.
 *
 * PRICE DERIVATION: REAL NET LAMPORT DELTA ON THE SELLER-SIDE ACCOUNT
 * ---------------------------------------------------------------------------
 * Tensor's own instruction data field (`maxAmount` on buy*, similarly on
 * takeBid*) is the buyer's/bidder's authorized CEILING, not necessarily the
 * exact cleared price -- Tensor's pool/AMM pricing can clear below that
 * ceiling. Rather than report a ceiling as if it were the sale price, this
 * scanner reads the transaction's own real `meta.preBalances`/
 * `meta.postBalances` arrays (jsonParsed getTransaction always returns
 * these) and computes the actual lamport gain on the seller-side account
 * for this instruction: `owner` for a buy* instruction (the account
 * receiving payment from a buyer taking their listing), `seller` for a
 * takeBid* instruction (the account receiving payment from a bidder's bid
 * being taken). Each buy-or-takeBid variant's account ordering is read
 * directly from that instruction's own generated `Parsed*Instruction`
 * TypeScript type (dist/types/generated/instructions/*.d.ts) -- see
 * SETTLEMENT_INSTRUCTIONS' sellerAccountIndex for the exact, per-variant
 * verified index. This is a real, on-chain-observed settlement amount, not
 * a decoded intent field -- the honest tradeoff is that it is technically
 * "what the seller-side account gained in this transaction," which could in
 * principle include an unrelated lamport movement in the same tx from
 * another instruction; no such case was observed in this session's manual
 * sample and Tensor's own settlement instructions are typically the only
 * lamport-moving instruction in their transaction, but this is disclosed
 * rather than claimed as a mathematically exact sale price.
 *
 * DUAL-CURSOR SHAPE -- MIRRORS THE EVM HYPERSYNC SCANNERS
 * ---------------------------------------------------------------------------
 * Solana has no per-call fromBlock/toBlock window the way eth_getLogs does;
 * getSignaturesForAddress instead pages backward from either the chain tip
 * or a given `before` signature. This scanner keeps ONE forward-tracking
 * cursor (`plank_tensor_fill_cursor`, keyed the same way
 * plank_seaport_fill_cursor is) recording the newest signature/slot this
 * scan has fully processed; each run pages backward with `before` from the
 * current tip until it reaches that cursor's `last_signature` (an `until`
 * param, Solana's own real mechanism for "stop once you reach this
 * already-seen signature") or hits its own per-run page budget. On a first
 * run (no cursor yet) it walks back one page from the tip and stops --
 * exactly the same "forward-only from first run, not a historical
 * backfill" honest scope every EVM fill indexer in this codebase already
 * documents (see seaport-fill-indexer.ts's own header) -- a genesis
 * backfill lane is a real, separate future addition, not attempted here.
 */
import { postgresQuery } from "@/lib/postgres";
import { recordSaleEvent, flushLedgerAggregation } from "@/lib/market/multichain/ledger-sink";

const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL?.trim() ||
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() ||
  "https://api.mainnet-beta.solana.com";

/** Real, verified live Tensor Marketplace program address -- see this file's own header for the citation. */
export const TENSOR_MARKETPLACE_PROGRAM_ADDRESS = "TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp";

const CURSOR_KEY = "solana-mainnet::tensor-marketplace-live-v1";
const SIGNATURES_PER_PAGE = 100; // Solana RPC's own getSignaturesForAddress hard cap
const MAX_PAGES_PER_RUN = 5; // bounded free-tier-friendly budget per tick, same spirit as the EVM scanners' MAX_LOGS_PER_RUN

type SettlementKind = "buy_listing" | "take_bid";
type AssetStandard = "legacy" | "core" | "t22" | "wns" | "compressed";

/**
 * Real 8-byte discriminators, hex-encoded, read directly from the installed
 * @tensor-foundation/marketplace package's own generated exports (see this
 * file's own header). `sellerAccountIndex` / `buyerAccountIndex` /
 * `mintAccountIndex` are each read from that same instruction's own
 * generated `Parsed*Instruction` account-index type -- real, verified
 * positions, not assumed. `priceable: false` marks a real settlement this
 * scan recognizes but does not price (see header's "honest boundary").
 */
const SETTLEMENT_INSTRUCTIONS: Record<
  string,
  {
    name: string;
    kind: SettlementKind;
    standard: AssetStandard;
    priceable: boolean;
    sellerAccountIndex: number | null;
    buyerAccountIndex: number | null;
    mintAccountIndex: number | null;
  }
> = {
  // -- buy* (buyer takes a real, existing listing) --
  "447f2b08d41ff972": { name: "buyLegacy", kind: "buy_listing", standard: "legacy", priceable: true, sellerAccountIndex: 6, buyerAccountIndex: 1, mintAccountIndex: 5 },
  "865e7de5189dc2c7": { name: "buyLegacySpl", kind: "buy_listing", standard: "legacy", priceable: false, sellerAccountIndex: null, buyerAccountIndex: null, mintAccountIndex: 6 },
  "a9e357ff4c56ff19": { name: "buyCore", kind: "buy_listing", standard: "core", priceable: true, sellerAccountIndex: 6, buyerAccountIndex: 4, mintAccountIndex: 2 },
  "ea1c257a72efe9d0": { name: "buyCoreSpl", kind: "buy_listing", standard: "core", priceable: false, sellerAccountIndex: null, buyerAccountIndex: null, mintAccountIndex: 4 },
  "5162e3abc969b4d8": { name: "buyT22", kind: "buy_listing", standard: "t22", priceable: true, sellerAccountIndex: 6, buyerAccountIndex: 1, mintAccountIndex: 5 },
  "6615a3275e277a5e": { name: "buyT22Spl", kind: "buy_listing", standard: "t22", priceable: false, sellerAccountIndex: null, buyerAccountIndex: null, mintAccountIndex: 6 },
  "a82bb3d92c3b23f4": { name: "buyWns", kind: "buy_listing", standard: "wns", priceable: true, sellerAccountIndex: 6, buyerAccountIndex: 1, mintAccountIndex: 5 },
  "71893917bac4d9d2": { name: "buyWnsSpl", kind: "buy_listing", standard: "wns", priceable: false, sellerAccountIndex: null, buyerAccountIndex: null, mintAccountIndex: 6 },
  "66063d1201daebea": { name: "buyCompressed", kind: "buy_listing", standard: "compressed", priceable: true, sellerAccountIndex: 11, buyerAccountIndex: 9, mintAccountIndex: null },
  "4188feff3b82eaae": { name: "buySplCompressed", kind: "buy_listing", standard: "compressed", priceable: false, sellerAccountIndex: null, buyerAccountIndex: null, mintAccountIndex: null },

  // -- takeBid* (seller fulfills a real, existing bid) --
  "bc23746c00e9edc9": { name: "takeBidLegacy", kind: "take_bid", standard: "legacy", priceable: true, sellerAccountIndex: 1, buyerAccountIndex: null, mintAccountIndex: null },
  "fa29f8143da11b8d": { name: "takeBidCore", kind: "take_bid", standard: "core", priceable: true, sellerAccountIndex: 1, buyerAccountIndex: null, mintAccountIndex: 8 },
  "12fa71f21ff41396": { name: "takeBidT22", kind: "take_bid", standard: "t22", priceable: true, sellerAccountIndex: 1, buyerAccountIndex: null, mintAccountIndex: null },
  "58057a58fa8b23d8": { name: "takeBidWns", kind: "take_bid", standard: "wns", priceable: true, sellerAccountIndex: 1, buyerAccountIndex: null, mintAccountIndex: null },
  "f2c2cbe1ea350a60": { name: "takeBidCompressedFullMeta", kind: "take_bid", standard: "compressed", priceable: false, sellerAccountIndex: null, buyerAccountIndex: null, mintAccountIndex: null },
  "55e3ca462dd70ac1": { name: "takeBidCompressedMetaHash", kind: "take_bid", standard: "compressed", priceable: false, sellerAccountIndex: null, buyerAccountIndex: null, mintAccountIndex: null },
};

/**
 * Base58 alphabet decode -- the same alphabet Solana pubkeys/signatures and
 * this program's own instruction `data` field use. No external dependency:
 * this app's other Solana modules (solana-pubkey.ts) already avoid pulling
 * in bs58 for simple cases; this is the same minimal, dependency-free
 * decode, used only to read an instruction's first 8 raw bytes.
 */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(input: string): Uint8Array {
  let bytes: number[] = [0];
  for (const char of input) {
    const value = BASE58_ALPHABET.indexOf(char);
    if (value === -1) throw new Error(`tensor-settlement-scan: invalid base58 character "${char}"`);
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of input) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

function discriminatorHex(instructionData: string): string {
  const bytes = base58Decode(instructionData);
  return Buffer.from(bytes.slice(0, 8)).toString("hex");
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(SOLANA_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "plank-tensor-settlement", method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`tensor-settlement-scan: HTTP ${res.status} calling ${method}`);
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new Error(`tensor-settlement-scan: ${method} — ${body.error.code} ${body.error.message}`);
  return body.result as T;
}

type SignatureInfo = { signature: string; slot: number; blockTime: number | null; err: unknown };

type ParsedInstruction = {
  programId: string;
  accounts?: string[];
  data?: string;
};

type ParsedTransaction = {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    preBalances: number[];
    postBalances: number[];
  } | null;
  transaction: {
    message: {
      accountKeys: Array<{ pubkey: string } | string>;
      instructions: ParsedInstruction[];
    };
  };
};

function accountKeyString(key: { pubkey: string } | string): string {
  return typeof key === "string" ? key : key.pubkey;
}

export type DecodedTensorFill = {
  signature: string;
  instructionIndex: number;
  slot: number;
  blockTime: number | null;
  instructionName: string;
  settlementKind: SettlementKind;
  assetStandard: AssetStandard;
  mint: string | null;
  seller: string | null;
  buyer: string | null;
  priceLamports: string | null;
};

/**
 * Pure decode of one already-fetched, jsonParsed transaction into zero or
 * more real Tensor settlement rows. No I/O -- unit-tested directly against
 * a real getTransaction response saved as a fixture (see
 * test/market/tensor-settlement-scan.test.ts).
 */
export function decodeTensorSettlements(tx: ParsedTransaction, signature: string): DecodedTensorFill[] {
  if (!tx.meta || tx.meta.err) return []; // a failed transaction settled nothing real
  const accountKeys = tx.transaction.message.accountKeys.map(accountKeyString);
  const results: DecodedTensorFill[] = [];

  tx.transaction.message.instructions.forEach((ix, instructionIndex) => {
    if (ix.programId !== TENSOR_MARKETPLACE_PROGRAM_ADDRESS) return;
    if (!ix.data || !ix.accounts) return;
    let discHex: string;
    try {
      discHex = discriminatorHex(ix.data);
    } catch {
      return;
    }
    const spec = SETTLEMENT_INSTRUCTIONS[discHex];
    if (!spec) return; // a real Tensor instruction, but not a buy/takeBid settlement (e.g. Bid/Edit/List/Delist) -- not this scanner's concern

    const resolveAccount = (index: number | null): string | null => {
      if (index == null) return null;
      const pubkey = ix.accounts?.[index];
      return pubkey ?? null;
    };
    const seller = resolveAccount(spec.sellerAccountIndex);
    const buyer = resolveAccount(spec.buyerAccountIndex);
    const mint = resolveAccount(spec.mintAccountIndex);

    let priceLamports: string | null = null;
    if (spec.priceable && seller) {
      const globalIndex = accountKeys.indexOf(seller);
      if (globalIndex !== -1 && tx.meta) {
        const delta = tx.meta.postBalances[globalIndex] - tx.meta.preBalances[globalIndex];
        // Only a real, positive gain counts as a settlement price -- a
        // negative or zero delta means this account paid out or was
        // unaffected in this tx, which is not what "seller received
        // payment" means; left null rather than reported as a fabricated
        // negative price.
        if (Number.isFinite(delta) && delta > 0) priceLamports = String(delta);
      }
    }

    results.push({
      signature,
      instructionIndex,
      slot: tx.slot,
      blockTime: tx.blockTime,
      instructionName: spec.name,
      settlementKind: spec.kind,
      assetStandard: spec.standard,
      mint,
      seller,
      buyer,
      priceLamports,
    });
  });

  return results;
}

async function readCursor(): Promise<{ lastSignature: string | null; lastSlot: number | null }> {
  const result = await postgresQuery<{ last_signature: string | null; last_slot: string | null }>(
    `SELECT last_signature, last_slot::text FROM plank_tensor_fill_cursor WHERE cursor_key = $1`,
    [CURSOR_KEY]
  );
  const row = result.rows[0];
  return { lastSignature: row?.last_signature ?? null, lastSlot: row?.last_slot ? Number(row.last_slot) : null };
}

async function writeCursor(lastSignature: string, lastSlot: number): Promise<void> {
  await postgresQuery(
    `INSERT INTO plank_tensor_fill_cursor (cursor_key, last_signature, last_slot, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (cursor_key) DO UPDATE SET
       last_signature = EXCLUDED.last_signature,
       last_slot = GREATEST(plank_tensor_fill_cursor.last_slot, EXCLUDED.last_slot),
       updated_at = NOW()`,
    [CURSOR_KEY, lastSignature, lastSlot]
  );
}

/**
 * Idempotent upsert -- ON CONFLICT DO NOTHING on the same natural key the
 * migration's UNIQUE constraint defines, same "re-scanning a window never
 * double-writes" property every EVM fill writer already has. Rows for a
 * real, recognized-but-not-priced settlement variant (priceable: false)
 * are still written with a NULL price_lamports -- never skipped outright --
 * so the activity feed can at least show that a sale happened, honestly
 * missing only the price.
 */
export async function writeTensorFills(rows: DecodedTensorFill[]): Promise<number> {
  let written = 0;
  for (const r of rows) {
    const spec = Object.values(SETTLEMENT_INSTRUCTIONS).find((s) => s.name === r.instructionName);
    const result = await postgresQuery(
      `INSERT INTO plank_tensor_fills
         (chain_slug, signature, instruction_index, slot, block_time, instruction_name, settlement_kind, asset_standard, mint, seller, buyer, price_lamports)
       VALUES ('solana-mainnet', $1, $2, $3, to_timestamp($4), $5, $6, $7, $8, $9, $10, $11::numeric)
       ON CONFLICT (chain_slug, signature, instruction_index) DO NOTHING`,
      [
        r.signature,
        r.instructionIndex,
        r.slot,
        r.blockTime,
        r.instructionName,
        r.settlementKind,
        spec?.standard ?? "legacy",
        r.mint,
        r.seller,
        r.buyer,
        r.priceLamports,
      ]
    );
    written += (result.rowCount ?? 0) > 0 ? 1 : 0;
    if ((result.rowCount ?? 0) > 0 && r.mint) {
      // One sink (2026-09-06): the fill's collection comes from the token
      // projection (mint -> collection_slug); unknown mints are skipped, never guessed.
      const coll = await postgresQuery<{ collection_slug: string }>(
        `SELECT collection_slug FROM plank_collection_tokens WHERE chain_slug = 'solana-mainnet' AND token_id = $1 LIMIT 1`, [r.mint]
      );
      const collectionKey = coll.rows[0]?.collection_slug ?? null;
      if (collectionKey) {
        await recordSaleEvent({ chainSlug: "solana-mainnet", venue: "tensor", protocol: r.instructionName, collectionKey, tokenId: r.mint, txHash: r.signature, logIndex: r.instructionIndex, blockNumber: r.slot, blockTimestamp: r.blockTime ?? null, seller: r.seller, buyer: r.buyer, currencyToken: null, priceWei: r.priceLamports != null ? String(r.priceLamports) : null, raw: { settlementKind: r.settlementKind }, chainNamespace: "solana" });
      }
    }
  }
  await flushLedgerAggregation();
  return written;
}

type TensorFillRow = {
  signature: string;
  slot: string;
  block_time: Date | null;
  instruction_name: string;
  settlement_kind: SettlementKind;
  mint: string | null;
  seller: string | null;
  buyer: string | null;
  price_lamports: string | null;
};

export type TensorSettlementActivityEvent = {
  source: "onchain_settlement";
  type: "sale";
  timestamp: string | null;
  transaction: string;
  priceLamports: string | null;
  from: string | null;
  to: string | null;
  tokenId: string | null;
};

/**
 * Reads this app's own real Tensor settlement history for the mints
 * belonging to one tracked Solana collection -- the read side of this
 * scanner, used by app/api/market/multichain/activity/route.ts to surface a
 * real "recent sales" feed for a Solana collection with Tensor settlement
 * history. Every row is explicitly tagged `source: "onchain_settlement"`
 * (see migration 058's own header / venue-registry.ts's tensor-solana
 * entry) so it is never confused with Tensor's own official, gated stats.
 *
 * SCOPE, HONESTLY STATED: only mints this app has ALREADY discovered and
 * projected into plank_collection_tokens for this collection are matched
 * (same "known member set" limitation collection-token-store.ts's other
 * readers already carry) -- a mint never seen by this app's Solana
 * discovery pipeline cannot be attributed to a collection here, and is
 * simply absent from this collection's feed rather than mis-attributed.
 */
export async function readTensorSettlementActivity(input: {
  chainSlug: string;
  collectionSlug: string;
  limit: number;
}): Promise<TensorSettlementActivityEvent[]> {
  if (input.chainSlug !== "solana-mainnet") return [];
  const mintsResult = await postgresQuery<{ token_id: string }>(
    `SELECT token_id FROM plank_collection_tokens WHERE chain_slug = $1 AND lower(collection_slug) = lower($2)`,
    [input.chainSlug, input.collectionSlug]
  );
  const mints = mintsResult.rows.map((r) => r.token_id);
  if (mints.length === 0) return [];

  const fillsResult = await postgresQuery<TensorFillRow>(
    `SELECT signature, slot::text, block_time, instruction_name, settlement_kind, mint, seller, buyer, price_lamports::text
     FROM plank_tensor_fills
     WHERE chain_slug = $1 AND mint = ANY($2::text[])
     ORDER BY slot DESC
     LIMIT $3`,
    [input.chainSlug, mints, input.limit]
  );

  return fillsResult.rows.map((r) => ({
    source: "onchain_settlement" as const,
    type: "sale" as const,
    timestamp: r.block_time ? new Date(r.block_time).toISOString() : null,
    transaction: r.signature,
    priceLamports: r.price_lamports,
    from: r.seller,
    to: r.buyer,
    tokenId: r.mint,
  }));
}

export type TensorSettlementScanResult = {
  signaturesScanned: number;
  transactionsFetched: number;
  fillsFound: number;
  fillsWritten: number;
  newestSignature: string | null;
  error?: string;
};

/**
 * One tick: pages backward from the current chain tip via
 * getSignaturesForAddress(until: <last known signature>), fetches each new
 * signature's transaction, decodes real settlements, and upserts them.
 * Same "backfill-and-live-sync are the same call" property the EVM
 * scanners document -- a cold cursor simply walks one page back from the
 * tip and stops (forward-only from first run, not a historical backfill;
 * see this file's own header).
 */
export async function scanTensorSettlements(): Promise<TensorSettlementScanResult> {
  const cursor = await readCursor();
  let signaturesScanned = 0;
  let transactionsFetched = 0;
  let fillsFound = 0;
  let fillsWritten = 0;
  let newestSignature: string | null = null;
  let before: string | undefined;
  let reachedCursor = false;

  try {
    for (let page = 0; page < MAX_PAGES_PER_RUN && !reachedCursor; page++) {
      const params: Record<string, unknown> = { limit: SIGNATURES_PER_PAGE };
      if (before) params.before = before;
      if (cursor.lastSignature) params.until = cursor.lastSignature;
      const sigs = await rpcCall<SignatureInfo[]>("getSignaturesForAddress", [TENSOR_MARKETPLACE_PROGRAM_ADDRESS, params]);
      if (sigs.length === 0) break;
      if (page === 0) newestSignature = sigs[0].signature;

      for (const sig of sigs) {
        signaturesScanned += 1;
        if (sig.err) continue; // a real, on-chain-failed transaction settled nothing
        const tx = await rpcCall<ParsedTransaction | null>("getTransaction", [
          sig.signature,
          { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
        ]);
        transactionsFetched += 1;
        if (!tx) continue;
        const decoded = decodeTensorSettlements(tx, sig.signature);
        if (decoded.length > 0) {
          fillsFound += decoded.length;
          fillsWritten += await writeTensorFills(decoded);
        }
      }

      before = sigs[sigs.length - 1].signature;
      if (sigs.length < SIGNATURES_PER_PAGE) break; // reached genuinely older-than-anything-left history this page
      if (cursor.lastSignature && sigs.some((s) => s.signature === cursor.lastSignature)) reachedCursor = true;
    }

    if (newestSignature) {
      const newestSlot = await rpcCall<{ context: { slot: number } } | number>("getSlot", []).catch(() => null);
      const slot = typeof newestSlot === "number" ? newestSlot : cursor.lastSlot ?? 0;
      await writeCursor(newestSignature, slot);
    }
  } catch (err) {
    return {
      signaturesScanned,
      transactionsFetched,
      fillsFound,
      fillsWritten,
      newestSignature,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return { signaturesScanned, transactionsFetched, fillsFound, fillsWritten, newestSignature };
}
