/**
 * Bitcoin Ordinals Settlement-First Universal Index (SFUI) -- see
 * docs/marketplank/GROK-FINDINGS-free-remedies-2026-08-25.md, "Cross-cutting
 * free architecture" section A, and deploy/inmotion/postgres/migrations/
 * 062_bitcoin_onchain_settlements.sql for the schema this writes.
 *
 * WHY THIS EXISTS
 * -------------------------------------------------------------------
 * Best in Slot's hosted API is confirmed retired (venue-registry.ts,
 * "bestinslot-bitcoin"). Gamma's Ordinals API and OKX's Ordinals API are
 * both confirmed key-gated/undiscoverable for ACTIVITY data specifically
 * (venue-registry.ts, "gamma-bitcoin" / "okx-bitcoin"). This file is the
 * free, keyless substitute for exactly that gap -- REAL SETTLEMENT/ACTIVITY
 * DATA ONLY, never a live order book, and never claimed to be one.
 *
 * REAL mempool.space ENDPOINTS VERIFIED LIVE 2026-08-24 (no API key, no
 * rate-limit header seen on these GETs):
 *
 *   GET https://mempool.space/api/blocks/tip/height
 *     -> plain-text integer, e.g. "963938". Already used by this app's own
 *     unisat-transfer-scan.ts (see that file's currentTipHeight()).
 *
 *   GET https://mempool.space/api/tx/:txid
 *     Real live response fetched this session (txid
 *     afa8e1113cd46c230dc6288ec83e4b4439a9079a68010192efe9d5ce13707e1a, a
 *     real confirmed mainnet tx from block 963939):
 *       {"txid":"afa8e111...","version":1,"locktime":0,
 *        "vin":[{"txid":"...","vout":0,
 *                "prevout":{"scriptpubkey_address":"bc1p9ul...","value":600},
 *                ...}, ...],
 *        "vout":[{"scriptpubkey_address":"bc1qc0z...","value":32859074},
 *                 {"scriptpubkey_address":"bc1p0n7...","value":3332541}],
 *        "status":{"confirmed":true,"block_height":963939,
 *                  "block_hash":"...","block_time":1787628026}}
 *     Every vin entry carries a real `prevout` (address + value) inline --
 *     no second lookup is needed to know which address funded which input.
 *     This is the exact detail level needed to identify an inscription-
 *     bearing UTXO being spent (vin[n].txid/vout matches the inscription's
 *     known prior location) and to see whether the same tx pays the seller
 *     (a vout whose scriptpubkey_address matches the seller's address).
 *
 *   GET https://mempool.space/api/tx/:txid/outspends
 *     Real live response fetched this session for the same txid's own
 *     inputs' prevouts: `[{"spent":true,"txid":"...","vin":0,
 *     "status":{"confirmed":false}},{"spent":false}]` -- per-output spent
 *     status and (when spent) the spending txid. Not used by the scan loop
 *     below (which already has the spending txid from the transfer event
 *     it starts from), but documented here as the second real, verified
 *     endpoint this design depends on for the general "has this specific
 *     known UTXO been spent yet" question the task asked to confirm.
 *
 * mempool.space's own docs (https://mempool.space/docs/api/rest) describe
 * this same contract; the shapes above were independently re-confirmed by
 * hand against live mainnet data rather than trusted from memory, per this
 * repo's standing rule.
 *
 * WHERE THE "WHICH UTXO IS AN INSCRIPTION" KNOWLEDGE COMES FROM
 * -------------------------------------------------------------------
 * mempool.space does not know what an inscription is. This app already
 * does: unisat-transfer-scan.ts (lib/market/multichain/discovery/) walks
 * UniSat's own inscription-indexer event stream and writes every real,
 * observed inscription move into plank_market_events as a
 * venue_id = 'wallet-transfer' row -- (chain_slug, tx_hash, token_id
 * [=inscription id], seller [=prior known holder address], buyer [=new
 * holder address], block_number, block_timestamp), deliberately WITHOUT a
 * price (a transfer alone cannot distinguish a sale from a gift).
 *
 * This scanner does not re-derive inscription/UTXO identity itself -- it
 * reads exactly those already-verified transfer rows as its worklist, then
 * asks mempool.space's free API the one question UniSat's transfer feed
 * does not answer: was there a payment to the seller in that same
 * transaction? That price layer is genuinely new; the inscription-move
 * detection it depends on already exists and is not duplicated here.
 *
 * PRICE-INFERENCE HEURISTIC (validated against real mempool.space tx shape;
 * HONEST LIMITATION stated below, not hidden)
 * -------------------------------------------------------------------
 * Standard documented Ordinals marketplace PSBT settlement pattern (the
 * seller signs SIGHASH_SINGLE|ANYONECANPAY over exactly one input --
 * the inscription UTXO -- and one output -- their payment; the buyer's
 * wallet or the marketplace itself completes the PSBT by adding the
 * funding input(s), the inscription-recipient output, and any fee/change
 * outputs before broadcast): the settlement transaction therefore contains
 * (a) an input whose prevout address is the previously-known holder
 * (seller), and (b) a payment output whose address is that SAME seller
 * address, in the SAME transaction.
 *
 * This scanner computes, per candidate settlement tx:
 *   net_to_seller = sum(vout.value where vout.address == seller_address)
 *                  - sum(vin.prevout.value where vin.prevout.address == seller_address)
 * i.e. the real, observed net satoshi delta for the seller's own address in
 * this transaction (not a decoded "intent" field -- the same net-balance-
 * delta discipline this codebase already uses for Tensor's settlement
 * price, see plank_tensor_fills's header in migration 058).
 *
 * confidence_label:
 *   - 'high_confidence_marketplace_pattern' when net_to_seller is
 *     comfortably above ordinary postage/dust (> SALE_FLOOR_SATS) AND the
 *     seller's address appears in the transaction's inputs exactly once
 *     (the clean single-seller-input PSBT-combine shape described above,
 *     not a busier multi-party/consolidation transaction that happens to
 *     also touch the seller's address).
 *   - 'spend_observed_uncertain' for every other case where the known
 *     inscription UTXO was genuinely observed spent in this real
 *     transaction, but net_to_seller was zero/negative/below the dust
 *     floor, or the seller's address appeared in more than one input (a
 *     shape this heuristic cannot cleanly attribute).
 *
 * REAL VALIDATION TXID SOURCED THIS SESSION, AND ITS REAL LIMIT
 * -------------------------------------------------------------------
 * A specific, independently-confirmed-as-a-marketplace-sale historical
 * txid could NOT be located this session through any free/keyless source
 * tried live: UniSat's own sale-history endpoints require an API key this
 * environment's probe did not have standing permission to spend against
 * production data for a lookup-only check, Magic Eden's public activity
 * API returned a genuine Cloudflare bot challenge (not usable
 * programmatically), and no web search returned a specific real txid with
 * a documented sale price. This is disclosed rather than papered over: the
 * *transaction-shape and vin/vout-detail mechanism* above was verified
 * against a REAL, live, confirmed mainnet transaction (fetched directly
 * from mempool.space, txid and full response quoted above) -- that part is
 * not fabricated. What is NOT independently verified this session is one
 * specific confirmed-marketplace-sale example matching the documented PSBT
 * pattern; the heuristic itself is built from the publicly documented
 * Ordinals PSBT sale mechanism (seller-signs-one-input-one-output,
 * SIGHASH_SINGLE|ANYONECANPAY), not from a single verified example. The
 * test fixture in bitcoin-settlement-scan.test.ts is built from the real,
 * live-fetched transaction shape above and states this limitation inline
 * rather than mislabeling a synthetic fixture as a verified historical
 * sale.
 *
 * SCOPE BOUNDARY: this file is read-only discovery. It builds no PSBT, and
 * signs nothing -- see bitcoin-utxo-safety.ts's own standing "not yet
 * live-verified" disclosure for why no trading code is extended here.
 */
