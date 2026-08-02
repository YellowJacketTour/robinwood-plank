import assert from "node:assert/strict";

process.env.DURABLE_KV_BACKEND = "postgres";

async function main(): Promise<void> {
  const { durableKv } = await import("../lib/market/durable-kv");
  const {
    getListingRawOrder,
    getListings,
    putListing,
    removeListing,
  } = await import("../lib/market/orders-store");
  const {
    markOrderServed,
    wasOrderServedByUs,
  } = await import("../lib/market/served-orders");
  const {
    getBoardsState,
    recordWidgetActivity,
  } = await import("../lib/boards-store");
  const { postgresPool, postgresQuery } = await import("../lib/postgres");

  const suffix = `${Date.now()}-${process.pid}`;
  const valueKey = `plank:market:integration:value:${suffix}`;
  const hashKey = `plank:market:integration:hash:${suffix}`;
  const setKey = `plank:market:integration:set:${suffix}`;
  const listingId = `listing-integration-${suffix}`;
  const servedHash = `0x${"a".repeat(60)}${(process.pid % 65_536)
    .toString(16)
    .padStart(4, "0")}`;
  const wallet = `0x${"b".repeat(40)}`;

  const originalBoards = await postgresQuery<{ state: unknown }>(
    "SELECT state FROM boards_state WHERE singleton_id = 1"
  );

  try {
    await durableKv.set(valueKey, { ok: true, suffix }, { ex: 60 });
    assert.deepEqual(await durableKv.get(valueKey), { ok: true, suffix });

    await durableKv.hset(hashKey, {
      first: { priceWei: "42" },
      second: "plank",
    });
    assert.deepEqual(await durableKv.hget(hashKey, "first"), {
      priceWei: "42",
    });
    assert.deepEqual(await durableKv.hgetall(hashKey), {
      first: { priceWei: "42" },
      second: "plank",
    });

    assert.equal(await durableKv.sadd(setKey, suffix), 1);
    assert.equal(await durableKv.sadd(setKey, suffix), 0);
    assert.equal(await durableKv.sismember(setKey, suffix), 1);

    const rawOrder = {
      signature: "0xintegration",
      parameters: { counter: 0 },
    };
    await putListing(
      {
        id: listingId,
        collectionSlug: "integration",
        tokenId: "42",
        maker: wallet,
        priceWei: "4206900000000000",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        kind: "fixed",
      },
      rawOrder
    );
    const listings = await getListings("integration");
    assert.equal(listings.some((listing) => listing.id === listingId), true);
    assert.deepEqual(await getListingRawOrder(listingId), rawOrder);

    await markOrderServed(servedHash);
    assert.equal(await wasOrderServedByUs(servedHash), true);

    await recordWidgetActivity(wallet, "quote");
    const boards = await getBoardsState();
    assert.equal(boards.widgetSessions[wallet]?.quoteCount, 1);

    console.log(
      "[postgres-verify] durable KV, orders, attribution, and Boards passed"
    );
  } finally {
    await Promise.all([
      postgresQuery("DELETE FROM plank_kv_values WHERE key_name = $1", [
        valueKey,
      ]),
      postgresQuery("DELETE FROM plank_kv_hash_fields WHERE key_name = $1", [
        hashKey,
      ]),
      postgresQuery("DELETE FROM plank_kv_set_members WHERE key_name = $1", [
        setKey,
      ]),
      removeListing(listingId),
      postgresQuery("DELETE FROM served_order_hashes WHERE order_hash = $1", [
        servedHash,
      ]),
    ]);

    if (originalBoards.rows[0]) {
      await postgresQuery(
        `INSERT INTO boards_state (singleton_id, state, updated_at)
         VALUES (1, $1::jsonb, NOW())
         ON CONFLICT (singleton_id) DO UPDATE
           SET state = EXCLUDED.state, updated_at = NOW()`,
        [JSON.stringify(originalBoards.rows[0].state)]
      );
    } else {
      await postgresQuery("DELETE FROM boards_state WHERE singleton_id = 1");
    }
    await postgresPool().end();
  }
}

main().catch((error) => {
  console.error("[postgres-verify] failed:", error);
  process.exitCode = 1;
});
