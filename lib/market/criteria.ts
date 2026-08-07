import { keccak256, toBeHex, zeroPadValue } from "ethers";
// Deep import ON PURPOSE: this is the exact MerkleTree implementation
// seaport-js itself uses when it converts an `identifiers: [...]` input item
// into an ERC721_WITH_CRITERIA root at order-creation time
// (lib/utils/order.js → mapInputItemToOfferItem). Using the same class for
// root AND proof means the proof we hand the fulfiller is, by construction,
// against the same tree the signed order committed to. Do not hand-roll a
// tree here — a construction mismatch (leaf encoding, pair ordering) produces
// roots that Seaport's on-chain _verifyProof silently never accepts.
import { MerkleTree } from "@opensea/seaport-js/lib/utils/merkletree.js";

/**
 * Trait-scoped criteria bids ("bid on the floor of a trait").
 *
 * A Seaport ERC721_WITH_CRITERIA consideration item whose
 * `identifierOrCriteria` is NON-zero is a Merkle root over the set of token
 * ids the bid is willing to accept. At fulfillment the seller must supply a
 * CriteriaResolver naming the concrete token id plus a Merkle proof against
 * that root.
 *
 * SNAPSHOT SEMANTICS — decided and documented here: the token-id set is
 * SNAPSHOTTED AT BID-CREATION TIME. The root in the signed order is immutable,
 * so the proof at fulfillment MUST be computed against the exact same set;
 * re-querying "which tokens have trait X" later would break every proof the
 * moment the answer changed. The snapshot therefore travels WITH the offer
 * (Offer.criteriaTokenIds) and is itself verifiable: anyone can recompute the
 * root from the stored set and compare it to the signed order. Metadata for
 * this collection is immutable (revealed IPFS), so the set cannot rot —
 * membership at bid time and at fulfill time are the same question.
 *
 * Verification here is done twice, independently:
 *  - construction via seaport-js's own MerkleTree (same code path as signing);
 *  - `verifyCriteriaProof` re-implements Seaport 1.6's ON-CHAIN algorithm
 *    (CriteriaResolution._verifyProof): leaf = keccak256 of the token id as a
 *    single 32-byte word, then sorted-pair keccak up the branch. It shares no
 *    code with merkletreejs, so agreement between the two is meaningful.
 */

/** Hard cap on a criteria set. RobinWood's whole supply is 1,542; anything
 * far above that is malformed input, not a trait. */
export const MAX_CRITERIA_TOKEN_IDS = 4_000;

export class CriteriaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CriteriaError";
  }
}

/**
 * Validate + canonicalize a token-id set: decimal strings, deduped, sorted
 * numerically. Throws on anything malformed. Canonical form matters because
 * the stored snapshot is compared/recomputed by independent parties.
 */
export function normalizeTokenIds(tokenIds: readonly string[]): string[] {
  if (!Array.isArray(tokenIds) || tokenIds.length === 0) {
    throw new CriteriaError("Criteria token-id set is empty.");
  }
  if (tokenIds.length > MAX_CRITERIA_TOKEN_IDS) {
    throw new CriteriaError("Criteria token-id set is too large.");
  }
  const seen = new Set<string>();
  for (const id of tokenIds) {
    if (typeof id !== "string" || !/^\d{1,10}$/.test(id)) {
      throw new CriteriaError("Criteria token-id set contains an invalid id.");
    }
    seen.add(BigInt(id).toString());
  }
  return Array.from(seen).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
}

/**
 * Merkle root committing to `tokenIds`, exactly as seaport-js computes it
 * when signing an order built with `identifiers: tokenIds`. Returned as a
 * 0x-prefixed 32-byte hex string, lowercase.
 */
export function computeCriteriaRoot(tokenIds: readonly string[]): string {
  const ids = normalizeTokenIds(tokenIds);
  const root = new MerkleTree(ids).getRoot();
  if (typeof root !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(root)) {
    // A single-element tree still yields a 32-byte root (the leaf hash);
    // "0" only appears for an EMPTY tree, which normalizeTokenIds forbids.
    throw new CriteriaError("Criteria root computation failed.");
  }
  const rootBig = BigInt(root);
  if (rootBig === BigInt(0)) {
    // Root 0 is Seaport's "any id" wildcard — a trait bid must never
    // accidentally commit to it.
    throw new CriteriaError("Criteria root collapsed to the wildcard value.");
  }
  return root.toLowerCase();
}

/**
 * Merkle proof that `tokenId` belongs to the set committed by
 * `computeCriteriaRoot(tokenIds)`. Same tree implementation as the root, so
 * the pair is internally consistent by construction.
 */
export function computeCriteriaProof(
  tokenIds: readonly string[],
  tokenId: string
): string[] {
  const ids = normalizeTokenIds(tokenIds);
  const wanted = BigInt(tokenId).toString();
  if (!ids.includes(wanted)) {
    throw new CriteriaError("Token id is not in the criteria set.");
  }
  return new MerkleTree(ids).getProof(wanted);
}

/** Seaport's on-chain leaf: keccak256 of the identifier as one 32-byte word. */
function leafFor(tokenId: string): string {
  return keccak256(zeroPadValue(toBeHex(BigInt(tokenId)), 32));
}

/**
 * INDEPENDENT re-implementation of Seaport 1.6's on-chain proof verification
 * (CriteriaResolution._verifyProof): fold the proof over the leaf with
 * sorted-pair keccak256, compare to the root. Shares no code with
 * merkletreejs. Used as a cross-check in validation and tests; the definitive
 * proof lives in test/contracts/SeaportCriteriaFulfill.test.ts, which runs
 * the REAL deployed Seaport bytecode.
 */
export function verifyCriteriaProof(
  root: string,
  tokenId: string,
  proof: readonly string[]
): boolean {
  if (!/^0x[0-9a-fA-F]{64}$/.test(root)) return false;
  let computed = leafFor(tokenId);
  for (const element of proof) {
    if (typeof element !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(element)) {
      return false;
    }
    computed =
      BigInt(computed) <= BigInt(element)
        ? keccak256(computed + element.slice(2))
        : keccak256(element + computed.slice(2));
  }
  return BigInt(computed) === BigInt(root);
}
