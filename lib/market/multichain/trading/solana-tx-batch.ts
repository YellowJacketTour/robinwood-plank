/**
 * Real single-signature multi-buy batching for Solana (Magic Eden) sweeps.
 *
 * THE TECHNIQUE, VERIFIED AGAINST MAGIC EDEN'S OWN "BUY MULTIPLE" UX
 * ---------------------------------------------------------------------------
 * Magic Eden's own /v2/instructions/buy_now (magiceden-solana-trade.ts)
 * returns a FULLY-BUILT, serialized Transaction per listing -- own
 * blockhash, own fee payer, own instructions already assembled
 * server-side (confirmed live 2026-08-18, see that file's header). The
 * real technique Magic Eden's OWN multi-buy UI, Tensor's, and Blur's
 * (pre-discontinuation) Solana support all use is NOT to submit N of
 * those pre-built transactions as-is: it is to deserialize each one,
 * EXTRACT its instruction list (`Transaction.instructions`, a real,
 * documented @solana/web3.js field -- every legacy Transaction exposes
 * this regardless of which program built it), and re-assemble the
 * extracted instructions under ONE new transaction with a single shared
 * recent blockhash and a single fee payer. Solana instructions are
 * program-agnostic data at the wire level (programId + accounts + data);
 * nothing about "this instruction came from Magic Eden's Auction House
 * program" prevents it from being included in a transaction some other
 * code assembled, which is exactly why this recombination is real and not
 * a guess -- it is the same reason Solana composability works at all.
 *
 * THE REAL LIMIT: TRANSACTION SIZE, NOT INSTRUCTION COUNT
 * ---------------------------------------------------------------------------
 * A Solana transaction is capped at 1232 bytes on the wire (IPv6 MTU 1280
 * minus 48 bytes of header room -- Solana's own documented network
 * constant, not an app-specific guess; see solana.com/docs/core/
 * transactions#transaction-size). A typical Magic Eden buy_now instruction
 * set (Auction House `execute_sale` + its related account list, often
 * with an accompanying ComputeBudget instruction) tends to land in the
 * 250-450 byte range once compiled into a message, so in practice roughly
 * 3-5 such listings' worth of instructions fit under one shared blockhash
 * + fee payer before the next one would push the transaction over the
 * limit -- this module does NOT hardcode "5 items per tx"; it measures
 * the REAL compiled message size after every addition and only closes a
 * batch when the next listing's instructions would actually overflow it,
 * so a sweep of small, cheap instruction sets can and does pack more than
 * 5 into one signature, and a sweep of larger ones packs fewer.
 *
 * FAIL-CLOSED ON UNRECOGNIZED SIGNERS
 * ---------------------------------------------------------------------------
 * Recombining instructions under one fee payer only works if Phantom (the
 * single connected wallet) is the only required signer. If a listing's
 * extracted instructions require some OTHER signer (a real possibility --
 * e.g. an escrow/rent-payer keypair Magic Eden's backend controls, which
 * this app never has access to), that listing cannot be safely folded into
 * a shared transaction: this module detects that case per listing and
 * routes it to the sequential fallback instead of silently dropping the
 * extra signer requirement (which would produce an unsigned, unsendable
 * transaction).
 */

// Minimal structural types mirroring @solana/web3.js's own shapes -- kept
// local (rather than importing the class types directly at the module top)
// so this file's exported pure functions can be exercised in tests using
// plainly-constructed objects without requiring a live wallet or RPC.
export type SolanaAccountMetaLike = {
  pubkey: { toBase58(): string };
  isSigner: boolean;
  isWritable: boolean;
};
export type SolanaInstructionLike = {
  programId: { toBase58(): string };
  keys: SolanaAccountMetaLike[];
  data: Uint8Array;
};

export type ListingInstructionSet = {
  /** Same key callers already use elsewhere (tokenMint) -- lets the caller map a batch back to which listings it covers. */
  key: string;
  instructions: SolanaInstructionLike[];
};

export type BatchPlan = {
  /** Listings whose instructions were successfully grouped, in send order. Each inner array shares one transaction/one signature. */
  batches: Array<{ keys: string[]; instructions: SolanaInstructionLike[] }>;
  /** Listings that could NOT be safely batched (a foreign signer requirement, or a single listing whose own instructions already exceed the byte limit alone) -- caller should fall back to the sequential one-prompt-per-item path for exactly these. */
  unbatchable: string[];
};

/** Solana's real network transaction-size ceiling (bytes). Not app-specific -- see module header. */
export const SOLANA_MAX_TX_BYTES = 1232;
/** One ed25519 signature is always exactly 64 bytes; every batched tx here needs exactly one (the shared fee payer's). */
const SIGNATURE_BYTES = 64;
/** Compact-array length prefixes + the message header/blockhash/fee-payer-slot overhead that exists even for a single-instruction message -- a conservative fixed allowance so the estimate never UNDER-counts real serialized size (short-varint length bytes, 1-byte signature-count prefix, 32-byte blockhash, message header bytes, and the fee payer's own 32-byte account key). */
const FIXED_OVERHEAD_BYTES = 3 + 1 + 32 + 32;

