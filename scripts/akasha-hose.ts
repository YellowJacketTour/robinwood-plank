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
/**
 * Shards claimed per tick per chain. 0 disables the parallel walk entirely.
 *
 * Default off: sharding is a second reader against the same public RPC pool
 * the tip-follow uses, and a host that cannot afford the fan-out should not
 * discover that by being rate-limited off its own tip. Turn it up once the
 * budget is known.
 */
const SHARD_CLAIMS = Math.max(0, Number(process.env.AKASHA_SHARD_CLAIMS ?? 0));
/**
 * How much of each tick the past may use. Two thirds leaves the tip-follow a
 * full third of headroom; the walk also stops early the moment an epoch makes
 * no progress, so this is a ceiling rather than a target.
 */
const BACKFILL_BUDGET_MS = Math.max(0, Math.floor(TICK_MS * 0.66));
/** Process start, so heartbeat age is UPTIME rather than time-since-last-tick. */
const BOOT_AT = new Date().toISOString();
const HEALTH_MS = Number(process.env.AKASHA_HEALTH_MS ?? 60_000);

/**
 * Bounded run, so this fits the host's cron-under-flock pattern.
 *
 * Every always-on worker here is started every minute under a lock with a
 * budget just under the hour: effectively always-on, with a clean restart each
 * hour that reclaims sockets and file handles on a shared box. `--max-seconds`
 * is the budget; when it elapses the process flushes and exits 0, and the next
 * minute's cron takes the lock.
 *
 * It also makes provisioning testable: a proof run with a small budget must
 * complete and exit before the schedule is installed, so a broken worker never
 * gets scheduled to fail silently every minute with nobody watching.
 */
function argSeconds(): number | null {
  const arg = process.argv.find((a) => a.startsWith("--max-seconds="));
  if (!arg) return null;
  const n = Number(arg.split("=")[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

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
  // A BOOT ROW, WRITTEN ONCE.
  //
  // This is the single fact that separates "the worker is dead" from every
  // other explanation of a frozen tail, and it was previously unavailable at
  // any HTTP surface. `boot: true` resets tick_count and moves boot_at, so a
  // restart loop is visible as a boot_at that keeps advancing with a
  // tick_count that never grows.
  hose.durableStore?.recordHeartbeat("akasha-hose", {
    pid: process.pid,
    bootAt: BOOT_AT,
    chains: chains.join(","),
    version: process.env.GIT_COMMIT ?? "unknown",
    boot: true,
  });
  await hose.flush().catch(() => undefined);
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

  // EVERY PHASE REPORTS SEPARATELY.
  //
  // These phases used to share ONE try/catch, so a throw in an early phase
  // silently skipped every later one -- including the backfill -- for that
  // tick, forever, while the process stayed up and healthy-looking. The only
  // evidence was a stdout line no HTTP route can read, which is why Bitcoin's
  // frozen tail survived three separate investigations.
  //
  // Each phase now records that it started, that it finished, and what it
  // threw, into akasha_worker_phase. A phase that throws no longer takes the
  // rest of the tick with it: the backfill runs even when the repair fails,
  // which is both more honest AND more correct -- there was never a reason
  // for one to block the other.
  const phase = async (name: string, run: () => Promise<unknown>): Promise<void> => {
    const store = hose.durableStore;
    const chainKey = (chains.length === 1 ? String(chains[0]) : "all") as never;
    store?.recordPhase(chainKey, name, "attempt");
    try {
      await run();
      store?.recordPhase(chainKey, name, "success");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      store?.recordPhase(chainKey, name, "failure", { error: message });
      console.error(`[akasha-hose] phase ${name} failed:`, message);
    }
  };

  const tick = async (): Promise<void> => {
    if (stopping) return;
    try {
      hose.durableStore?.recordHeartbeat("akasha-hose", {
        pid: process.pid,
        bootAt: BOOT_AT,
        chains: chains.join(","),
        version: process.env.GIT_COMMIT ?? "unknown",
      });
      if (chains.includes("bitcoin")) {
        await phase("bitcoin-tip", () => hose.bitcoinTick());
        // PER-HOST FAILURE COUNTS, WHERE A ROUTE CAN READ THEM.
        //
        // The telemetry said `bitcoin-tip` was failing with "fetch failed",
        // which is true but not actionable: it does not say whether ONE host
        // is down or ALL of them are, and that distinction is the difference
        // between "rotate away from a bad mirror" and "this box's IP is
        // blocked by the whole vendor family". The counts existed already --
        // in a health line on stdout that no route can reach, which is the
        // exact failure this whole telemetry effort exists to end.
        const health = hose.health() as { bitcoinHostFailures?: Record<string, number> };
        if (health.bitcoinHostFailures) {
          hose.durableStore?.recordPhase("bitcoin" as never, "bitcoin-hosts", "attempt", {
            detail: health.bitcoinHostFailures,
          });
        }
      }
      await phase("repair", () => hose.repairTick());
      // The shattered archive, alongside the serial walk rather than instead
      // of it. The serial tail keeps moving; sharding fills the rest of the
      // past in parallel, and the two converge on the same run-list because a
      // coverage run is keyed (chain, from_height). Off by default: it is a
      // second reader against the same RPC pool, so the operator turns it on
      // when the host can afford the fan-out.
      if (SHARD_CLAIMS > 0) {
        for (const chain of chains) {
          const res = await hose.shardTick(chain, SHARD_CLAIMS).catch((e) => {
            hose.durableStore?.recordPhase(chain as never, "shard", "failure", {
              error: e instanceof Error ? e.message : String(e),
            });
            return undefined;
          });
          if (res && (res.walked > 0 || res.failed > 0)) {
            console.log(`[akasha-hose] shard ${chain}`, JSON.stringify(res));
          }
        }
      }
      // Spend most of the tick on the past. The tip-follow above has already
      // run, so this is otherwise idle time, and at 8 blocks per epoch the
      // default rate needed 43 days to reach Bitcoin's protocol origin.
      await phase("backfill", () => hose.backfillTick(BACKFILL_BUDGET_MS));
      // The flush is what makes every recordPhase above durable, so it must
      // run even if a phase failed -- phase() already swallows, so reaching
      // here is guaranteed.
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

  const budget = argSeconds();
  if (budget != null) {
    console.log(`[akasha-hose] bounded run: ${budget}s`);
    setTimeout(() => {
      console.log("[akasha-hose] budget reached");
      void shutdown("budget");
    }, budget * 1000);
  }
  // Keep the event loop alive. The tick and health timers are unref'd, so
  // without this node would exit immediately.
  //
  // In a BOUNDED run the budget timer above is deliberately NOT unref'd and is
  // the only thing that needs to hold the loop, so no keepalive is installed:
  // adding one that is merely unref'd would work by accident, and a later edit
  // that unref'd the budget timer too would turn a bounded run into an instant
  // exit that still reported success.
  if (budget == null) setInterval(() => undefined, 1 << 30);
}

main().catch((e) => {
  console.error("[akasha-hose] fatal:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
