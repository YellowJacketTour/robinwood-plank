/**
 * The akasha hose, as a deployable worker.
 *
 * Every other always-on process on this host runs as a pre-built esbuild
 * bundle (mesh-tick-standalone.mjs, opensea-stream-standalone.mjs, ...), and
 * `packages/akasha` is not copied into the release tree at all. So the hose
 * needs the same shape as its siblings or it simply cannot run in production,
 * however complete the package is.
 *
 * WHAT THIS PROCESS OWNS
 * ----------------------
 * The akasha_* tables, and nothing else. It never writes plank_*. That
 * separation is the whole reason a cutover is safe to stage: this can run
 * beside the existing mesh for as long as you like, because the two write
 * disjoint tables. The catalog pagers only stop when someone sets
 * AKASHA_HOSE_OWNS_BITCOIN=1, which is a separate, deliberate act.
 *
 * REQUIRED
 *   PGHOST / PGDATABASE / PGUSER / PGPASSWORD  (or DATABASE_URL)
 *   AKASHA_CHAINS=bitcoin                      (one family at a time)
 *
 * The process REFUSES to start without a database. An in-memory tape forgets
 * on restart, which is not an archive -- and a hose that appears to run while
 * persisting nothing is exactly the "reports finished, missed everything"
 * failure this whole program exists to remove.
 */
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { Hose } from "../packages/akasha/src/hose/main";
import type { SqlClient } from "../packages/akasha/src/hose/pg-store";
import type { ChainId } from "../packages/akasha/src/shared/types";
import type { Hex } from "../packages/akasha/src/shared/hex";

const TICK_MS = Number(process.env.AKASHA_TICK_MS ?? 15_000);
const HEALTH_MS = Number(process.env.AKASHA_HEALTH_MS ?? 60_000);

function makePool(): Pool | null {
  if (process.env.DATABASE_URL) {
    return new Pool({ connectionString: process.env.DATABASE_URL, max: 2, application_name: "akasha-hose" });
  }
  if (!process.env.PGHOST) return null;
  return new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    // Two connections. This host runs a shared cPanel Postgres with a real
    // connection ceiling that the web role and the mesh already share; a
    // background archiver must not be the thing that exhausts it.
    max: 2,
    application_name: "akasha-hose",
  });
}

async function main(): Promise<void> {
  const chains = (process.env.AKASHA_CHAINS ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean) as ChainId[];

  if (chains.length === 0) {
    console.error("[akasha-hose] AKASHA_CHAINS is empty -- refusing to start with nothing to own.");
    process.exit(2);
  }

  const pool = makePool();
  if (!pool) {
    console.error(
      "[akasha-hose] no database configured. An in-memory tape forgets on restart, " +
        "which is not an archive. Set PGHOST/PGDATABASE/PGUSER/PGPASSWORD or DATABASE_URL."
    );
    process.exit(2);
  }

  // Fail fast and loudly if the tape's own tables are not there yet: a hose
  // that starts against a database without migration 104 would throw on every
  // flush and look "running" while persisting nothing.
  const present = await pool.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables
      WHERE table_name IN ('akasha_cursor','akasha_header','akasha_event','akasha_coverage_run')`
  );
  if ((present.rows[0]?.n ?? 0) < 4) {
    console.error(
      "[akasha-hose] the akasha_* tables are missing. Apply migration " +
        "104_akasha_tape.sql before starting the hose."
    );
    process.exit(3);
  }

  const sql: SqlClient = { query: (text, values) => pool.query(text, values as unknown[]) };
  const hose = new Hose({
    chains,
    endpoints: {
      ethereum: process.env.AKASHA_RPC_ETHEREUM,
      base: process.env.AKASHA_RPC_BASE,
      optimism: process.env.AKASHA_RPC_OPTIMISM,
      polygon: process.env.AKASHA_RPC_POLYGON,
      arbitrum: process.env.AKASHA_RPC_ARBITRUM,
      bsc: process.env.AKASHA_RPC_BSC,
      avalanche: process.env.AKASHA_RPC_AVALANCHE,
      zora: process.env.AKASHA_RPC_ZORA,
    },
    sql,
    sha256: (b) => `0x${createHash("sha256").update(b).digest("hex")}` as Hex,
  });

  await hose.boot();
  console.log(`[akasha-hose] owning tip for: ${chains.join(", ")}`);

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    // Flush before exit. Un-flushed writes are not lost data in the dangerous
    // sense -- coverage is a run-list, so a dropped write reopens a hole the
    // gap worker absorbs -- but flushing is free here and a hole is work.
    console.log(`[akasha-hose] ${sig}: flushing tape before exit`);
    await hose.flush().catch((e) => console.error("[akasha-hose] final flush failed", e));
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const tick = async (): Promise<void> => {
    if (stopping) return;
    try {
      if (chains.includes("bitcoin")) await hose.bitcoinTick();
      await hose.repairTick();
      await hose.backfillTick();
      await hose.flush();
    } catch (e) {
      // A failing tick must never kill the process: the next tick retries and
      // unflushed writes stay queued. Silence here would be the worse bug, so
      // it is logged every time.
      console.error("[akasha-hose] tick failed:", e instanceof Error ? e.message : e);
    }
  };

  setInterval(() => void tick(), TICK_MS).unref?.();
  setInterval(() => {
    console.log("[akasha-hose] health", JSON.stringify(hose.health()));
  }, HEALTH_MS).unref?.();

  await tick();
  // Keep the event loop alive: the timers above are unref'd so they alone
  // would let node exit.
  setInterval(() => undefined, 1 << 30);
}

main().catch((e) => {
  console.error("[akasha-hose] fatal:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
