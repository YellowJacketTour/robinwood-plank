import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";
import { subscribeLiveFeed, readLiveFeedStats, type LiveMarketEvent } from "../../lib/market/multichain/edge/live-feed";

/**
 * One Postgres tail fans out to every subscriber: two subscribers, one
 * real inserted event, both receive it, and the filtered subscriber does
 * not receive an event for another collection.
 */
test(
  "live feed: one tail, N subscribers, real rows only",
  { skip: !hasPostgresConfig() },
  async () => {
    const chainSlug = "zztest-live";
    const got: LiveMarketEvent[][] = [[], []];
    const detachAll = subscribeLiveFeed({ chainSlug }, (e) => got[0].push(e));
    const detachOne = subscribeLiveFeed({ chainSlug, collectionKey: "0xaaaa" }, (e) => got[1].push(e));
    try {
      // Let the tail find the tip first.
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(readLiveFeedStats().subscribers, 2);
      await postgresQuery(
        `INSERT INTO plank_market_events (chain_slug, chain_namespace, event_identity, venue_id, protocol, event_type, collection_key, token_id, tx_hash, event_index, sub_index)
         VALUES ($1, 'eip155', $1 || ':' || $2 || ':0:0', 'marketplank', 'seaport', 'sale', '0xaaaa', '1', $2, 0, 0), ($1, 'eip155', $1 || ':' || $3 || ':0:0', 'marketplank', 'seaport', 'transfer', '0xbbbb', '2', $3, 0, 0)`,
        [chainSlug, `0xzz${Date.now()}a`, `0xzz${Date.now()}b`]
      );
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && got[0].length < 2) await new Promise((r) => setTimeout(r, 200));
      assert.equal(got[0].length, 2, "unfiltered subscriber must receive both real events");
      assert.equal(got[1].length, 1, "collection-filtered subscriber receives only its own");
      assert.equal(got[1][0].collectionKey, "0xaaaa");
      assert.equal(got[1][0].eventType, "sale");
    } finally {
      detachAll();
      detachOne();
      await postgresQuery(`DELETE FROM plank_market_events WHERE chain_slug = $1`, [chainSlug]);
    }
  }
);
