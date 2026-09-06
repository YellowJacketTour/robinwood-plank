import assert from "node:assert/strict";
import test from "node:test";
import * as bitcoin from "bitcoinjs-lib";
import { assertBuyPsbtSafe } from "../../lib/market/multichain/trading/psbt-safety";

const net = bitcoin.networks.bitcoin;
// Deterministic p2wpkh scripts from fixed 20-byte hashes (no key material needed for structure tests).
function p2wpkh(hashByte: number) {
  return bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, hashByte), network: net });
}
const buyer = p2wpkh(0x11);
const seller = p2wpkh(0x22);
const platform = p2wpkh(0x33);
const txid = "aa".repeat(32);

function build(opts: { sellerOut: number; platformOut: number; buyerOut: number; buyerIn: number; sellerSighash?: number; buyerSighash?: number }) {
  const psbt = new bitcoin.Psbt({ network: net });
  // input 0: seller's inscription utxo (seller-signed type)
  psbt.addInput({ hash: txid, index: 0, witnessUtxo: { script: seller.output!, value: 10_000n }, sighashType: opts.sellerSighash ?? 0x83 });
  // input 1: buyer payment utxo
  psbt.addInput({ hash: txid, index: 1, witnessUtxo: { script: buyer.output!, value: BigInt(opts.buyerIn) }, ...(opts.buyerSighash != null ? { sighashType: opts.buyerSighash } : {}) });
  psbt.addOutput({ script: buyer.output!, value: BigInt(opts.buyerOut) }); // inscription lands with buyer
  psbt.addOutput({ script: seller.output!, value: BigInt(opts.sellerOut) });
  if (opts.platformOut > 0) psbt.addOutput({ script: platform.output!, value: BigInt(opts.platformOut) });
  return psbt.toBase64();
}

const base = { buyerAddress: buyer.address!, signIndexes: [1], priceSats: 100_000n, network: net };

test("a well-formed marketplace bid PSBT passes: inscription to buyer, seller paid the price, fee within ceiling", () => {
  const psbt = build({ sellerOut: 100_000, platformOut: 2_000, buyerOut: 10_000, buyerIn: 120_000 });
  const r = assertBuyPsbtSafe({ ...base, psbtBase64: psbt });
  assert.equal(r.buyerOutputsSats, 10_000n);
  assert.equal(r.otherOutputsSats, 102_000n);
  assert.equal(r.feeSats, 130_000n - 112_000n);
  assert.deepEqual(r.inputsToSign, [1]);
});

test("refuses when the seller is paid more than the confirmed price plus allowed fee", () => {
  const psbt = build({ sellerOut: 150_000, platformOut: 0, buyerOut: 10_000, buyerIn: 200_000 });
  assert.throws(() => assertBuyPsbtSafe({ ...base, psbtBase64: psbt }), /above the confirmed/);
});

test("refuses when no output pays the buyer", () => {
  const psbt = new bitcoin.Psbt({ network: net });
  psbt.addInput({ hash: txid, index: 1, witnessUtxo: { script: buyer.output!, value: 120_000n } });
  psbt.addOutput({ script: seller.output!, value: 100_000n });
  assert.throws(() => assertBuyPsbtSafe({ ...base, psbtBase64: psbt.toBase64(), signIndexes: [0] }), /no output pays the buyer/);
});

test("refuses to sign the seller's SINGLE|ANYONECANPAY input or an index that was not enumerated", () => {
  const psbt = build({ sellerOut: 100_000, platformOut: 0, buyerOut: 10_000, buyerIn: 120_000 });
  assert.throws(() => assertBuyPsbtSafe({ ...base, psbtBase64: psbt, signIndexes: [0, 1] }), /sighash 0x83/);
  assert.throws(() => assertBuyPsbtSafe({ ...base, psbtBase64: psbt, signIndexes: [5] }), /does not exist/);
});

test("refuses an absurd miner fee", () => {
  const psbt = build({ sellerOut: 100_000, platformOut: 0, buyerOut: 10_000, buyerIn: 1_000_000 });
  assert.throws(() => assertBuyPsbtSafe({ ...base, psbtBase64: psbt }), /miner fee/);
});
