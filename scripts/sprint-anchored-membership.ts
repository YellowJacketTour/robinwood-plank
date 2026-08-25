/**
 * Real "sprint mode" -- bypasses mesh-tick's shared, fair, round-robin
 * queue entirely and calls the anchored-membership scan for ONE target
 * collection back-to-back, as fast as the real HyperSync account allows,
 * until it reports done:true. Built live 2026-08-25 ("why cant i see a
 * constant incrementing growth until fully synced and then move on").
 *
 * Deliberately NOT the default behavior: mesh-tick's shared queue exists
 * so many concurrently-prioritized collections (every visitor's own open
 * page) get fair, real progress at once, not "one visitor's collection
 * monopolizes every worker while everyone else waits." This script is the
 * explicit, opt-in escape hatch for "I want to watch THIS one finish now."
 *
 *   npx tsx --env-file=.env.local scripts/sprint-anchored-membership.ts <chainSlug> <contractAddress>
 */
import { runAnchoredMembershipBackfill } from "../lib/market/multichain/discovery/anchored-membership-backfill";

const [chainSlug, contractAddress] = process.argv.slice(2);
if (!chainSlug || !contractAddress) {
  console.error("usage: sprint-anchored-membership.ts <chainSlug> <contractAddress>");
  process.exit(1);
}

async function main() {
  let pass = 0;
  const started = Date.now();
  while (true) {
    pass += 1;
    const t0 = Date.now();
    const result = await runAnchoredMembershipBackfill(chainSlug, contractAddress);
    const ms = Date.now() - t0;
    console.log(
      `[sprint] pass ${pass}: toBlock=${result.toBlock} +${result.registered} tokens ` +
        `(${result.logsScanned} logs) in ${ms}ms -- done=${result.done}`
    );
    if (result.done) {
      console.log(`[sprint] DONE after ${pass} passes, ${((Date.now() - started) / 1000).toFixed(1)}s total`);
      break;
    }
  }
}
main().catch((e) => {
  console.error("[sprint] FATAL", e instanceof Error ? e.message : e);
  process.exit(1);
});
