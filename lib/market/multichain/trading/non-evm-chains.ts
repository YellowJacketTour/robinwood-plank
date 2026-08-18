/**
 * Chain-family recognition for the two non-EVM chains this app trades on --
 * Solana (Magic Eden) and Bitcoin Ordinals (UniSat). Deliberately a SEPARATE,
 * tiny registry from foreign-chain-registry.ts's FOREIGN_CHAINS, mirroring
 * exactly how Robinhood Chain gets its own "chainSlug === 'robinhood'"
 * branches throughout the multichain routes/components instead of being
 * added to that EVM-typed array (see that file's own header: FOREIGN_CHAINS
 * is `ForeignChainConfig[]`, which carries an EVM `chainId` every non-EVM
 * chain genuinely lacks -- Solana has no chainId, and Bitcoin's own "chain
 * id" concept doesn't map onto Seaport/ethers machinery at all). Adding
 * "solana"/"bitcoin" to that array would either fabricate a meaningless
 * chainId or force the type to become partial everywhere it's consumed;
 * a parallel branch is the same pattern this codebase already chose once.
 *
 * chainSlug VALUES REUSED, NOT INVENTED -- CORRECTED 2026-08-18: an earlier
 * pass here used bare "solana" because that literal appears in
 * GlobalMarketHub.tsx's ALL_CHAIN_SLUGS_ORDER array. That array is ONLY a
 * client-side sort-order lookup (`ALL_CHAIN_SLUGS_ORDER.indexOf(...)`), not
 * the real per-row chainSlug -- every actual TrackedCollection row's
 * chainSlug comes straight from the DB (plank_multichain_collections,
 * app/api/market/multichain/route.ts's `chainSlug: c.chainSlug`), which
 * scripts/seed-multichain-collections.ts and
 * scripts/discover-multichain-collections.ts both populate as
 * "solana-mainnet" (confirmed by reading both scripts directly), matching
 * foreign-chain-registry.ts's own chainDisplayName/chainBrandColor/
 * chainGlyph maps, which already key on "solana-mainnet" too. The bare
 * "solana" value was a real bug: every card's real link
 * (`/market/multichain/solana-mainnet/{symbol}`) would never have matched
 * this file's old "solana" branches at all. "bitcoin-mainnet" has no prior
 * art anywhere in this codebase (Bitcoin Ordinals were never previously
 * tracked) -- chosen to match the "-mainnet" suffix convention every real
 * chainSlug in this codebase already uses (eth-mainnet, avax-mainnet,
 * solana-mainnet, ...), for consistency, since a bare "bitcoin" would be the
 * only chainSlug in the whole app breaking that pattern.
 */

export const SOLANA_CHAIN_SLUG = "solana-mainnet";
export const BITCOIN_CHAIN_SLUG = "bitcoin-mainnet";

export function isSolanaChainSlug(chainSlug: string): boolean {
  return chainSlug === SOLANA_CHAIN_SLUG;
}

export function isBitcoinChainSlug(chainSlug: string): boolean {
  return chainSlug === BITCOIN_CHAIN_SLUG;
}

/** True for either non-EVM chain family this app trades on -- the single question most branches actually need ("is this an ethers/Seaport chain or not"). */
export function isNonEvmChainSlug(chainSlug: string): boolean {
  return isSolanaChainSlug(chainSlug) || isBitcoinChainSlug(chainSlug);
}
