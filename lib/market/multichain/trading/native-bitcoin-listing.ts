/**
 * Marketplank-native Bitcoin Ordinals listing engine -- own PSBT
 * construction, no UniSat order book involved. Built 2026-08-19.
 *
 * WHY THIS EXISTS: see 026_native_bitcoin_listings.sql's own header.
 * Short version -- UniSat's documented create_bid flow has no
 * affiliate/referral fee field (checked live, not assumed), so trades
 * through it earn Marketplank nothing. This is a separate, additive
 * listing surface where OUR fee is baked into the one transaction the
 * buyer signs, the same "non-optional by construction" doctrine every
 * other Marketplank-native order type in this app already uses.
 *
 * THIS MODULE NEVER HOLDS OR USES A PRIVATE KEY. Same boundary as every
 * other trading module in this app (magiceden-solana-trade.ts's own
 * header: "never execute, only construct calldata"). It builds unsigned
 * (or partially-signed) PSBTs; the seller's and buyer's own wallets
 * (UniSat/Xverse/Leather's signPsbt) do all actual signing.
 *
 * THE CONSTRUCTION PATTERN IS OpenOrdex's PROVEN PROTOCOL, READ FROM
 * THEIR REAL SOURCE, NOT INVENTED
 * ---------------------------------------------------------------------------
 * Verified live 2026-08-19 (github.com/orenyomtov/openordex, js/app.js):
 *
 *   SELLER'S LISTING PSBT (buildSellerListingPsbt):
 *     Input 0  = the inscription's own UTXO.
 *     Output 0 = seller's payment address, value = price.
 *     Seller signs input 0 with SIGHASH_SINGLE | SIGHASH_ANYONECANPAY --
 *     SINGLE commits input 0 to output 0 ONLY (not the whole tx), and
 *     ANYONECANPAY allows arbitrary inputs/outputs to be appended around
 *     it later without invalidating this signature. This is the entire
 *     reason a listing can be created once and fulfilled later by anyone,
 *     without the seller being online again.
 *
 *   BUYER'S FULFILLMENT PSBT (buildFulfillmentPsbt):
 *     Input 0  = buyer's own small "dummy" UTXO.
 *     Output 0 = buyer's receiving address, value = dummyUtxo.value +
 *                sellerUtxo.value.
 *     Input 1  = the seller's already-signed input, copied verbatim
 *                (including its signature) from the listing PSBT.
 *     Output 1 = the seller's payment output, copied verbatim from the
 *                listing PSBT (same address, same value -- SIGHASH_SINGLE
 *                requires output 1 to match exactly or the seller's
 *                signature becomes invalid).
 *     Output 2 = Marketplank's fee (NEW vs. OpenOrdex's own protocol --
 *                see MARKETPLANK_NATIVE_BITCOIN_FEE_BPS).
 *     Input 2+ = buyer's payment UTXOs, covering price + fee + miner fee.
 *     Output 3 = a fresh dummy UTXO back to the buyer (so they have one
 *                ready for their next purchase).
 *     Output 4 = change to the buyer.
 *
 *     WHY OUTPUT 0's VALUE IS dummy + sellerUtxo, NOT JUST sellerUtxo:
 *     Ordinals sat-assignment is FIFO across the transaction's total
 *     input value, in input order, not tied to input/output index
 *     matching. Sizing output 0 to consume BOTH input 0 (dummy) and all
 *     of input 1 (the seller's UTXO) guarantees the inscribed satoshi --
 *     wherever it actually sits inside the seller's UTXO -- is entirely
 *     inside that one output. Getting this value wrong is exactly how an
 *     inscription gets silently burned into a fee or change output; it is
 *     the single most safety-critical number in this file.
 *
 * TAPROOT KEY-PATH SIGNING: bitcoinjs-lib's own documented pattern for
 * P2TR key-path spends (tweak the signer's private key by the BIP-341
 * TapTweak hash of its x-only pubkey before signing) -- required because
 * every UTXO this module touches is P2TR (Ordinals/Runes require it; see
 * BITCOIN_FEE_RECIPIENT's own comment in lib/constants.ts).
 *
 * HARD MAINNET GATE -- READ BEFORE REMOVING
 * ---------------------------------------------------------------------------
 * A bug here has no upgrade path: unlike a smart contract, a broadcast
 * Bitcoin transaction cannot be paused, upgraded, or reversed. This
 * module's byte-level construction is proven correct by
 * test/market/native-bitcoin-listing.test.ts (a full offline round-trip:
 * synthetic keys build, sign, and finalize both PSBTs, then assert every
 * output value is exactly right) -- but that only proves OUR construction
 * math, not real-world interop with every wallet's own signPsbt quirks.
 * bitcoinNetwork() below refuses to return mainnet unless
 * NATIVE_BITCOIN_MAINNET_ENABLED is explicitly set -- which nothing in
 * this codebase sets yet. Do not set it until a real signet/testnet
 * purchase, buyer wallet included, has actually completed and the
 * resulting transaction has been read back off-chain to confirm the
 * inscription landed at the right output. Same standing discipline this
 * whole session holds for contract deploys, applied here because a bad
 * Bitcoin broadcast is equally irreversible.
 */
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import { BITCOIN_FEE_RECIPIENT } from "@/lib/constants";
import { filterProvenSafeUtxos, type BitcoinUtxoRef } from "@/lib/market/multichain/trading/bitcoin-utxo-safety";