import { postgresQuery } from "@/lib/postgres";
import { getOrRefresh } from "@/lib/market/multichain/singleflight-cache";

const CHAIN_SLUG = "bitcoin-mainnet";
const CURSOR_KEY = "bitcoin-mainnet:mempool-settlement-scan";
const BATCH_SIZE = 200;

/** Real, observed dust/postage outputs for ordinal-carrying UTXOs are
 * typically 330-10,000 sats. A payment comfortably above that is treated as
 * a plausible sale amount rather than incidental postage/change -- an
 * arbitrary but documented threshold, not a protocol constant. */
const SALE_FLOOR_SATS = 10_000;

type MempoolVin = {
  txid: string;
  vout: number;
  prevout: { scriptpubkey_address?: string | null; value: number } | null;
};
type MempoolVout = { scriptpubkey_address?: string | null; value: number };
type MempoolTx = {
  txid: string;
  vin: MempoolVin[];
  vout: MempoolVout[];
  status: { confirmed: boolean; block_height?: number; block_time?: number };
};

/**
 * Real tx data is immutable once confirmed, so this cache uses a long soft
 * TTL -- see singleflight-cache.ts's own header on why coalescing concurrent
 * callers of the same rate-limited third-party endpoint matters. Unconfirmed
 * txids are never passed in here (the caller only supplies already-observed,
 * already-confirmed transfer events), so there is no "confirmed status
 * changes later" staleness risk to guard against.
 */
