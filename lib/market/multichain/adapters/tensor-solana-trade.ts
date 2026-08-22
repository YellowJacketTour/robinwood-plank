/**
 * Tensor Solana TRADING adapter -- magiceden-solana-trade.ts's sibling,
 * covering the second (and only other) real Solana NFT marketplace this
 * app trades on. Where the Magic Eden adapter calls a hosted REST API that
 * builds instructions server-side, Tensor ships no such REST layer for
 * this: instead it publishes its own on-chain program IDL as real,
 * installable npm packages -- @tensor-foundation/marketplace@1.0.0 and
 * @tensor-foundation/whitelist@1.0.0 (both Apache-2.0, both verified real
 * via `npm view` during this pass, 2026-08-19) -- so this file builds
 * instructions locally using Tensor's own generated (codama) instruction
 * builders, rather than calling a Tensor-hosted endpoint.
 *
 * CONSTRUCT-ONLY -- THE SAME BOUNDARY AS EVERY OTHER TRADE ADAPTER IN THIS
 * CODEBASE (magiceden-solana-trade.ts, foreign-fulfill.ts's Across/deBridge
 * quote functions)
 * ---------------------------------------------------------------------------
 * Nothing in this file ever signs or broadcasts a transaction. Every
 * exported function returns a base64-encoded, UNSIGNED (or, for whitelist
 * creation, only partially self-signed by a disposable in-memory keypair
 * that never leaves this process and never holds funds -- see
 * buildCreateWhitelistTx's own comment) serialized transaction for the
 * CLIENT wallet to sign and submit. This module never calls
 * sendTransaction, sendAndConfirmTransaction, or anything that reaches a
 * Solana RPC's write path. It also never touches
 * @tensor-foundation/escrow (the shared-margin-account program) --
 * every bid built here takes the safe per-bid-PDA-escrow path, matching
 * the explicit scope boundary this task was given.
 *
 * WHY A SEPARATE @solana/web3.js MAJOR VERSION LIVES INSIDE THIS ONE FILE
 * ---------------------------------------------------------------------------
 * @tensor-foundation/marketplace and @tensor-foundation/whitelist are
 * generated against @solana/web3.js@^2.0.0 (an entirely different, mutually
 * incompatible API from the v1 (^1.98.4) this repo's other 10 chains'
 * tooling already depends on). Rather than upgrading the whole repo (which
 * would break every other Solana call site) or letting npm silently
 * resolve two conflicting copies under the same import specifier, package.json
 * pins the v2 copy under an explicit alias -- "solana-web3js-v2":
 * "npm:@solana/web3.js@2.0.0" -- so this file's `import ... from
 * "solana-web3js-v2"` is unambiguous and every other file's plain
 * `@solana/web3.js` import keeps resolving to v1, untouched. Per this
 * task's own instructions, no v2-specific object is exported past this
 * file's boundary -- every exported function returns a plain string
 * (a base64 transaction, or a base58 address/PDA string), exactly as
 * version-agnostic as the Buffer/base64 strings magiceden-solana-trade.ts
 * returns.
 *
 * REAL SOURCE VERIFIED THIS SESSION (not guessed) -- see this file's
 * accompanying task prompt for the exact primary-source claims already
 * confirmed: whitelist creation (create_whitelist_v2) is permissionless,
 * PDA seeds ["whitelist", namespace, uuid], VOC/FVC modes need no external
 * proof (unlike MerkleTree mode, which this file does not implement);
 * bid's shared_escrow account, passed the owner's own throwaway pubkey
 * here, takes the safe per-bid-PDA-escrow path rather than the shared
 * margin-account program; currency MUST be omitted (the real on-chain
 * program source has `require!(currency.is_none(), TcompError::
 * CurrencyNotYetEnabled)` -- passing anything else fails on-chain, not
 * just in this wrapper); cancel_bid refunds both escrowed lamports and
 * rent to the owner, self-serve, no dependency on any Tensor backend.
 *
 * REAL, DISCLOSED RISK -- NOT HIDDEN
 * ---------------------------------------------------------------------------
 * This file was written against the real generated TypeScript types shipped
 * inside node_modules/@tensor-foundation/{marketplace,whitelist}/dist --
 * read directly during this pass, not guessed from docs -- but has NOT been
 * exercised end-to-end against a funded mainnet wallet (construct-only
 * scope, by design). A throwaway verification script proved these
 * functions run and return non-empty serialized transactions without
 * throwing; it did not prove a signed, broadcast transaction succeeds
 * on-chain. Treat this the same as magiceden-solana-trade.ts's own
 * "verified the shape, not proved end-to-end" disclosure.
 */

import {
  address,
  appendTransactionMessageInstruction,
  blockhash,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  partiallySignTransactionMessageWithSigners,
  type Address,
  type IInstruction,
  type TransactionSigner,
} from "solana-web3js-v2";
import {
  Mode,
  findWhitelistV2Pda,
  getCreateWhitelistV2InstructionAsync,
} from "@tensor-foundation/whitelist";
import {
  Target,
  getBidInstructionAsync,
  getCancelBidInstructionAsync,
} from "@tensor-foundation/marketplace";

