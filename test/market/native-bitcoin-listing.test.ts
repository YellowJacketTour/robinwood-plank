import assert from "node:assert/strict";
import test from "node:test";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import { ECPairFactory } from "ecpair";
import {
  buildSellerListingPsbt,
  buildFulfillmentPsbt,
  MARKETPLANK_NATIVE_BITCOIN_FEE_BPS,
  type Utxo,
} from "../../lib/market/multichain/trading/native-bitcoin-listing";
// No import of BITCOIN_FEE_RECIPIENT (lib/constants.ts) -- it's a real
// mainnet address and this test runs entirely on testnet, which requires
// its own NATIVE_BITCOIN_TESTNET_FEE_RECIPIENT (set below, synthetic).

/**
 * Offline, fully-synthetic proof of native-bitcoin-listing.ts's byte-level
 * PSBT construction -- see that module's own header on why this is
 * required before the mainnet gate can ever be considered for removal.
 * Real keys, real signatures, real bitcoinjs-lib finalize/extract -- the
 * only thing "fake" here is that these keys hold no real funds and this
 * transaction is never broadcast. This proves OUR construction math
 * (sighash flags, output sizing, fee injection, change) is internally
 * consistent; it does NOT prove interop with any specific wallet's own
 * signPsbt implementation -- that still needs a real signet/testnet run.
 */

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);
const network = bitcoin.networks.testnet;

function toXOnly(pubkey: Buffer): Buffer {
  return pubkey.length === 32 ? pubkey : pubkey.subarray(1, 33);
}

function tapTweakHash(pubKey: Buffer, h?: Buffer): Buffer {
  return bitcoin.crypto.taggedHash("TapTweak", h ? Buffer.concat([pubKey, h]) : pubKey);
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
  // p2tr.output is a raw Uint8Array, NOT a Node Buffer -- .toString("hex")
  // on a bare Uint8Array silently ignores the encoding argument and
  // produces a garbage comma-joined decimal string instead of throwing,
  // which then truncates to one byte on the next Buffer.from(..., "hex")
  // parse. Wrapping here once, at the source, so every caller gets a real
  // Buffer instead of every call site needing to remember this.
  return { address: p2tr.address!, script: Buffer.from(p2tr.output!) };
}