bitcoin.initEccLib(ecc);

/** 1.8%, matching every other Marketplank-native fee rate in this app (see MARKET_FEE_RECIPIENT's siblings in lib/constants.ts). Kept local rather than re-exported from constants.ts because this is the one fee rate that has never been proven live -- flagged deliberately, not an oversight. */
export const MARKETPLANK_NATIVE_BITCOIN_FEE_BPS = 180;

/** Only ever "testnet" until a real, verified purchase has completed on it -- see this file's own header. */
export function bitcoinNetwork(): bitcoin.networks.Network {
  const mainnetEnabled = process.env.NATIVE_BITCOIN_MAINNET_ENABLED === "true";
  return mainnetEnabled ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
}

/**
 * BITCOIN_FEE_RECIPIENT (lib/constants.ts) is a real MAINNET address -- it
 * is structurally invalid to include as an output on a testnet PSBT
 * (bitcoinjs-lib's own address decoder enforces this and throws "invalid
 * prefix" if attempted, which is exactly the right behavior: a build
 * misconfiguration here must fail loudly, never silently substitute one
 * network's address into the other's transaction).
 *
 * Testnet runs therefore need their OWN treasury address, via
 * NATIVE_BITCOIN_TESTNET_FEE_RECIPIENT -- not set anywhere yet, so
 * testnet fulfillment throws with a clear, actionable message until one
 * is provisioned (the same "generate a fresh address, never derive it
 * from the mainnet key" guidance as BITCOIN_FEE_RECIPIENT itself).
 */
function feeRecipientAddress(): string {
  if (bitcoinNetwork() === bitcoin.networks.bitcoin) {
    return BITCOIN_FEE_RECIPIENT;
  }
  const testnetRecipient = process.env.NATIVE_BITCOIN_TESTNET_FEE_RECIPIENT;
  if (!testnetRecipient) {
    throw new Error(
      "native-bitcoin-listing: NATIVE_BITCOIN_TESTNET_FEE_RECIPIENT is not configured -- a fresh testnet Taproot address is required to fulfill a testnet listing (BITCOIN_FEE_RECIPIENT is mainnet-only and cannot appear in a testnet transaction)."
    );
  }
  return testnetRecipient;
}

export type Utxo = {
  txid: string;
  vout: number;
  valueSats: number;
  /** The UTXO's own scriptPubKey, hex-encoded -- required for witnessUtxo on every P2TR input; never derived/guessed here, always read from a live UTXO lookup. */
  scriptPubKeyHex: string;
};

function toXOnly(pubkeyHex: string): Buffer {
  const buf = Buffer.from(pubkeyHex, "hex");
  return buf.length === 32 ? buf : buf.subarray(1, 33);
}