/** Tensor's bids/cancels never actually need a live blockhash to be constructed and serialized as an unsigned message -- same "construct, don't broadcast" boundary as the rest of this file. A fixed placeholder is deliberately NOT a real recent blockhash; the signing wallet's own client library (wallet-adapter, Sage, etc.) re-simulates/re-blockhashes before the human signs, exactly like every other unsigned-tx adapter in this codebase hands off a transaction that still needs a fresh blockhash from the client side. */
const PLACEHOLDER_BLOCKHASH = {
  blockhash: blockhash("11111111111111111111111111111111"),
  lastValidBlockHeight: 0n,
};

/** Maximum expiry Tensor's own bid.rs accepts (365 days in seconds) -- passing more than this fails on-chain, not just in this wrapper. */
const MAX_EXPIRE_IN_SEC = 31_536_000;

async function serializeUnsigned(feePayer: TransactionSigner, instruction: IInstruction): Promise<string> {
  // IMPORTANT: `feePayer` must be the SAME signer instance used to build
  // `instruction` (e.g. the `owner` account inside a bid/cancel
  // instruction) -- @solana/signers' deduplication rejects two distinct
  // no-op signer objects for the same address, even though they carry
  // identical (empty) signatures. Callers must pass the one signer they
  // already used, not a freshly created one for the same address.
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(PLACEHOLDER_BLOCKHASH, m),
    (m) => appendTransactionMessageInstruction(instruction, m)
  );
  // partiallySignTransactionMessageWithSigners (not
  // signTransactionMessageWithSigners, which asserts full signing) with a
  // no-op fee-payer signer produces a correctly compiled, correctly
  // serialized transaction message with an EMPTY signature slot for the
  // fee payer -- this is what getBase64EncodedWireTransaction expects to
  // encode, and it is what the connected wallet's own signer replaces.
  // Nothing here holds or uses a real private key.
  const signed = await partiallySignTransactionMessageWithSigners(message);
  return getBase64EncodedWireTransaction(signed);
}

/**
 * Derives a Tensor whitelist PDA from a namespace pubkey (base58 string)
 * and a UUID. Pure derivation, no network call -- mirrors
 * findWhitelistV2Pda's real seeds, `["whitelist", namespace, uuid]`,
 * confirmed directly from the installed package's own generated
 * whitelistV2.d.ts.
 */
export async function deriveTensorWhitelistPda(
  namespace: string,
  uuidBytes: Uint8Array
): Promise<string> {
  const [pda] = await findWhitelistV2Pda({
    namespace: address(namespace),
    uuid: uuidBytes,
  });
  return pda;
}

/**
 * Builds a base64-encoded, UNSIGNED transaction that creates a new
 * VOC-mode Tensor whitelist scoped to a real Metaplex Collection mint --
 * "VOC" (verified-on-chain / Metaplex Certified Collection) checks
 * directly against the NFT's own on-chain Metadata account, no external
 * Merkle proof needed, per this task's own verified research.
 *
 * The `namespace` account the whitelist PDA is seeded from must itself be
 * a TransactionSigner on Tensor's real create_whitelist_v2 instruction
 * (confirmed from createWhitelistV2.d.ts's CreateWhitelistV2AsyncInput
 * type) -- this app holds no Solana keypair of its own for the caller's
 * funds, but a namespace signer here carries no funds and authorizes
 * nothing beyond "this PDA may exist under this seed", the same class of
 * disposable, funds-free co-signer as a fresh mint keypair signing its own
 * token-creation transaction. It is generated fresh, in-memory, per call,
 * used only to partially sign this one transaction, and then discarded --
 * it is never persisted, never reused, and never capable of moving the
 * caller's SOL. `ownerPubkey` (the real connected wallet) remains the
 * payer and update authority, and is the ONLY signature this transaction
 * still needs before it can be submitted.
 */
export async function buildCreateWhitelistTx(input: {
  collectionMintAddress: string;
  ownerPubkey: string;
}): Promise<{ tx: string; whitelistPda: string; uuid: string }> {
  const owner = address(input.ownerPubkey);
  const collectionMint = address(input.collectionMintAddress);

  // Disposable namespace signer -- see doc-comment above. Holds no funds,
  // authorizes nothing but this PDA's seed, discarded after this call.
  const namespaceSigner = await generateKeyPairSigner();
  const ownerNoopSigner: TransactionSigner = createNoopSigner(owner);

  const uuidBytes = crypto.getRandomValues(new Uint8Array(16));

  const instruction = await getCreateWhitelistV2InstructionAsync({
    payer: ownerNoopSigner,
    updateAuthority: ownerNoopSigner,
    namespace: namespaceSigner,
    uuid: uuidBytes,
    freezeAuthority: null,
    conditions: [{ mode: Mode.VOC, value: collectionMint }],
  });

  const [whitelistPda] = await findWhitelistV2Pda({
    namespace: namespaceSigner.address,
    uuid: uuidBytes,
  });

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(ownerNoopSigner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(PLACEHOLDER_BLOCKHASH, m),
    (m) => appendTransactionMessageInstruction(instruction, m)
  );
  // The namespace signer DOES sign here for real (it is a real in-memory
  // keypair, not a no-op) -- that is the one signature this transaction
  // can already carry, since only this process knows that ephemeral key.
  // The owner's signature slot stays empty (createNoopSigner) for the
  // connected wallet to fill client-side.
  const partiallySigned = await partiallySignTransactionMessageWithSigners(message);

  return {
    tx: getBase64EncodedWireTransaction(partiallySigned),
    whitelistPda,
    uuid: Buffer.from(uuidBytes).toString("hex"),
  };
}

