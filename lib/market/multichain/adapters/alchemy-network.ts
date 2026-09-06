import { deriveAlchemySubdomains } from "@/lib/market/multichain/chains/manifest";
/**
 * Client-safe Alchemy network constants, split out of alchemy-nft.ts.
 *
 * REAL BUG THIS FIXES: alchemy-nft.ts is reachable from CLIENT code via
 * foreign-chain-registry.ts -> lib/wallet.ts -> lib/wallet-context.tsx ->
 * app/layout.tsx. As long as ANY code in alchemy-nft.ts's module graph
 * imports control-plane.ts (which pulls in lib/postgres.ts's real `pg`
 * client -- Node-only, uses `tls`/`util/types`), the whole file becomes
 * unbundleable for the browser -- even a DYNAMIC `import()` inside a
 * function doesn't help, because webpack/Turbopack still needs the
 * dynamically-imported module to be resolvable for whichever build target
 * (client vs. server) can reach it, and alchemy-nft.ts is reachable from
 * both. Confirmed live 2026-08-23: real "Module not found: Can't resolve
 * 'tls'/'util/types'" errors, real 500 on every page render.
 *
 * The actual fix: foreign-chain-registry.ts only ever needed two pure,
 * dependency-free exports from alchemy-nft.ts (ALCHEMY_NETWORK_SUBDOMAIN,
 * apiKey) -- never anything server-only. Moving those two into their own
 * file with zero imports permanently severs the client-reachable chain
 * from ever touching alchemy-nft.ts's control-plane-dependent code, no
 * matter what else changes inside alchemy-nft.ts in the future.
 */

/**
 * Alchemy's network subdomain per chainSlug. This is the ONE place that
 * needs a new line when Alchemy adds NFT API support for another chain --
 * everything else in the adapter is chain-agnostic.
 */
// DERIVED from lib/market/multichain/chains/manifest.ts (alchemySubdomain).
export const ALCHEMY_NETWORK_SUBDOMAIN: Record<string, string> = deriveAlchemySubdomains();

/** Real Alchemy API key, falling back to Alchemy's own shared "demo" key (heavily rate-limited, fine for proving an adapter works, never a production credential). */
export function apiKey(): string {
  return process.env.ALCHEMY_API_KEY?.trim() || "demo";
}
