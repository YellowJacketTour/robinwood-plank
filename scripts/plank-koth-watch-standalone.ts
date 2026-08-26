/**
 * Standalone Season 2 $PLANK KOTH watcher -- ONE real pass of
 * runPlankKothWatch() per invocation, meant to be driven by cron with
 * flock (exact same production pattern this repo already uses for
 * scripts/mesh-tick.ts -- see docs/INMOTION_DEPLOYMENT.md's own real cron
 * line), NOT a perpetual loop process. Deliberately has zero dependency on
 * the broader multichain mesh-tick job scheduler (lib/market/multichain/
 * mesh/matrix.ts, scripts/mesh-lane.ts, scripts/mesh-tick.ts) -- that
 * system is real infrastructure for the NFT/multichain side of this app;
 * the $PLANK KOTH backend (plank-koth-watch.ts, plank-koth-candidate.ts,
 * plank-koth.ts, plank-koth-cursor.ts, plank-pools.ts, wallet-signals.ts)
 * was built with no real dependency on it (see plank-koth-cursor.ts's own
 * header) specifically so it can run on a deployment that doesn't have
 * the mesh-tick scheduler running.
 *
 * Local dev: run this on a short interval yourself (see scripts/mesh-
 * tick-supervisor.sh's own header on why that pattern is LOCAL DEV ONLY).
 * Production cron (mirrors mesh-tick's own real line, adjust the lock
 * path and interval to taste -- every 1-2 minutes keeps the anti-snipe
 * timer responsive; every 5 minutes matches mesh-tick's own cadence if
 * operational consistency matters more than reaction speed):
 *
 *   * / 2 * * * * cd /path/to/current && /usr/bin/flock -n /path/to/shared/plank-koth-watch.lock \
 *     /ABSOLUTE/NPX/BIN tsx --env-file=/path/to/shared/.env.production scripts/plank-koth-watch-standalone.ts \
 *     >> /path/to/logs/plank-koth-watch.log 2>&1
 *
 * (remove the spaces around the leading asterisks above -- written that
 * way here only so this file's own header doesn't look like a comment
 * terminator to a naive parser)
 */
import { runPlankKothWatch } from "../lib/market/plank-koth-watch";
import { hasPostgresConfig } from "../lib/postgres";

async function main(): Promise<void> {
  if (!hasPostgresConfig()) {
    throw new Error("plank-koth-watch-standalone: no PostgreSQL configured");
  }
  const result = await runPlankKothWatch();
  console.log(`[plank-koth-watch-standalone] ${JSON.stringify(result)}`);
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error("[plank-koth-watch-standalone] fatal", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