/**
 * Builds a base64-encoded, UNSIGNED transaction placing a real,
 * collection-wide Tensor bid via the safe per-bid-PDA-escrow path
 * (shared_escrow is deliberately set to the bidder's own pubkey, NOT a
 * shared margin account -- @tensor-foundation/escrow is out of scope and
 * untouched by this file). `target`/`targetId` are fixed to
 * Target.Whitelist against the given whitelist PDA -- collection-wide only,
 * per this task's scope (no Field.Name scoping implemented). `currency` is
 * always omitted/None: the real bid.rs source rejects anything else
 * (`TcompError::CurrencyNotYetEnabled`). `cosigner` is always omitted --
 * bid.rs's own verbatim comment warns against ever setting it to the
 * owner's own signer key ("otherwise on editing bids a trait bid will be
 * made a normal bid"), so this implementation never sets it at all.
 *
 * Returns the generated `bidId` (a real Solana address-shaped identifier,
 * NOT a keypair -- no private key is associated with it) alongside the
 * transaction so the caller can persist it for a later buildTensorCancelBidTx
 * call, since Tensor's bid_state PDA is seeded from (owner, bidId).
 */
export async function buildTensorCollectionBidTx(input: {
  whitelistPda: string;
  bidderPubkey: string;
  amountLamports: string;
  quantity: number;
  expireInSec?: number;
}): Promise<{ tx: string; bidId: string }> {
  if (input.expireInSec !== undefined && input.expireInSec > MAX_EXPIRE_IN_SEC) {
    throw new Error(
      `tensor-solana-trade: expireInSec (${input.expireInSec}) exceeds Tensor's real on-chain cap of ${MAX_EXPIRE_IN_SEC} seconds (365 days) -- bid.rs rejects anything larger.`
    );
  }

  const owner = address(input.bidderPubkey);
  const whitelist = address(input.whitelistPda);
  const ownerNoopSigner: TransactionSigner = createNoopSigner(owner);

  // bidId is a real address-shaped identifier used only to derive the
  // bid_state PDA -- generated here (rather than left to the package's
  // own async default resolver) so the caller gets it back and can record
  // it for cancellation later.
  const bidIdSigner = await generateKeyPairSigner();
  const bidId = bidIdSigner.address;

  const instruction = await getBidInstructionAsync({
    owner: ownerNoopSigner,
    // Per-bid-PDA-escrow path, NOT the shared margin account program --
    // passing the owner's own pubkey here is the documented way to opt out
    // of @tensor-foundation/escrow, which this file never imports or calls.
    sharedEscrow: owner,
    rentPayer: ownerNoopSigner,
    bidId,
    target: Target.Whitelist,
    targetId: whitelist,
    field: null,
    fieldId: null,
    amount: BigInt(input.amountLamports),
    quantity: input.quantity,
    expireInSec: input.expireInSec !== undefined ? BigInt(input.expireInSec) : null,
    currency: null,
    privateTaker: null,
    // makerBroker intentionally omitted (left None): this app's
    // SOLANA_FEE_RECIPIENT (lib/constants.ts) is used as Magic Eden's
    // buyerReferral field in the sibling adapter, a documented Magic Eden
    // concept with no confirmed equivalent semantics on Tensor's real
    // maker_broker account in the source read this session -- passing it
    // here without verifying Tensor's own broker registration/fee-split
    // requirements would be a guess, not a verified claim, so it is left
    // unset rather than assumed.
  });

  const tx = await serializeUnsigned(ownerNoopSigner, instruction);
  return { tx, bidId };
}

/**
 * Builds a base64-encoded, UNSIGNED transaction cancelling a Tensor bid and
 * recovering both the escrowed lamports and the rent -- self-serve, no
 * dependency on any Tensor backend (cancel_bid.rs). `rentDestination` is
 * set to the same owner pubkey that placed the bid, matching this file's
 * own buildTensorCollectionBidTx (which always sets rentPayer = owner) --
 * cancel_bid.rs requires rent_destination to equal the bid's own recorded
 * rent_payer exactly, so these two functions must stay in lockstep.
 */
export async function buildTensorCancelBidTx(input: {
  bidderPubkey: string;
  bidId: string;
}): Promise<{ tx: string }> {
  const owner = address(input.bidderPubkey);
  const ownerNoopSigner: TransactionSigner = createNoopSigner(owner);

  const instruction = await getCancelBidInstructionAsync({
    owner: ownerNoopSigner,
    rentDestination: owner,
    bidId: address(input.bidId),
  });

  const tx = await serializeUnsigned(ownerNoopSigner, instruction);
  return { tx };
}
