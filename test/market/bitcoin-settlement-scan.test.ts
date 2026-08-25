import assert from "node:assert/strict";
import test from "node:test";
import { inferSettlement } from "../../lib/market/multichain/discovery/bitcoin-settlement-scan";

/**
 * Fixture built from a REAL mempool.space /api/tx/:txid response, fetched
 * live 2026-08-24 (txid
 * afa8e1113cd46c230dc6288ec83e4b4439a9079a68010192efe9d5ce13707e1a, a real
 * confirmed mainnet transaction from block 963939) -- see
 * bitcoin-settlement-scan.ts's own header for the full response and the
 * two verified mempool.space endpoints this design depends on.
 *
 * HONEST LIMITATION (also stated in bitcoin-settlement-scan.ts's header):
 * this real transaction is NOT independently confirmed to be an Ordinals
 * marketplace sale -- no specific real historical marketplace-sale txid
 * could be sourced through any free/keyless channel tried live this
 * session (UniSat's sale-history endpoints need a key, Magic Eden's public
 * activity API returned a Cloudflare bot challenge, and no web search
 * surfaced one with a documented price). What IS real and verified is the
 * exact vin/vout shape mempool.space returns for a real confirmed
 * transaction -- that shape is what these tests exercise the heuristic
 * against. The three cases below are constructed by relabeling this real
 * transaction's own addresses/values into the seller/buyer roles the
 * documented Ordinals PSBT settlement pattern describes (seller-signs-one-
 * input-one-output; see bitcoin-settlement-scan.ts header), not by
 * asserting this specific real transaction was itself such a sale.
 */
const REAL_TX_SHAPE = {
  txid: "afa8e1113cd46c230dc6288ec83e4b4439a9079a68010192efe9d5ce13707e1a",
  vin: [
    {
      txid: "05e9105aebabacc2cf79061a7edf83d802c9c8e58a2e38877179c85c918441c6",
      vout: 0,
      prevout: { scriptpubkey_address: "bc1p9ul6ua90n64thexnuxamgcmrvtnn024kuacrkqmwkwvmu285yjqsr58zwd", value: 600 },
    },
    {
      txid: "3f749461fe2c2b1f324c0c8a7bd029aed5f5172433b353aa142fa8b7229fa2da",
      vout: 0,
      prevout: { scriptpubkey_address: "bc1p0n7fctd3qcaj566xmufgg8g520ke7uumqghdzcekyxtxtpxch5dq9hnyqk", value: 546 },
    },
  ],
  vout: [
    { scriptpubkey_address: "bc1qc0zn3d0vvc4gffjcp2q222c2ldtzzuuu932jel", value: 32859074 },
    { scriptpubkey_address: "bc1p0n7fctd3qcaj566xmufgg8g520ke7uumqghdzcekyxtxtpxch5dq9hnyqk", value: 3332541 },
  ],
  status: { confirmed: true, block_height: 963939, block_time: 1787628026 },
} as const;

test("inferSettlement labels a clean single-seller-input net payment as high confidence", () => {
  // Relabel the real tx's second address as "the seller": it appears as
  // exactly one input (546 sats, the inscription-postage-sized UTXO being
  // spent) and receives a much larger output (3,332,541 sats) in the same
  // real transaction -- the documented PSBT sale shape.
  const seller = "bc1p0n7fctd3qcaj566xmufgg8g520ke7uumqghdzcekyxtxtpxch5dq9hnyqk";
  const result = inferSettlement(REAL_TX_SHAPE as any, seller);
  assert.equal(result.confidence, "high_confidence_marketplace_pattern");
  assert.equal(result.priceSats, 3_332_541 - 546);
});

test("inferSettlement labels a below-dust-floor net payment as uncertain, never fabricating a price", () => {
  // Relabel the first address as "the seller": its one input (600 sats)
  // receives no matching output at all in this real transaction, so
  // net-to-seller is negative -- must never be reported as a sale.
  const seller = "bc1p9ul6ua90n64thexnuxamgcmrvtnn024kuacrkqmwkwvmu285yjqsr58zwd";
  const result = inferSettlement(REAL_TX_SHAPE as any, seller);
  assert.equal(result.confidence, "spend_observed_uncertain");
  assert.equal(result.priceSats, null);
});

test("inferSettlement demotes a multi-input seller match to uncertain even with a large net payment", () => {
  // A seller address appearing as MORE than one input in the same
  // transaction is a busier shape (e.g. a wallet consolidating several of
  // its own UTXOs) than the clean single-input PSBT-combine pattern this
  // heuristic trusts -- must not be reported as high confidence even if
  // the net balance happens to be positive and large.
  const busyTx = {
    ...REAL_TX_SHAPE,
    vin: [
      REAL_TX_SHAPE.vin[0],
      {
        txid: "deadbeef00000000000000000000000000000000000000000000000000000",
        vout: 1,
        prevout: { scriptpubkey_address: REAL_TX_SHAPE.vin[0].prevout.scriptpubkey_address, value: 1_000 },
      },
    ],
  };
  const seller = REAL_TX_SHAPE.vin[0].prevout.scriptpubkey_address;
  const result = inferSettlement(busyTx as any, seller);
  assert.equal(result.confidence, "spend_observed_uncertain");
});

test("inferSettlement returns null price (not zero) when there is truly no seller-address output at all", () => {
  const unrelatedAddress = "bc1qexamplenotinthistransactionatall000000000";
  const result = inferSettlement(REAL_TX_SHAPE as any, unrelatedAddress);
  assert.equal(result.priceSats, null);
  assert.equal(result.confidence, "spend_observed_uncertain");
});
