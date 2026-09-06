/**
 * OpenSea Stream ingest worker -- see lib/market/multichain/edge/opensea-
 * stream.ts. Long-running; under cron it is started every minute with
 * `flock -n` and `--max-seconds=3540`, which makes it effectively always-on
 * with a clean restart each hour.
 *
 *   node --env-file=.env.local --import tsx scripts/opensea-stream.ts --max-seconds=60
 *   node --env-file=shared/.env.production scripts/opensea-stream-standalone.mjs --max-seconds=3540
 */
import { runOpenSeaStream } from "../lib/market/multichain/edge/opensea-stream";
import { pickOpenSeaKey } from "../lib/market/multichain/discovery/opensea-key-pool";
import { flushProviderLedger } from "../lib/market/multichain/edge/provider-ledger";
import { closePostgres } from "../lib/postgres";

const maxSecondsArg = process.argv.find((a) => a.startsWith("--max-seconds="));
const maxSeconds = maxSecondsArg ? Number(maxSecondsArg.slice("--max-seconds=".length)) : undefined;

async function main(): Promise<void> {
  const key = await pickOpenSeaKey("background");
  if (!key) {
    console.error("[opensea-stream] no OpenSea API key configured (OPENSEA_API_KEYS) -- nothing to subscribe with");
    process.exitCode = 2;
    return;
  }
  const started = Date.now();
  const stats = await runOpenSeaStream({ apiKey: key.apiKey, keyId: key.id, maxSeconds });
  await flushProviderLedger().catch(() => undefined);
  console.log(
    `[opensea-stream] done after ${Math.round((Date.now() - started) / 1000)}s: received=${stats.received} written=${stats.written} floors=${stats.floors} skipped=${stats.skipped} metadata=${stats.metadata} reconnects=${stats.reconnects} lastEventAt=${stats.lastEventAt ?? "-"}`
  );
}

main()
  .catch((error) => {
    console.error("[opensea-stream] fatal:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closePostgres().catch(() => undefined));
