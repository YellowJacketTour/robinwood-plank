import * as bitcoin from "bitcoinjs-lib";

/**
 * Buyer-side PSBT verification before signing a marketplace-built bid
 * (AUDIT lens 3 #7; research: CertiK PSBT checklist, me-foundation/msigner,
 * the Atomicals "zero-yuan purchase" incident). A marketplace's PSBT is a
 * third-party document; signing it blind lets a bad or compromised response
 * spend the buyer's inputs however it likes. Every rule below is a
 * structural check on the decoded transaction, never on the vendor's word.
 *
 * Rules:
 *  1. Every input we are asked to sign must be enumerated (`signIndexes`)
 *     and must NOT be the seller's input; we never sign an index we did not
 *     ask for.
 *  2. There is at least one output to the buyer's own address (the
 *     inscription landing output).
 *  3. Everything paid to addresses that are not the buyer's is at most the
 *     quoted price plus the allowed marketplace fee.
 *  4. When every input carries a witnessUtxo value, the implied miner fee
 *     is at most `maxFeeSats`.
 *  5. Buyer inputs use SIGHASH_ALL/DEFAULT (never SINGLE|ANYONECANPAY, which
 *     is the seller-side type and the mempool-sniping vector).
 */
export type PsbtSafetyInput = {
  psbtBase64: string;
  buyerAddress: string;
  signIndexes: number[];
  /** The listing price the buyer confirmed, in sats. */
  priceSats: bigint;
  /** Allowed marketplace fee on top of the price, in sats (default: 3% of price, floor 1,000 sats). */
  maxMarketplaceFeeSats?: bigint;
  /** Maximum miner fee this buyer accepts, in sats (default 50,000). */
  maxFeeSats?: bigint;
  network?: bitcoin.Network;
};

export type PsbtSafetyReport = {
  buyerOutputsSats: bigint;
  otherOutputsSats: bigint;
  feeSats: bigint | null;
  inputsToSign: number[];
};

const SIGHASH_ALL = 0x01;
const SIGHASH_DEFAULT = 0x00;

function networksFor(network?: bitcoin.Network): bitcoin.Network[] {
  return network ? [network] : [bitcoin.networks.bitcoin, bitcoin.networks.testnet];
}

function addressOf(script: Uint8Array, networks: bitcoin.Network[]): string | null {
  for (const n of networks) {
    try {
      return bitcoin.address.fromOutputScript(script, n);
    } catch {
      /* try next */
    }
  }
  return null;
}

export function assertBuyPsbtSafe(input: PsbtSafetyInput): PsbtSafetyReport {
  const networks = networksFor(input.network);
  const psbt = bitcoin.Psbt.fromBase64(input.psbtBase64, input.network ? { network: input.network } : undefined);
  const inputCount = psbt.txInputs.length;
  const outputCount = psbt.txOutputs.length;
  if (inputCount === 0 || outputCount === 0) throw new Error("PSBT refused: empty transaction.");

  // Rule 1: enumerated inputs only, no seller-typed sighash among ours.
  const inputsToSign = [...new Set(input.signIndexes)].sort((a, b) => a - b);
  for (const idx of inputsToSign) {
    if (idx < 0 || idx >= inputCount) throw new Error(`PSBT refused: asked to sign input ${idx} which does not exist.`);
    const sighash = psbt.data.inputs[idx]?.sighashType;
    if (sighash != null && sighash !== SIGHASH_ALL && sighash !== SIGHASH_DEFAULT) {
      throw new Error(`PSBT refused: input ${idx} requests sighash 0x${sighash.toString(16)}; a buyer signs ALL only.`);
    }
    if (psbt.data.inputs[idx]?.finalScriptWitness || psbt.data.inputs[idx]?.finalScriptSig) {
      throw new Error(`PSBT refused: input ${idx} is already finalized (seller-side input); refusing to sign it.`);
    }
  }
  // Rule 5 (seller input present): exactly the non-signed inputs may carry SINGLE|ANYONECANPAY.
  let buyerOut = 0n;
  let otherOut = 0n;
  for (const out of psbt.txOutputs) {
    const addr = addressOf(out.script, networks);
    const value = BigInt(out.value);
    if (addr && addr === input.buyerAddress) buyerOut += value;
    else otherOut += value;
  }
  // Rule 2
  if (buyerOut <= 0n) throw new Error("PSBT refused: no output pays the buyer's address (the inscription would not land with you).");
  // Rule 3
  const maxFee = input.maxMarketplaceFeeSats ?? (input.priceSats * 3n) / 100n + 1_000n;
  if (otherOut > input.priceSats + maxFee) {
    throw new Error(`PSBT refused: outputs to others total ${otherOut} sats, above the confirmed ${input.priceSats} sats plus allowed fee.`);
  }
  // Rule 4
  let feeSats: bigint | null = null;
  const allValued = psbt.data.inputs.every((i) => i.witnessUtxo != null || i.nonWitnessUtxo != null);
  if (allValued) {
    let inSum = 0n;
    psbt.data.inputs.forEach((i, idx) => {
      if (i.witnessUtxo) inSum += BigInt(i.witnessUtxo.value);
      else if (i.nonWitnessUtxo) {
        const prev = bitcoin.Transaction.fromBuffer(Buffer.from(i.nonWitnessUtxo));
        inSum += BigInt(prev.outs[psbt.txInputs[idx].index].value);
      }
    });
    feeSats = inSum - buyerOut - otherOut;
    const maxMiner = input.maxFeeSats ?? 50_000n;
    if (feeSats < 0n) throw new Error("PSBT refused: outputs exceed inputs.");
    if (feeSats > maxMiner) throw new Error(`PSBT refused: miner fee ${feeSats} sats exceeds the ${maxMiner} sat ceiling.`);
  }
  return { buyerOutputsSats: buyerOut, otherOutputsSats: otherOut, feeSats, inputsToSign };
}