/**
 * Builds the seller's listing PSBT: one input (the inscription UTXO), one
 * output (the seller's payment address), sighash SINGLE|ANYONECANPAY. The
 * seller's own wallet signs input 0 of the RETURNED psbt -- this function
 * never signs anything.
 *
 * `sellerInternalPubkeyHex` MUST be the seller's own real public key
 * (compressed 33-byte or x-only 32-byte hex) -- NOT derivable from their
 * Taproot address alone (that's the entire point of BIP-341's key tweak:
 * an address encodes the TWEAKED output key, not the raw internal key).
 * The caller gets this from the connected wallet's own API before calling
 * here -- e.g. UniSat's window.unisat.getPublicKey(), already used the
 * same way by unisat-ordinals-trade.ts's create_bid flow (see that file's
 * own header). Without a real tapInternalKey set, bitcoinjs-lib's own
 * signTaprootInput refuses to sign at all ("Input #0 is not of type
 * Taproot") -- caught by this module's own offline test, not assumed.
 */
export function buildSellerListingPsbt(input: {
  sellerAddress: string;
  sellerInternalPubkeyHex: string;
  inscriptionUtxo: Utxo;
  priceSats: number;
}): { psbtBase64: string; inputIndexToSign: 0 } {
  if (input.priceSats <= 0) throw new Error("native-bitcoin-listing: priceSats must be positive.");
  const network = bitcoinNetwork();
  const psbt = new bitcoin.Psbt({ network });

  psbt.addInput({
    hash: input.inscriptionUtxo.txid,
    index: input.inscriptionUtxo.vout,
    witnessUtxo: {
      script: Buffer.from(input.inscriptionUtxo.scriptPubKeyHex, "hex"),
      value: BigInt(input.inscriptionUtxo.valueSats),
    },
    tapInternalKey: toXOnly(input.sellerInternalPubkeyHex),
    sighashType: bitcoin.Transaction.SIGHASH_SINGLE | bitcoin.Transaction.SIGHASH_ANYONECANPAY,
  });

  psbt.addOutput({ address: input.sellerAddress, value: BigInt(input.priceSats) });

  return { psbtBase64: psbt.toBase64(), inputIndexToSign: 0 };
}

/**
 * Copies the seller's already-signed input (index 0 of their listing
 * PSBT) and its matching output (index 0) into a fresh Psbt, verbatim --
 * never re-derives or re-signs either. Throws if the listing PSBT isn't
 * exactly the one-input/one-output shape buildSellerListingPsbt produces
 * (a malformed or tampered listing PSBT must fail loudly here, not be
 * silently reinterpreted).
 */
type SellerLeg = {
  rawInput: bitcoin.PsbtTxInput;
  psbtInputData: bitcoin.Psbt["data"]["inputs"][number];
  output: { address: string; valueSats: number };
};

function extractSellerLeg(sellerPsbtBase64: string): SellerLeg {
  const network = bitcoinNetwork();
  const sellerPsbt = bitcoin.Psbt.fromBase64(sellerPsbtBase64, { network });
  if (sellerPsbt.txInputs.length !== 1 || sellerPsbt.txOutputs.length !== 1) {
    throw new Error("native-bitcoin-listing: listing PSBT must have exactly one input and one output.");
  }
  const psbtInputData = sellerPsbt.data.inputs[0];
  if (!psbtInputData.partialSig && !psbtInputData.tapKeySig) {
    throw new Error("native-bitcoin-listing: listing PSBT's input is unsigned.");
  }
  const rawInput = sellerPsbt.txInputs[0];
  const out = sellerPsbt.txOutputs[0];
  const outAddress = bitcoin.address.fromOutputScript(out.script, network);
  return {
    rawInput,
    psbtInputData,
    output: { address: outAddress, valueSats: Number(out.value) },
  };
}

