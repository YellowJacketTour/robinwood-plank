import assert from "node:assert/strict";
import test from "node:test";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import { ECPairFactory } from "ecpair";
import { buildCancelProofPsbt, verifyCancelProofPsbt, type Utxo } from "../../lib/market/multichain/trading/native-bitcoin-listing";

/**
 * Offline, fully-synthetic proof of buildCancelProofPsbt/verifyCancelProofPsbt
 * -- the H2 fix from this session's Opus security audit. Same real-keys,
 * real-signatures, no-real-funds pattern as native-bitcoin-listing.test.ts.
 */

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);
const network = bitcoin.networks.testnet;

function toXOnly(pubkey: Buffer): Buffer {
  return pubkey.length === 32 ? pubkey : pubkey.subarray(1, 33);
}

function tapTweakHash(pubKey: Buffer, h?: Buffer): Buffer {
  return Buffer.from(bitcoin.crypto.taggedHash("TapTweak", h ? Buffer.concat([pubKey, h]) : pubKey));
}

function tweakSigner(signer: ReturnType<typeof ECPair.makeRandom>) {
  let privateKey: Uint8Array = signer.privateKey!;
  if (signer.publicKey[0] === 3) {
    privateKey = ecc.privateNegate(privateKey);
  }
  const tweakedPrivateKey = ecc.privateAdd(privateKey, tapTweakHash(toXOnly(Buffer.from(signer.publicKey))));
  if (!tweakedPrivateKey) throw new Error("Invalid tweaked private key");
  return ECPair.fromPrivateKey(Buffer.from(tweakedPrivateKey), { network });
}

function p2trAddressAndScript(keyPair: ReturnType<typeof ECPair.makeRandom>) {
  const xOnly = toXOnly(Buffer.from(keyPair.publicKey));
  const p2tr = bitcoin.payments.p2tr({ internalPubkey: xOnly, network });
  return { address: p2tr.address!, script: Buffer.from(p2tr.output!) };
}

test("native-bitcoin-listing cancel: a real owner signature verifies successfully", () => {
  const sellerKey = ECPair.makeRandom({ network });
  const seller = p2trAddressAndScript(sellerKey);
  const listingUtxo: Utxo = { txid: "a".repeat(64), vout: 0, valueSats: 10_000, scriptPubKeyHex: seller.script.toString("hex") };

  const { psbtBase64: unsigned, inputIndexToSign } = buildCancelProofPsbt({
    sellerAddress: seller.address,
    sellerInternalPubkeyHex: Buffer.from(sellerKey.publicKey).toString("hex"),
    listingUtxo,
  });
  assert.equal(inputIndexToSign, 0);

  const psbt = bitcoin.Psbt.fromBase64(unsigned, { network });
  const tweaked = tweakSigner(sellerKey);
  psbt.signTaprootInput(0, tweaked, undefined, [bitcoin.Transaction.SIGHASH_ALL]);
  const signed = psbt.toBase64();

  const verified = verifyCancelProofPsbt(signed, { txid: listingUtxo.txid, vout: listingUtxo.vout }, seller.address);
  assert.equal(verified, true);
});

test("native-bitcoin-listing cancel: a signature from a DIFFERENT key (not the real owner) is rejected", () => {
  const sellerKey = ECPair.makeRandom({ network });
  const seller = p2trAddressAndScript(sellerKey);
  const listingUtxo: Utxo = { txid: "a".repeat(64), vout: 0, valueSats: 10_000, scriptPubKeyHex: seller.script.toString("hex") };

  // Attacker builds a cancel-proof PSBT claiming to be `seller`, but signs
  // with their OWN key instead -- the whole point of this check.
  const { psbtBase64: unsigned } = buildCancelProofPsbt({
    sellerAddress: seller.address,
    sellerInternalPubkeyHex: Buffer.from(sellerKey.publicKey).toString("hex"),
    listingUtxo,
  });
  const attackerKey = ECPair.makeRandom({ network });
  const psbt = bitcoin.Psbt.fromBase64(unsigned, { network });
  const tweakedAttacker = tweakSigner(attackerKey);
  assert.throws(() => psbt.signTaprootInput(0, tweakedAttacker, undefined, [bitcoin.Transaction.SIGHASH_ALL]));
});

test("native-bitcoin-listing cancel: a proof for a DIFFERENT UTXO than the listing's real one is rejected", () => {
  const sellerKey = ECPair.makeRandom({ network });
  const seller = p2trAddressAndScript(sellerKey);
  const realListingUtxo: Utxo = { txid: "a".repeat(64), vout: 0, valueSats: 10_000, scriptPubKeyHex: seller.script.toString("hex") };
  const otherUtxo: Utxo = { txid: "b".repeat(64), vout: 0, valueSats: 10_000, scriptPubKeyHex: seller.script.toString("hex") };

  // A real, validly-signed cancel proof -- but for a DIFFERENT UTXO than
  // the one actually being cancelled. Must not verify against the real listing.
  const { psbtBase64: unsigned } = buildCancelProofPsbt({
    sellerAddress: seller.address,
    sellerInternalPubkeyHex: Buffer.from(sellerKey.publicKey).toString("hex"),
    listingUtxo: otherUtxo,
  });
  const psbt = bitcoin.Psbt.fromBase64(unsigned, { network });
  const tweaked = tweakSigner(sellerKey);
  psbt.signTaprootInput(0, tweaked, undefined, [bitcoin.Transaction.SIGHASH_ALL]);
  const signed = psbt.toBase64();

  const verified = verifyCancelProofPsbt(signed, { txid: realListingUtxo.txid, vout: realListingUtxo.vout }, seller.address);
  assert.equal(verified, false);
});

test("native-bitcoin-listing cancel: a listing-style SIGHASH_SINGLE|ANYONECANPAY signature is rejected as a cancel proof", () => {
  // A real listing PSBT signature must never double as a valid cancel
  // proof -- different sighash domain, by construction, is the whole
  // point of buildCancelProofPsbt's design.
  const sellerKey = ECPair.makeRandom({ network });
  const seller = p2trAddressAndScript(sellerKey);
  const listingUtxo: Utxo = { txid: "a".repeat(64), vout: 0, valueSats: 10_000, scriptPubKeyHex: seller.script.toString("hex") };

  const psbt = new bitcoin.Psbt({ network });
  psbt.addInput({
    hash: listingUtxo.txid,
    index: listingUtxo.vout,
    witnessUtxo: { script: seller.script, value: BigInt(listingUtxo.valueSats) },
    tapInternalKey: toXOnly(Buffer.from(sellerKey.publicKey)),
    sighashType: bitcoin.Transaction.SIGHASH_SINGLE | bitcoin.Transaction.SIGHASH_ANYONECANPAY,
  });
  psbt.addOutput({ address: seller.address, value: BigInt(listingUtxo.valueSats) });
  const tweaked = tweakSigner(sellerKey);
  psbt.signTaprootInput(0, tweaked, undefined, [bitcoin.Transaction.SIGHASH_SINGLE | bitcoin.Transaction.SIGHASH_ANYONECANPAY]);

  const verified = verifyCancelProofPsbt(psbt.toBase64(), { txid: listingUtxo.txid, vout: listingUtxo.vout }, seller.address);
  assert.equal(verified, false);
});

test("native-bitcoin-listing cancel: garbage/malformed input never throws, always returns false", () => {
  const result = verifyCancelProofPsbt("not-a-real-psbt", { txid: "a".repeat(64), vout: 0 }, "tb1pnotarealaddress");
  assert.equal(result, false);
});
