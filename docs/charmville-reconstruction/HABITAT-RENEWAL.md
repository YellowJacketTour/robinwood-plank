# Current habitat renewal policy

The authored starter habitat uses a 60-second server cooldown after defeat or capture and at most12 spawns per server-timed one-hour budget window, including the initial creature. Unused windows never accumulate credits. A read after a long absence creates at most one fresh creature. This is Charmville pacing policy, not an Emerald habitat rule.

Migrations126 and127 preserve the existing unique `region_id` routing slot. Terminal rows move to `archive:<UUID>` only when a successor is admitted. Their immutable `origin_region_id` preserves original world provenance. HP, IVs, UUIDs, receipts, captured ownership and defeat awards remain intact. New creatures receive new UUIDs; no old creature is healed or revived by renewal.

`habitat` in encounter responses supplies serverNow, nextSpawnAt, spawnCount, spawnLimit, windowSeconds and cooldownSeconds. Clients display the deadline and continue polling. Release/claim cannot reset terminal time or replenish the budget. Concurrent reads serialize on the habitat lock and create one successor.

Old capture request IDs return their original receipts. Old battle requests can reject after world state changes; they cannot award XP twice. The supported species remains the authored Poochyena placement. Population ecology, distributed spawns, capture-ball replenishment and broader habitat variety remain separate work.