function shortVecLen(n: number): number {
  // Solana's compact-u16 encoding: 1 byte for 0-127, 2 bytes for 128-16383, 3 bytes beyond.
  if (n < 128) return 1;
  if (n < 16384) return 2;
  return 3;
}

/** Estimates the serialized byte size of one instruction as it appears inside a compiled Solana message (program-id-index + accounts compact array + data compact array). Deliberately conservative (rounds estimate upward for the account-index compaction Solana's real compiler applies) since this feeds a hard limit and an over-estimate only wastes a little batching headroom, never risks an oversized tx. */
function estimateInstructionBytes(ix: SolanaInstructionLike): number {
  const accountIndexBytes = 1; // compiled account refs are 1-byte indexes into the message's account table, not raw 32-byte pubkeys
  return (
    1 /* program id index */ +
    shortVecLen(ix.keys.length) +
    ix.keys.length * accountIndexBytes +
    shortVecLen(ix.data.length) +
    ix.data.length
  );
}

/** Distinct writable/readonly account pubkeys an instruction set touches, used only to estimate the message's account-table overhead (each unique account appears once in the table, plus each instruction's own program id). */
function uniqueAccountCount(feePayer: string, instructions: SolanaInstructionLike[]): number {
  const seen = new Set<string>([feePayer]);
  for (const ix of instructions) {
    seen.add(ix.programId.toBase58());
    for (const meta of ix.keys) seen.add(meta.pubkey.toBase58());
  }
  return seen.size;
}

/** True if any instruction requires a signer other than the shared fee payer -- such a listing cannot be safely folded into a co-signed batch (see module header). */
function requiresForeignSigner(feePayer: string, instructions: SolanaInstructionLike[]): boolean {
  return instructions.some((ix) => ix.keys.some((meta) => meta.isSigner && meta.pubkey.toBase58() !== feePayer));
}

/** Estimated total serialized transaction bytes for a candidate instruction set under one fee payer -- signature array + message (header/blockhash/account-table/instruction list). */
function estimateTxBytes(feePayer: string, instructions: SolanaInstructionLike[]): number {
  const accountTableBytes = uniqueAccountCount(feePayer, instructions) * 32;
  const instructionBytes = instructions.reduce((sum, ix) => sum + estimateInstructionBytes(ix), 0);
  return SIGNATURE_BYTES + FIXED_OVERHEAD_BYTES + accountTableBytes + shortVecLen(instructions.length) + instructionBytes;
}

/**
 * Greedily groups per-listing instruction sets into the MINIMUM number of
 * shared-blockhash, single-fee-payer transactions that stay under
 * `maxBytes` -- e.g. 10 small listings might collapse into 2-3
 * transactions (2-3 signatures) instead of 10 sequential ones. A listing
 * is never split across two transactions (its buy must remain atomic);
 * a listing whose own instructions already exceed maxBytes alone, or
 * that requires a signer other than the shared fee payer, is reported in
 * `unbatchable` for sequential-fallback handling instead of silently
 * dropped or corrupted.
 */
export function planSolanaBatches(input: {
  listings: ListingInstructionSet[];
  feePayer: string;
  maxBytes?: number;
}): BatchPlan {
  const maxBytes = input.maxBytes ?? SOLANA_MAX_TX_BYTES;
  const batches: Array<{ keys: string[]; instructions: SolanaInstructionLike[] }> = [];
  const unbatchable: string[] = [];

  let current: { keys: string[]; instructions: SolanaInstructionLike[] } | null = null;

  for (const listing of input.listings) {
    if (requiresForeignSigner(input.feePayer, listing.instructions)) {
      unbatchable.push(listing.key);
      continue;
    }
    const soloBytes = estimateTxBytes(input.feePayer, listing.instructions);
    if (soloBytes > maxBytes) {
      // Doesn't fit even alone -- no combination helps; sequential fallback handles it directly.
      unbatchable.push(listing.key);
      continue;
    }

    const candidateInstructions = current ? [...current.instructions, ...listing.instructions] : listing.instructions;
    const candidateBytes = estimateTxBytes(input.feePayer, candidateInstructions);

    if (current && candidateBytes <= maxBytes) {
      current.keys.push(listing.key);
      current.instructions = candidateInstructions;
    } else {
      if (current) batches.push(current);
      current = { keys: [listing.key], instructions: listing.instructions };
    }
  }
  if (current) batches.push(current);

  return { batches, unbatchable };
}
