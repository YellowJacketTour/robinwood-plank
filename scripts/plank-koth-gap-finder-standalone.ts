/**
 * Standalone Season 2 $PLANK KOTH gap-finder -- ONE real pass of
 * runPlankKothGapFinder() per invocation, same real cron+flock pattern as
 * scripts/plank-koth-watch-standalone.ts (see that file's own header).
 * Deliberately a SEPARATE cron entry from the primary watcher (different
 * lock file, coarser cadence -- this is a backstop cross-check against
 * DexPaprika, not the primary detection path) so a slow DexPaprika
 * response can never delay the primary watcher's own real-time cadence.
 *
 * Production cron (every 10 minutes -- a backstop needs to run often
 * enough to catch a real gap reasonably quickly, but has no reason to run
 * as often as the primary 2-minute watcher):
 *
 *   * / 10 * * * * cd /path/to/current && /usr/bin/flock -n /path/to/shared/plank-koth-gap-finder.lock \
 *     /ABSOLUTE/NPX/BIN tsx --env-file=/path/to/shared/.env.production scripts/plank-koth-gap-finder-standalone.ts \
 *     >> /path/to/logs/plank-koth-gap-finder.log 2>&1
 *
 * (remove the spaces around the leading asterisks above -- written that
 * way here only so this file's own header doesn't look like a comment
 * terminator to a naive parser)
 */
import { runPlankKothGapFinder } from "../lib/market/plank-koth-gap-finder";
import { hasPostgresConfig } from "../lib/postgres";

async function main(): Promise<void> {
  if (!hasPostgresConfig()) {
    throw new Error("plank-koth-gap-finder-standalone: no PostgreSQL configured");
  }
  const result = await runPlankKothGapFinder();
  console.log(`[plank-koth-gap-finder-standalone] ${JSON.stringify(result)}`);
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error("[plank-koth-gap-finder-standalone] fatal", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
