import { runHypersyncDiscoveryScan, runHypersyncBackfillScan, runHypersyncPriorityWindowScan } from "../lib/market/multichain/discovery/hypersync-evm-scan.ts";
import { EVM_CHAIN_ID } from "../lib/market/multichain/discovery/evm-log-scan.ts";

// Bounded to ~3 minutes per process, then exits cleanly -- the
// crash-resilient supervisor (_backfill-supervisor.sh) relaunches a fresh
// process immediately. Short passes mean a crash loses at most a few
// rounds of in-flight work (cursors persist in Postgres regardless), and
// starting fresh each pass avoids whatever memory growth might have
// contributed to the earlier segfault under a long-lived single process.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Real bug found live 2026-08-25 (the exact class just fixed in
 * mesh-tick.ts's worker loop): this file's own for-loop has no timeout
 * around any of its three per-chain calls -- confirmed hung 4+ minutes
 * straight on the newly-wired runHypersyncPriorityWindowScan call for
 * eth-mainnet, well past this process's own intended 3-minute pass bound
 * (that bound is only checked BETWEEN outer while-loop iterations, so one
 * hung await inside a single round defeats it completely, freezing every
 * other chain's forward/backfill progress too). Same fix, same reasoning:
 * a hard race against a timer so no single call can ever block this
 * process past a bounded ceiling -- the supervisor's crash-resilient
 * relaunch already tolerates this process exiting/restarting, so treating
 * a timeout as "this round's call failed, move on" is safe.
 */
const CALL_TIMEOUT_MS = 45_000;
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} exceeded ${ms}ms -- unblocking pass loop`));
    }, ms);
    promise.then(
      (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
      (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } }
    );
  });
}

const chains = Object.keys(EVM_CHAIN_ID);
const started = Date.now();
let round = 0;
while (Date.now() - started < 1000 * 60 * 3) {
  round += 1;
  const line = [];
  for (const chainSlug of chains) {
    try {
      const fwd = await withTimeout(runHypersyncDiscoveryScan({ chainSlug }), CALL_TIMEOUT_MS, `fwd:${chainSlug}`);
      if (fwd.registered > 0) line.push(`${chainSlug}:+${fwd.registered}`);
    } catch (e) {
      console.log(`[fwd-err] ${chainSlug}: ${e instanceof Error ? e.message : e}`);
    }
    try {
      const bak = await withTimeout(runHypersyncBackfillScan({ chainSlug }), CALL_TIMEOUT_MS, `bak:${chainSlug}`);
      if (bak.registered > 0) line.push(`${chainSlug}:backfill+${bak.registered}@${bak.fromBlock}`);
    } catch (e) {
      console.log(`[bak-err] ${chainSlug}: ${e instanceof Error ? e.message : e}`);
    }
    // Real root cause found live 2026-08-25: this function was defined
    // (2026-08-20, "i need to see ethereums collections climb") but never
    // actually called from anywhere -- the plain sequential backfill above
    // was still crawling ~2019-era blocks and would take ~9 more real days
    // to reach the 2021-2022 NFT boom, the range this function exists to
    // reach immediately instead. Wired here now, same crash-safe short-pass
    // discipline as the two calls above. eth-mainnet only for now (where
    // the collections actually found stuck live -- Lil Pudgys et al --
    // live); range is this function's own header's documented boom window.
    if (chainSlug === "eth-mainnet") {
      try {
        const pri = await withTimeout(runHypersyncPriorityWindowScan({
          chainSlug, fromBlockFloor: 12_000_000, toBlockCeiling: 15_500_000,
          cursorKey: "eth-mainnet:priority-nft-boom",
        }), CALL_TIMEOUT_MS, `pri:${chainSlug}`);
        if (pri.registered > 0) line.push(`${chainSlug}:priority+${pri.registered}@${pri.fromBlock}`);
      } catch (e) {
        console.log(`[pri-err] ${chainSlug}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  console.log(`round ${round}: ${line.join(" ") || "(no new candidates)"}`);
  // Real safety net, same class of fix as genesis-seaport-backfill-pass.mjs's
  // 2026-08-25 disk-fill incident: runHypersyncDiscoveryScan/
  // runHypersyncBackfillScan can both return near-instantly (a jailed
  // "alchemy-nft" checkSourceBudget short-circuit, no real network I/O) --
  // this loop had zero per-round delay, so it could spin identically fast
  // during any real jail window. A small unconditional sleep bounds worst-
  // case log/round volume regardless of why a round did no real work.
  await sleep(500);
}
process.exit(0);
