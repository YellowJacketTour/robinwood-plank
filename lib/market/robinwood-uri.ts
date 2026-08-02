/**
 * The RobinWood metadata directory, and nothing else.
 *
 * Split out of token-image.ts so it stays importable from a CLIENT component.
 * token-image.ts resolves artwork and now consults the canonical metadata
 * table first, which reaches durable-kv and therefore `pg` — a Node-only
 * dependency. V3SwapView is a client component and imports robinwoodTokenUri,
 * so leaving the helper in that module dragged the Postgres driver into the
 * browser bundle and the build failed on `Can't resolve 'dns'`. Neither tsc
 * nor eslint sees that; only the bundler does.
 *
 * Keep this module free of server-only imports. It exists to be safe on both
 * sides of the boundary.
 */

/**
 * RobinWood collection metadata directory (tokenURI base). Every minted token
 * uses `ipfs://{cid}/{tokenId}` — confirmed on-chain for ids across the
 * supply. Hitting this directly skips eth_call entirely.
 *
 * Not taken on trust: verifyMetadataCid() in lib/market/robinwood-metadata.ts
 * reads a real on-chain tokenURI before any metadata rebuild and refuses to
 * proceed if this constant has gone stale.
 */
export const ROBINWOOD_METADATA_CID =
  "bafybeictcaptbfswgepv2icnuw5wdhfjvvamwlcoza2p4qw3zbq2hqd6b4";

export function robinwoodTokenUri(tokenId: string | number): string {
  return `ipfs://${ROBINWOOD_METADATA_CID}/${tokenId}`;
}
