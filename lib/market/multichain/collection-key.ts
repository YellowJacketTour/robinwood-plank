import { isNonEvmChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";

/**
 * One collection identity, for every chain.
 *
 * THE BUG THIS PREVENTS, WHICH THIS CODEBASE HAS ALREADY PAID FOR ONCE
 * -------------------------------------------------------------------
 * store.ts's own header records it, dated 2026-08-20:
 *
 *   "every write path here unconditionally lowercased contractAddress...
 *    That's correct for EVM hex addresses but WRONG for Solana pubkeys and
 *    Bitcoin Ordinals slugs -- Solana's base58 addresses are case-sensitive,
 *    so lowercasing one turns it into a different, almost always invalid
 *    pubkey. Confirmed live: every 'solana-mainnet' row registered before
 *    this fix had a corrupted, unresolvable address (getAsset returning a
 *    real 'Pubkey Validation Err') -- not a rare edge case, effectively all
 *    of them."
 *
 * That fix landed in `normalizeContractAddress`, and it is correct. But it is
 * PRIVATE to store.ts, so nothing stopped the rule being re-derived elsewhere
 * -- and it was, about twenty-five times, each an inline
 * `${chainSlug}:${contract.toLowerCase()}` that unconditionally lowercases and
 * therefore reintroduces exactly the bug store.ts already paid for.
 *
 * Two further private copies of a SECOND, subtly different rule exist in
 * archival-ledger.ts and collection-demand.ts, both byte-identical:
 *
 *   /^0x[0-9a-f]{40}$/i.test(key) ? key.toLowerCase() : key
 *
 * That one keys off the SHAPE of the value (is it 40 hex?) rather than the
 * chain. It happens to be safe, but it disagrees with store.ts on any EVM
 * address that is not exactly 40 hex characters, and two rules that agree by
 * luck are one refactor away from disagreeing in production.
 *
 * WHY IT IS A DATA BUG AND NOT A STYLE NIT
 * ----------------------------------------
 * A corrupted key does not throw. It produces a cache miss, an empty lookup,
 * a row that never joins -- work that silently accomplishes nothing while
 * every log line stays green. It is the same failure species as everything
 * else found in this codebase: a miss indistinguishable from "nothing
 * happened".
 *
 * THE RULE
 * --------
 * The CHAIN decides, never the shape of the string. EVM addresses are
 * case-insensitive and are lowercased so a checksummed input matches a
 * lowercase row. Every non-EVM chain preserves the exact bytes it was given,
 * because on those chains case IS identity.
 */

/**
 * The canonical form of a contract address or collection id on a chain.
 *
 * Mirrors store.ts's `normalizeContractAddress` exactly -- deliberately, so
 * that a key built here always matches a row written there. If these two ever
 * disagree, lookups silently miss.
 */
export function normalizeContractAddress(chainSlug: string, contractAddress: string): string {
  return isNonEvmChainSlug(chainSlug) ? contractAddress : contractAddress.toLowerCase();
}

/**
 * The composite key `chain:contract`, normalised per chain.
 *
 * Replaces the ~25 hand-rolled `${chainSlug}:${contract.toLowerCase()}`
 * literals, every one of which corrupts a Solana or Bitcoin identifier.
 */
export function collectionKey(chainSlug: string, contractAddress: string): string {
  return `${chainSlug}:${normalizeContractAddress(chainSlug, contractAddress)}`;
}

/**
 * Do two references point at the same collection?
 *
 * Comparing raw strings is what makes a checksummed address miss a lowercase
 * row; comparing lowercased strings is what makes two different Solana mints
 * look identical. Both mistakes are avoided by normalising each side under
 * its own chain first.
 */
export function sameCollection(
  a: { chainSlug: string; contractAddress: string },
  b: { chainSlug: string; contractAddress: string },
): boolean {
  if (a.chainSlug !== b.chainSlug) return false;
  return (
    normalizeContractAddress(a.chainSlug, a.contractAddress) ===
    normalizeContractAddress(b.chainSlug, b.contractAddress)
  );
}
