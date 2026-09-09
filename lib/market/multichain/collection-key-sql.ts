import { SOLANA_CHAIN_SLUG, BITCOIN_CHAIN_SLUG } from "./trading/non-evm-chains";

/** For queries binding chain at $1 and collection at $2. Values stay bound;
 * only constants from the chain registry are embedded in the predicate. */
export const COLLECTION_MATCH_SQL = `(
  ($1 IN ('${SOLANA_CHAIN_SLUG}', '${BITCOIN_CHAIN_SLUG}') AND collection_slug = $2)
  OR ($1 NOT IN ('${SOLANA_CHAIN_SLUG}', '${BITCOIN_CHAIN_SLUG}') AND lower(collection_slug) = lower($2))
)`;