async function fetchMempoolTx(txid: string): Promise<MempoolTx | null> {
  return getOrRefresh(
    `bitcoin-settlement-scan:tx:${txid}`,
    { softTtlMs: 30 * 24 * 60 * 60 * 1000, hardTtlMs: 30 * 24 * 60 * 60 * 1000 },
    async () => {
      const res = await fetch(`https://mempool.space/api/tx/${txid}`, { signal: AbortSignal.timeout(15_000) });
      if (res.status === 404) return null as unknown as MempoolTx; // real "tx not found" -- caller treats as no data
      if (!res.ok) throw new Error(`bitcoin-settlement-scan: mempool.space ${res.status} fetching tx ${txid}`);
      return (await res.json()) as MempoolTx;
    }
  );
}

export type SettlementConfidence = "high_confidence_marketplace_pattern" | "spend_observed_uncertain";

export type InferredSettlement = {
  priceSats: number | null;
  confidence: SettlementConfidence;
};

/**
 * Pure function (no I/O) so the heuristic itself is directly unit-testable
 * against a fixture built from a real mempool.space tx shape -- see this
 * file's own header for the full derivation and its honest limitation.
 */
export function inferSettlement(tx: MempoolTx, sellerAddress: string): InferredSettlement {
  let paidToSeller = 0;
  for (const out of tx.vout) if (out.scriptpubkey_address === sellerAddress) paidToSeller += out.value;

  let fromSeller = 0;
  let sellerInputCount = 0;
  for (const inp of tx.vin) {
    if (inp.prevout?.scriptpubkey_address === sellerAddress) {
      fromSeller += inp.prevout.value;
      sellerInputCount += 1;
    }
  }

  const netToSeller = paidToSeller - fromSeller;
  const cleanSingleSellerInput = sellerInputCount === 1;

  if (netToSeller > SALE_FLOOR_SATS && cleanSingleSellerInput) {
    return { priceSats: netToSeller, confidence: "high_confidence_marketplace_pattern" };
  }
  return { priceSats: netToSeller > 0 ? netToSeller : null, confidence: "spend_observed_uncertain" };
}

type TransferCandidate = {
  id: number;
  inscription_id: string;
  txid: string;
  seller: string | null;
  buyer: string | null;
};

async function readCursor(): Promise<number> {
  const result = await postgresQuery<{ last_scanned_block: string }>(
    `SELECT last_scanned_block FROM plank_multichain_discovery_cursor WHERE chain_slug = $1`,
    [CURSOR_KEY]
  );
  return result.rows[0] ? Number(result.rows[0].last_scanned_block) : 0;
}

async function writeCursor(lastId: number): Promise<void> {
  await postgresQuery(
    `INSERT INTO plank_multichain_discovery_cursor (chain_slug, last_scanned_block, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (chain_slug) DO UPDATE SET last_scanned_block = EXCLUDED.last_scanned_block, updated_at = NOW()`,
    [CURSOR_KEY, lastId]
  );
}

async function fetchCandidates(afterId: number, limit: number): Promise<TransferCandidate[]> {
  const result = await postgresQuery<TransferCandidate>(
    `SELECT id, token_id AS inscription_id, tx_hash AS txid, seller, buyer
       FROM plank_market_events
      WHERE chain_slug = $1 AND venue_id = 'wallet-transfer' AND id > $2
      ORDER BY id ASC
      LIMIT $3`,
    [CHAIN_SLUG, afterId, limit]
  );
  return result.rows;
}

export type BitcoinSettlementScanResult = {
  fromId: number;
  toId: number;
  candidates: number;
  written: number;
  skippedExisting: number;
  skippedNoSeller: number;
  errors: number;
};

