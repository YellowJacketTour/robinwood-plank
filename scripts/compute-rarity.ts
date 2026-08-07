/**
 * Batch job: build the discovery trait index (collection_token_traits),
 * facet counts (collection_trait_facet_counts), and OpenRarity-style rarity
 * scores (collection_token_rarity) for every registered collection.
 *
 * Run: `tsx scripts/compute-rarity.ts` (or `npm run discover:compute-rarity`).
 *
 * This is a batch job on purpose — the discovery search API
 * (app/api/discover/route.ts) only ever READS these tables; scores are never
 * computed per request. Re-run this after metadata changes (new collection,
 * reveal, etc.) — like scripts/refresh-market-data.ts, it is idempotent and
 * safe to re-run (each collection's rows are fully replaced in one
 * transaction).
 */
import { hasPostgresConfig, withPostgresTransaction } from "../lib/postgres";
import { MARKET_COLLECTIONS } from "../lib/market/collections";
import { getRobinwoodMetadataMap, ROBINWOOD_SUPPLY } from "../lib/market/robinwood-metadata";
import { pickCanonicalTraits } from "../lib/rarity";
import {
  computeTokenRarityScores,
  computeFacetCounts,
  type TokenTraits,
} from "../lib/market/rarity-score";

async function tokensForCollection(slug: string, contractAddress: string): Promise<{
  tokens: TokenTraits[];
  totalTokens: number;
}> {
  // RobinWood has a canonical Postgres-backed metadata store (migration 004);
  // every other registered collection has no metadata store of its own yet
  // (see lib/market/collections.ts) and is skipped here rather than guessed.
  const isRobinwood = contractAddress.toLowerCase() === MARKET_COLLECTIONS[0]?.contractAddress.toLowerCase();
  if (!isRobinwood) return { tokens: [], totalTokens: 0 };

  const metadata = await getRobinwoodMetadataMap();
  const tokens: TokenTraits[] = [];
  for (const [tokenId, entry] of metadata) {
    const canonical = pickCanonicalTraits(entry.attributes);
    if (canonical.length === 0) continue;
    tokens.push({
      tokenId,
      traits: canonical.map((t) => ({ traitType: t.trait, traitValue: t.value })),
    });
  }
  return { tokens, totalTokens: ROBINWOOD_SUPPLY };
}

async function computeForCollection(slug: string, contractAddress: string): Promise<void> {
  const { tokens, totalTokens } = await tokensForCollection(slug, contractAddress);
  if (tokens.length === 0) {
    console.log(`[compute-rarity] ${slug}: no traits available, skipping`);
    return;
  }

  const facets = computeFacetCounts(tokens);
  const scores = computeTokenRarityScores(tokens, totalTokens);
  const scoreByTokenId = new Map(scores.map((s) => [s.tokenId, s]));

  await withPostgresTransaction(async (client) => {
    await client.query(`DELETE FROM collection_token_traits WHERE collection = $1`, [slug]);
    await client.query(`DELETE FROM collection_trait_facet_counts WHERE collection = $1`, [slug]);
    await client.query(`DELETE FROM collection_token_rarity WHERE collection = $1`, [slug]);

    for (const token of tokens) {
      for (const { traitType, traitValue } of token.traits) {
        await client.query(
          `INSERT INTO collection_token_traits (collection, token_id, trait_type, trait_value)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (collection, token_id, trait_type) DO UPDATE SET trait_value = EXCLUDED.trait_value`,
          [slug, token.tokenId, traitType, traitValue]
        );
      }
      const score = scoreByTokenId.get(token.tokenId);
      if (score) {
        await client.query(
          `INSERT INTO collection_token_rarity (collection, token_id, score, rank, trait_count)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (collection, token_id) DO UPDATE
             SET score = EXCLUDED.score, rank = EXCLUDED.rank, trait_count = EXCLUDED.trait_count, computed_at = NOW()`,
          [slug, token.tokenId, score.score, score.rank, score.traitCount]
        );
      }
    }

    for (const [traitType, byValue] of facets) {
      for (const [traitValue, count] of byValue) {
        await client.query(
          `INSERT INTO collection_trait_facet_counts (collection, trait_type, trait_value, token_count, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (collection, trait_type, trait_value) DO UPDATE
             SET token_count = EXCLUDED.token_count, updated_at = NOW()`,
          [slug, traitType, traitValue, count]
        );
      }
    }
  });

  console.log(
    `[compute-rarity] ${slug}: indexed ${tokens.length} tokens, ${facets.size} trait types, ranks 1..${scores.length}`
  );
}

async function main(): Promise<void> {
  if (!hasPostgresConfig()) {
    console.error("[compute-rarity] Postgres is not configured (PGHOST/PGDATABASE/PGUSER/PGPASSWORD). Aborting.");
    process.exitCode = 1;
    return;
  }
  for (const collection of MARKET_COLLECTIONS) {
    await computeForCollection(collection.slug, collection.contractAddress);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[compute-rarity] failed:", error);
    process.exit(1);
  });