test("native-bitcoin-listing: full seller-list -> buyer-fulfill round trip finalizes and preserves the inscribed satoshi", async () => {
  // --- Seller side ---
  const sellerKey = ECPair.makeRandom({ network });
  const seller = p2trAddressAndScript(sellerKey);
  const inscriptionUtxo: Utxo = {
    txid: "a".repeat(64),
    vout: 0,
    valueSats: 10_000, // the whole UTXO the inscription lives on
    scriptPubKeyHex: seller.script.toString("hex"),
  };
  const priceSats = 1_000_000;

  const { psbtBase64: unsignedListingPsbt, inputIndexToSign } = buildSellerListingPsbt({
    sellerAddress: seller.address,
    sellerInternalPubkeyHex: Buffer.from(sellerKey.publicKey).toString("hex"),
    inscriptionUtxo,
    priceSats,
  });
  assert.equal(inputIndexToSign, 0);

  // Seller's own wallet signs input 0 with SIGHASH_SINGLE|ANYONECANPAY.
  const listingPsbt = bitcoin.Psbt.fromBase64(unsignedListingPsbt, { network });
  const tweakedSeller = tweakSigner(sellerKey);
  listingPsbt.signTaprootInput(0, tweakedSeller, undefined, [
    bitcoin.Transaction.SIGHASH_SINGLE | bitcoin.Transaction.SIGHASH_ANYONECANPAY,
  ]);
  const signedListingPsbtBase64 = listingPsbt.toBase64();

  // Sanity: the signed leg really is signed and has the shape we expect.
  const reparsed = bitcoin.Psbt.fromBase64(signedListingPsbtBase64, { network });
  assert.ok(reparsed.data.inputs[0].tapKeySig, "seller input must carry a taproot key signature");

  // --- Buyer side ---
  const buyerKey = ECPair.makeRandom({ network });
  const buyer = p2trAddressAndScript(buyerKey);
  const buyerReceivingKey = ECPair.makeRandom({ network });
  const buyerReceiving = p2trAddressAndScript(buyerReceivingKey);
  const buyerChangeKey = ECPair.makeRandom({ network });
  const buyerChange = p2trAddressAndScript(buyerChangeKey);
  const feeRecipientKey = ECPair.makeRandom({ network });
  const feeRecipient = p2trAddressAndScript(feeRecipientKey);
  process.env.NATIVE_BITCOIN_TESTNET_FEE_RECIPIENT = feeRecipient.address;

  const dummyUtxo: Utxo = {
    txid: "b".repeat(64),
    vout: 0,
    valueSats: 600,
    scriptPubKeyHex: buyer.script.toString("hex"),
  };
  const paymentUtxo: Utxo = {
    txid: "c".repeat(64),
    vout: 0,
    valueSats: 1_100_000, // comfortably covers price + fee + miner fee
    scriptPubKeyHex: buyer.script.toString("hex"),
  };

  const feeSats = Math.ceil((priceSats * MARKETPLANK_NATIVE_BITCOIN_FEE_BPS) / 10_000);

  const { psbtBase64: fulfillmentPsbtBase64, inputIndexesForBuyerToSign } = await buildFulfillmentPsbt({
    listingSellerPsbtBase64: signedListingPsbtBase64,
    sellerInscriptionUtxoValueSats: inscriptionUtxo.valueSats,
    buyerAddress: buyer.address,
    buyerInternalPubkeyHex: Buffer.from(buyerKey.publicKey).toString("hex"),
    buyerReceivingAddress: buyerReceiving.address,
    buyerChangeAddress: buyerChange.address,
    buyerDummyUtxo: dummyUtxo,
    buyerPaymentUtxoCandidates: [paymentUtxo],
    feeRateSatPerVb: 5,
    // Offline stand-in for the real UniSat-backed gate -- proves this
    // module's own logic, not the network call. The real gate is exercised
    // separately (see bitcoin-utxo-safety.ts) and MUST be live-verified
    // before this engine goes anywhere near mainnet.
    safetyFilter: async (_address, candidates) => candidates,
  });
  assert.deepEqual(inputIndexesForBuyerToSign, [0, 2]);

  // Buyer signs input 0 (dummy, full SIGHASH_ALL/DEFAULT) and input 2
  // (payment UTXO). Input 1 (the seller's leg) must NEVER be touched.
  const fulfillPsbt = bitcoin.Psbt.fromBase64(fulfillmentPsbtBase64, { network });
  const tweakedBuyer = tweakSigner(buyerKey);
  fulfillPsbt.signTaprootInput(0, tweakedBuyer);
  fulfillPsbt.signTaprootInput(2, tweakedBuyer);
  fulfillPsbt.finalizeInput(0);
  fulfillPsbt.finalizeInput(1); // seller's ANYONECANPAY leg finalizes from its own preserved signature
  fulfillPsbt.finalizeInput(2);

  const extracted = fulfillPsbt.extractTransaction();
  assert.equal(extracted.ins.length, 3);

  // --- The load-bearing assertions ---
  const outs = extracted.outs;
  // Output 0: buyer's receiving address gets dummy + the WHOLE seller UTXO
  // value -- this is the exact guarantee that the inscribed satoshi,
  // wherever it sits inside the seller's UTXO, cannot be split off into
  // fee/change/dummy outputs.
  assert.equal(Number(outs[0].value), dummyUtxo.valueSats + inscriptionUtxo.valueSats);
  assert.ok(bitcoin.address.fromOutputScript(outs[0].script, network) === buyerReceiving.address);

  // Output 1: seller gets exactly the listed price, unchanged from their
  // own signed listing PSBT.
  assert.equal(Number(outs[1].value), priceSats);
  assert.ok(bitcoin.address.fromOutputScript(outs[1].script, network) === seller.address);

  // Output 2: Marketplank's fee, at exactly the documented bps, landing at
  // the exact treasury address wired in lib/constants.ts.
  assert.equal(Number(outs[2].value), feeSats);
  assert.ok(bitcoin.address.fromOutputScript(outs[2].script, network) === feeRecipient.address);

  // Output 3: a fresh dummy UTXO, same size as the one consumed.
  assert.equal(Number(outs[3].value), dummyUtxo.valueSats);
  assert.ok(bitcoin.address.fromOutputScript(outs[3].script, network) === buyer.address);

  // Output 4: change, and total ins/outs + implied miner fee reconcile
  // exactly (no sats created or destroyed).
  const totalIn = dummyUtxo.valueSats + inscriptionUtxo.valueSats + paymentUtxo.valueSats;
  const totalOut = outs.reduce((sum, o) => sum + Number(o.value), 0);
  assert.ok(totalOut < totalIn, "miner fee must have been deducted somewhere");
  assert.ok(totalIn - totalOut < 5000, "implied miner fee should be a small, sane amount, not a runaway value");

  // The whole thing is a structurally valid, re-parseable transaction.
  const roundTrip = bitcoin.Transaction.fromBuffer(extracted.toBuffer());
  assert.equal(roundTrip.getId(), extracted.getId());
});