/**
 * Builds the buyer's fulfillment PSBT. `buyerPaymentUtxoCandidates` is
 * whatever the buyer's wallet reports as spendable -- ALWAYS run through
 * bitcoin-utxo-safety.ts's filterProvenSafeUtxos before use here (this
 * function does that itself, fail-closed: any candidate that isn't
 * independently proven inscription/rune-free is silently excluded, never
 * spent). If too few clean UTXOs remain to cover the total, this throws
 * rather than reaching for an unproven one.
 *
 * Returns the unsigned PSBT plus which input indexes the BUYER's wallet
 * must sign (the seller's input, index 1, is already fully signed and
 * must never be touched again).
 */
export async function buildFulfillmentPsbt(input: {
  listingSellerPsbtBase64: string;
  sellerInscriptionUtxoValueSats: number;
  buyerAddress: string;
  /** The buyer's own public key, compressed (33-byte) or x-only (32-byte) hex -- same requirement and same source (the connected wallet's own getPublicKey) as sellerInternalPubkeyHex above. Applied to every buyer-owned input (dummy + payment UTXOs), which is only correct because this engine assumes all of a buyer's spendable UTXOs come from ONE address/key -- true for a typical single-account wallet connection, not yet extended to multi-address wallets. */
  buyerInternalPubkeyHex: string;
  buyerReceivingAddress: string;
  buyerChangeAddress: string;
  buyerDummyUtxo: Utxo;
  buyerPaymentUtxoCandidates: Utxo[];
  feeRateSatPerVb: number;
  /** Injectable for tests -- defaults to the real UniSat-backed gate. Never override this in production code; it exists so test/market/native-bitcoin-listing.test.ts can prove the PSBT construction math offline without a real API key or network access. */
  safetyFilter?: (address: string, candidates: BitcoinUtxoRef[]) => Promise<BitcoinUtxoRef[]>;
}): Promise<{ psbtBase64: string; inputIndexesForBuyerToSign: number[] }> {
  const network = bitcoinNetwork();
  const seller = extractSellerLeg(input.listingSellerPsbtBase64);
  const runSafetyFilter = input.safetyFilter ?? filterProvenSafeUtxos;

  // Fail-closed UTXO screening -- protects the BUYER, not just Marketplank:
  // a naive "pick enough sats" selection over wallet-reported UTXOs could
  // spend an inscription/rune the buyer didn't mean to as plain payment.
  const safeCandidates = await runSafetyFilter(
    input.buyerAddress,
    input.buyerPaymentUtxoCandidates.map((u): BitcoinUtxoRef => ({ txid: u.txid, vout: u.vout }))
  );
  const safeSet = new Set(safeCandidates.map((u) => `${u.txid}:${u.vout}`));
  const provenSafeUtxos = input.buyerPaymentUtxoCandidates.filter((u) => safeSet.has(`${u.txid}:${u.vout}`));

  const feeSats = Math.ceil((seller.output.valueSats * MARKETPLANK_NATIVE_BITCOIN_FEE_BPS) / 10_000);

  const psbt = new bitcoin.Psbt({ network });

  const buyerTapInternalKey = toXOnly(input.buyerInternalPubkeyHex);

  // Input 0: buyer's dummy UTXO.
  psbt.addInput({
    hash: input.buyerDummyUtxo.txid,
    index: input.buyerDummyUtxo.vout,
    witnessUtxo: {
      script: Buffer.from(input.buyerDummyUtxo.scriptPubKeyHex, "hex"),
      value: BigInt(input.buyerDummyUtxo.valueSats),
    },
    tapInternalKey: buyerTapInternalKey,
  });

  // Output 0: buyer's receiving address -- sized to consume dummy +
  // the ENTIRE seller UTXO, guaranteeing the inscribed sat lands here.
  // See this file's own header for why this exact sum is load-bearing.
  const receivingValue = input.buyerDummyUtxo.valueSats + input.sellerInscriptionUtxoValueSats;
  psbt.addOutput({ address: input.buyerReceivingAddress, value: BigInt(receivingValue) });

  // Input 1: the seller's already-signed input, copied verbatim.
  if (!seller.psbtInputData.witnessUtxo) {
    throw new Error("native-bitcoin-listing: listing PSBT's input is missing its witness UTXO.");
  }
  psbt.addInput({
    hash: seller.rawInput.hash,
    index: seller.rawInput.index,
    witnessUtxo: seller.psbtInputData.witnessUtxo,
    sighashType: bitcoin.Transaction.SIGHASH_SINGLE | bitcoin.Transaction.SIGHASH_ANYONECANPAY,
  });
  if (seller.psbtInputData.tapKeySig) {
    psbt.updateInput(1, { tapKeySig: seller.psbtInputData.tapKeySig });
  } else if (seller.psbtInputData.partialSig) {
    psbt.updateInput(1, { partialSig: seller.psbtInputData.partialSig });
  }

  // Output 1: the seller's payment output, copied verbatim -- SIGHASH_SINGLE
  // requires this to match exactly (address AND value) or the seller's
  // signature is invalid and the transaction cannot finalize.
  psbt.addOutput({ address: seller.output.address, value: BigInt(seller.output.valueSats) });

  // Output 2: Marketplank's fee -- non-optional by construction, baked
  // into the one transaction the buyer signs, same doctrine as this app's
  // EVM Seaport-tip mechanism.
  psbt.addOutput({ address: feeRecipientAddress(), value: BigInt(feeSats) });

  // Inputs 2+: buyer's payment UTXOs, proven safe above. Select greedily
  // until covered; throw (not silently under-fund) if exhausted.
  const required = seller.output.valueSats + feeSats;
  let collected = 0;
  const usedPaymentUtxos: Utxo[] = [];
  for (const utxo of provenSafeUtxos) {
    if (collected >= required + input.buyerDummyUtxo.valueSats) break; // rough; refined below with real fee
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: { script: Buffer.from(utxo.scriptPubKeyHex, "hex"), value: BigInt(utxo.valueSats) },
      tapInternalKey: buyerTapInternalKey,
    });
    usedPaymentUtxos.push(utxo);
    collected += utxo.valueSats;
  }

  // Output 3: fresh dummy UTXO back to the buyer, sized the same as the
  // one consumed at input 0 -- keeps them able to buy again without a
  // separate dummy-creation transaction.
  const newDummyValue = input.buyerDummyUtxo.valueSats;
  psbt.addOutput({ address: input.buyerAddress, value: BigInt(newDummyValue) });

  // Estimate size for the miner fee: 2 P2TR key-path inputs so far (dummy +
  // payment inputs) plus the seller's input contribute no vbytes to the
  // buyer's fee burden in spirit, but they ARE bytes in the final tx, so
  // count everything actually being broadcast. ~58 vbytes per P2TR input,
  // ~43 per P2TR output, ~11 fixed overhead -- standard estimates, not
  // exact; real wallets re-simulate before broadcast regardless.
  const inputCount = 2 + usedPaymentUtxos.length; // dummy + seller + payment
  const outputCount = 5; // receiving, seller payment, fee, new dummy, change
  const estimatedVBytes = 11 + inputCount * 58 + outputCount * 43;
  const minerFeeSats = Math.ceil(estimatedVBytes * input.feeRateSatPerVb);

  const totalOut = receivingValue + seller.output.valueSats + feeSats + newDummyValue;
  const totalIn = input.buyerDummyUtxo.valueSats + input.sellerInscriptionUtxoValueSats + collected;
  const changeSats = totalIn - totalOut - minerFeeSats;
  if (changeSats < 0) {
    throw new Error(
      `native-bitcoin-listing: insufficient proven-safe buyer UTXOs to cover price + fee + miner fee (short by ${-changeSats} sats).`
    );
  }

  // Output 4: change, only if above dust (546 sats is Bitcoin Core's
  // standard dust threshold for a P2WPKH-class output; omitting a
  // below-dust change output rather than creating an unspendable one).
  if (changeSats >= 546) {
    psbt.addOutput({ address: input.buyerChangeAddress, value: BigInt(changeSats) });
  }

  const inputIndexesForBuyerToSign = [0, ...usedPaymentUtxos.map((_, i) => 2 + i)];

  return { psbtBase64: psbt.toBase64(), inputIndexesForBuyerToSign };
}
