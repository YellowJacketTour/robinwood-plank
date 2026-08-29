import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

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
  const { postgresPool, postgresQuery, withPostgresTransaction } = await import("../lib/postgres");

  const suffix = `${Date.now()}-${process.pid}`;
  const valueKey = `plank:market:integration:value:${suffix}`;
  const hashKey = `plank:market:integration:hash:${suffix}`;
  const setKey = `plank:market:integration:set:${suffix}`;
  const listingId = `listing-integration-${suffix}`;
  const servedHash = `0x${"a".repeat(60)}${(process.pid % 65_536)
    .toString(16)
    .padStart(4, "0")}`;
  const wallet = `0x${"b".repeat(40)}`;
  const playtestUserId = randomUUID();
  const playtestRoomId = randomUUID();
  const playtestUsername = `postgres-room-${suffix}`;
  const playtestInviteHash = `${"c".repeat(56)}${(process.pid % 0xffff_ffff)
    .toString(16)
    .padStart(8, "0")}`;
  const roomAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const playtestJoinCode = [...randomBytes(8)]
    .map((byte) => roomAlphabet[byte % roomAlphabet.length])
    .join("");

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

    // Exercise the exact PostgreSQL boundary used when an authenticated host
    // creates a private PlankCrash room.  The availability transaction and
    // its non-economic audit marker are intentionally separate: a transient
    // event append failure must not roll back a valid room and membership.
    await postgresQuery(
      `INSERT INTO playtest_users
         (id,display_name,username_key,invite_hash,is_admin,pin_salt,pin_hash)
       VALUES ($1,$2,$3,$4,TRUE,'integration','integration')`,
      [playtestUserId, "Postgres room verifier", playtestUsername, playtestInviteHash]
    );
    await withPostgresTransaction(async (client) => {
      await client.query(
        `INSERT INTO playtest_rooms
           (id,join_code,name,owner_user_id,rules_hash,policy,simulation_state,version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1)`,
        [
          playtestRoomId,
          playtestJoinCode,
          "Private room integration",
          playtestUserId,
          "d".repeat(64),
          JSON.stringify({ minPlayers: 1 }),
          JSON.stringify({ vault: "1000000" }),
        ]
      );
      await client.query(
        "INSERT INTO playtest_room_members (room_id,user_id) VALUES ($1,$2)",
        [playtestRoomId, playtestUserId]
      );
    });
    await postgresQuery(
      `INSERT INTO playtest_room_events
         (room_id,room_version,round_id,event_type,actor_user_id,public_payload)
       VALUES ($1,1,0,'room.created',$2,$3)`,
      [playtestRoomId, playtestUserId, JSON.stringify({ joinCode: playtestJoinCode })]
    );
    const playtestRoom = await postgresQuery<{
      member_count: string;
      event_count: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM playtest_room_members WHERE room_id=r.id) member_count,
         (SELECT COUNT(*)::text FROM playtest_room_events WHERE room_id=r.id) event_count
       FROM playtest_rooms r WHERE r.id=$1`,
      [playtestRoomId]
    );
    assert.deepEqual(playtestRoom.rows[0], { member_count: "1", event_count: "1" });

    console.log(
      "[postgres-verify] durable KV, orders, attribution, Boards, and private room creation passed"
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
      postgresQuery("DELETE FROM playtest_rooms WHERE id = $1", [
        playtestRoomId,
      ]),
    ]);
    await postgresQuery("DELETE FROM playtest_users WHERE id = $1", [
      playtestUserId,
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