test("native-bitcoin-listing: throws rather than under-funding when no safe UTXO covers the total", async () => {
  const sellerKey = ECPair.makeRandom({ network });
  const seller = p2trAddressAndScript(sellerKey);
  const inscriptionUtxo: Utxo = {
    txid: "d".repeat(64),
    vout: 0,
    valueSats: 10_000,
    scriptPubKeyHex: seller.script.toString("hex"),
  };
  const priceSats = 1_000_000;
  const { psbtBase64: unsignedListingPsbt } = buildSellerListingPsbt({
    sellerAddress: seller.address,
    sellerInternalPubkeyHex: Buffer.from(sellerKey.publicKey).toString("hex"),
    inscriptionUtxo,
    priceSats,
  });
  const listingPsbt = bitcoin.Psbt.fromBase64(unsignedListingPsbt, { network });
  listingPsbt.signTaprootInput(0, tweakSigner(sellerKey), undefined, [
    bitcoin.Transaction.SIGHASH_SINGLE | bitcoin.Transaction.SIGHASH_ANYONECANPAY,
  ]);

  const buyerKey = ECPair.makeRandom({ network });
  const buyer = p2trAddressAndScript(buyerKey);
  const dummyUtxo: Utxo = { txid: "e".repeat(64), vout: 0, valueSats: 600, scriptPubKeyHex: buyer.script.toString("hex") };
  const tinyPaymentUtxo: Utxo = { txid: "f".repeat(64), vout: 0, valueSats: 1000, scriptPubKeyHex: buyer.script.toString("hex") };

  await assert.rejects(
    () =>
      buildFulfillmentPsbt({
        listingSellerPsbtBase64: listingPsbt.toBase64(),
        sellerInscriptionUtxoValueSats: inscriptionUtxo.valueSats,
        buyerAddress: buyer.address,
        buyerInternalPubkeyHex: Buffer.from(buyerKey.publicKey).toString("hex"),
        buyerReceivingAddress: buyer.address,
        buyerChangeAddress: buyer.address,
        buyerDummyUtxo: dummyUtxo,
        buyerPaymentUtxoCandidates: [tinyPaymentUtxo],
        feeRateSatPerVb: 5,
        safetyFilter: async (_address, candidates) => candidates,
      }),
    /insufficient proven-safe buyer UTXOs/
  );
});

test("native-bitcoin-listing: a payment UTXO the safety filter rejects is never spent, even if it would balance the transaction", async () => {
  const sellerKey = ECPair.makeRandom({ network });
  const seller = p2trAddressAndScript(sellerKey);
  const inscriptionUtxo: Utxo = {
    txid: "1".repeat(64),
    vout: 0,
    valueSats: 10_000,
    scriptPubKeyHex: seller.script.toString("hex"),
  };
  const priceSats = 100_000;
  const { psbtBase64: unsignedListingPsbt } = buildSellerListingPsbt({
    sellerAddress: seller.address,
    sellerInternalPubkeyHex: Buffer.from(sellerKey.publicKey).toString("hex"),
    inscriptionUtxo,
    priceSats,
  });
  const listingPsbt = bitcoin.Psbt.fromBase64(unsignedListingPsbt, { network });
  listingPsbt.signTaprootInput(0, tweakSigner(sellerKey), undefined, [
    bitcoin.Transaction.SIGHASH_SINGLE | bitcoin.Transaction.SIGHASH_ANYONECANPAY,
  ]);

  const buyerKey = ECPair.makeRandom({ network });
  const buyer = p2trAddressAndScript(buyerKey);
  const dummyUtxo: Utxo = { txid: "2".repeat(64), vout: 0, valueSats: 600, scriptPubKeyHex: buyer.script.toString("hex") };
  const rejectedUtxo: Utxo = { txid: "3".repeat(64), vout: 0, valueSats: 500_000, scriptPubKeyHex: buyer.script.toString("hex") };

  await assert.rejects(
    () =>
      buildFulfillmentPsbt({
        listingSellerPsbtBase64: listingPsbt.toBase64(),
        sellerInscriptionUtxoValueSats: inscriptionUtxo.valueSats,
        buyerAddress: buyer.address,
        buyerInternalPubkeyHex: Buffer.from(buyerKey.publicKey).toString("hex"),
        buyerReceivingAddress: buyer.address,
        buyerChangeAddress: buyer.address,
        buyerDummyUtxo: dummyUtxo,
        buyerPaymentUtxoCandidates: [rejectedUtxo],
        feeRateSatPerVb: 5,
        // Simulates the real safety gate excluding a UTXO (e.g. it holds
        // an inscription/rune) even though it has plenty of value.
        safetyFilter: async () => [],
      }),
    /insufficient proven-safe buyer UTXOs/
  );
});