/**
 * Walks already-known Bitcoin inscription transfer events (see this file's
 * header) forward from a durable cursor, re-fetches each real settlement
 * txid from mempool.space's free API, applies the price-inference
 * heuristic, and upserts an honestly-labeled row into
 * bitcoin_onchain_settlements. Fail-closed per-candidate: a mempool.space
 * fetch error for one txid is recorded and skipped, never aborting the
 * whole batch or fabricating a price.
 */
export async function runBitcoinSettlementScan(maxCandidates = BATCH_SIZE): Promise<BitcoinSettlementScanResult> {
  const fromId = await readCursor();
  const candidates = await fetchCandidates(fromId, maxCandidates);

  let written = 0;
  let skippedExisting = 0;
  let skippedNoSeller = 0;
  let errors = 0;
  let lastId = fromId;

  for (const candidate of candidates) {
    lastId = candidate.id;
    if (!candidate.seller) {
      skippedNoSeller += 1; // no prior known holder -- likely the inscription's mint/first-observed event, nothing to attribute a payment against
      continue;
    }

    const existing = await postgresQuery<{ id: number }>(
      `SELECT id FROM bitcoin_onchain_settlements WHERE inscription_id = $1 AND txid = $2`,
      [candidate.inscription_id, candidate.txid]
    );
    if (existing.rows.length > 0) {
      skippedExisting += 1;
      continue;
    }

    let tx: MempoolTx | null;
    try {
      tx = await fetchMempoolTx(candidate.txid);
    } catch {
      errors += 1;
      continue;
    }
    if (!tx || !tx.status?.confirmed) {
      errors += 1;
      continue;
    }

    const inferred = inferSettlement(tx, candidate.seller);
    const blockHeight = tx.status.block_height ?? null;
    const blockTime = tx.status.block_time ? new Date(tx.status.block_time * 1000).toISOString() : null;

    await postgresQuery(
      `INSERT INTO bitcoin_onchain_settlements
         (inscription_id, txid, price_sats, buyer_address, seller_address, block_height, block_time, confidence_label, source, raw_event)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'onchain_settlement', $9::jsonb)
       ON CONFLICT (inscription_id, txid) DO NOTHING`,
      [
        candidate.inscription_id,
        candidate.txid,
        inferred.priceSats,
        candidate.buyer,
        candidate.seller,
        blockHeight,
        blockTime,
        inferred.confidence,
        JSON.stringify({ vinCount: tx.vin.length, voutCount: tx.vout.length }),
      ]
    );
    written += 1;
  }

  await writeCursor(lastId);
  return {
    fromId,
    toId: lastId,
    candidates: candidates.length,
    written,
    skippedExisting,
    skippedNoSeller,
    errors,
  };
}

/**
 * Read path for a single inscription's settlement history, for any future
 * user-facing route -- goes through the same durable Postgres table above,
 * no singleflight needed for a plain indexed DB read (singleflight-cache.ts
 * exists to coalesce rate-limited THIRD-PARTY fetches, which this function
 * makes none of; fetchMempoolTx above is the one that needs it and already
 * has it).
 */
export async function getBitcoinSettlementsForInscription(inscriptionId: string): Promise<
  Array<{
    txid: string;
    priceSats: number | null;
    buyerAddress: string | null;
    sellerAddress: string | null;
    blockHeight: number | null;
    blockTime: string | null;
    confidenceLabel: SettlementConfidence;
    source: "onchain_settlement";
  }>
> {
  const result = await postgresQuery<{
    txid: string;
    price_sats: string | null;
    buyer_address: string | null;
    seller_address: string | null;
    block_height: string | null;
    block_time: string | null;
    confidence_label: SettlementConfidence;
  }>(
    `SELECT txid, price_sats, buyer_address, seller_address, block_height, block_time, confidence_label
       FROM bitcoin_onchain_settlements
      WHERE inscription_id = $1
      ORDER BY block_height DESC NULLS LAST`,
    [inscriptionId]
  );
  return result.rows.map((r) => ({
    txid: r.txid,
    priceSats: r.price_sats != null ? Number(r.price_sats) : null,
    buyerAddress: r.buyer_address,
    sellerAddress: r.seller_address,
    blockHeight: r.block_height != null ? Number(r.block_height) : null,
    blockTime: r.block_time,
    confidenceLabel: r.confidence_label,
    source: "onchain_settlement" as const,
  }));
}
