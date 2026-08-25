/**
 * Scheduler: run un-jailed lanes in isolated child processes.
 * Bounded concurrency so we do not DDoS our own keys.
 *
 *   npx tsx --env-file=.env.local scripts/mesh-tick.ts
 *   npx tsx --env-file=.env.local scripts/mesh-tick.ts --limit=8
 */
import { spawn } from "node:child_process";
import { MESH_LANES, type MeshLane } from "../lib/market/multichain/mesh/matrix";
import { isSourceJailed } from "../lib/market/multichain/mesh/jail";
import { claimDataJob, enqueueDataJob, finishDataJob } from "../lib/market/multichain/control-plane";

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : 6;
const chainFilter = process.argv.find((a) => a.startsWith("--chain="))?.slice("--chain=".length);

/**
 * Light-worker fast path (Unified Mesh Continuum build item #3, deferred
 * earlier for its own dedicated pass, now built conservatively -- Grok's
 * own recommendation, docs/marketplank/GROK-FINDINGS-unified-maximal-
 * hydration-2026-08-26.md: "long-lived workers for tiny I/O jobs, keep
 * short-lived spawn for heavy/unsafe lanes"). Real cost this fixes: every
 * spawn() below pays a full Node+tsx cold start even for a 6-token
 * evm-metadata batch -- these three sources are small, fast, bounded, and
 * safe to run in-process inside this already-long-lived scheduler.
 *
 * Deliberately NOT a general-purpose refactor of every lane onto this
 * path: heavy/long-running lanes (HyperSync scans, genesis backfills)
 * keep their own isolated child process -- a crash there must not take
 * this scheduler down with it, same real crash-isolation reasoning the
 * spawn-per-job design already has.
 */
const LIGHT_SOURCES = new Set(["evm-metadata", "erc4906-rescan", "ipfs-corroboration"]);

async function runLightSourceInProcess(source: string, chain: string, subject?: string | null): Promise<number> {
  try {
    if (source === "evm-metadata") {
      const { advanceEvmTokenMetadata } = await import("../lib/market/multichain/rarity-index-runner");
      const ceiling = subject ? 250 : 75;
      let attempted = 0;
      const deadline = Date.now() + 45_000;
      while (attempted < ceiling && Date.now() < deadline) {
        const batch = await advanceEvmTokenMetadata(chain, 25, subject || null);
        attempted += batch.attempted;
        if (batch.attempted === 0) break;
      }
      return 0;
    }
    if (source === "erc4906-rescan") {
      const { runMetadataUpdateRescanBatch } = await import("../lib/market/multichain/discovery/erc4906-rescan");
      await runMetadataUpdateRescanBatch(chain, 5);
      return 0;
    }
    if (source === "ipfs-corroboration") {
      const { sampleIpfsCorroboration } = await import("../lib/market/multichain/discovery/ipfs-corroboration");
      await sampleIpfsCorroboration(chain, 25);
      return 0;
    }
    return 1;
  } catch (error) {
    console.error(`[mesh-tick] light-worker ${source}:${chain} failed`, error instanceof Error ? error.message : error);
    return 1;
  }
}

/**
 * Hard ceiling on ANY single lane, light or spawned. Real root cause found
 * live 2026-08-25: a light-source in-process call (evm-metadata:arb-mainnet)
 * hung well past its own internal 45s "deadline" -- that deadline is only
 * checked BETWEEN loop iterations inside runLightSourceInProcess, so one
 * hung await inside a single iteration (a network call with no timeout of
 * its own, several layers down) defeats it entirely. worker()'s sequential
 * `await runLane(...)` had NO outer bound at all, so that one hang froze
 * the whole single-threaded scheduler -- every other lane, including
 * demand-priority live jobs for a collection someone is actively looking
 * at, starves silently and indefinitely. Same exposure for a spawned lane
 * whose child process wedges: `p.on("exit")` never fires without a kill.
 * 90s is a real, deliberate margin above the light-source path's own 45s
 * budget, not a guess -- large enough that a genuinely slow-but-progressing
 * lane never gets killed mid-work, small enough that no lane can ever
 * block the scheduler for more than one real "unit" of sequential delay.
 */
const LANE_TIMEOUT_MS = 90_000;

function withTimeout(promise: Promise<number>, ms: number, label: string): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error(`[mesh-tick] lane ${label} exceeded ${ms}ms -- treating as failed, unblocking scheduler`);
      resolve(1);
    }, ms);
    promise.then(
      (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(code);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(1);
      }
    );
  });
}

function runLane(source: string, chain: string, subject?: string | null): Promise<number> {
  const label = `${source}:${chain}`;
  if (LIGHT_SOURCES.has(source)) return withTimeout(runLightSourceInProcess(source, chain, subject), LANE_TIMEOUT_MS, label);
  return withTimeout(
    new Promise((resolve) => {
      const p = spawn(
        process.execPath,
        // The scheduler process is the environment boundary. Children inherit
        // its production/local environment; hard-coding .env.local here made a
        // correctly configured production tick fail before a lane could run.
        ["--import", "tsx", "scripts/mesh-lane.ts", `--source=${source}`, `--chain=${chain}`,
          ...(subject ? [`--subject=${subject}`] : [])],
        { cwd: process.cwd(), stdio: "inherit", shell: false }
      );
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        p.kill("SIGKILL");
      }, LANE_TIMEOUT_MS - 1_000);
      p.on("exit", (code) => {
        clearTimeout(timer);
        resolve(killed ? 1 : code ?? 1);
      });
    }),
    LANE_TIMEOUT_MS,
    label
  );
}

async function main(): Promise<void> {
  const { hasDurableKv } = await import("../lib/market/durable-kv");
  if (!hasDurableKv()) throw new Error("mesh-tick: no PG");

  const lanes: MeshLane[] = [];
  for (const lane of MESH_LANES) {
    if (chainFilter && lane.chainSlug !== chainFilter) continue;
    if (await isSourceJailed(lane.source, lane.chainSlug)) {
      console.log(`[mesh-tick] skip jailed ${lane.id}`);
      continue;
    }
    lanes.push(lane);
    await enqueueDataJob({
      jobKey: `mesh:${lane.id}`,
      kind: `mesh-lane:${lane.chainSlug}`,
      source: lane.source,
      chainSlug: lane.chainSlug,
      // Background lanes rotate globally. Only demand jobs carry an exact
      // collection subject; a lane id is orchestration identity, not data.
      subject: null,
      payload: { sliceSec: lane.sliceSec, cells: lane.cells },
      priority: lane.source === "seaport-fills" || lane.source === "seaport-fills-genesis" || lane.source === "native-robinwood" ? 100 : 20,
    });
  }

  console.log(`[mesh-tick] ${lanes.length} live lanes queued, concurrency=${limit}`);
  if (lanes.length === 0) return;
  const claimKinds = [...new Set(lanes.map((lane) => `mesh-lane:${lane.chainSlug}`))];
  async function worker(): Promise<void> {
    const { recordLaneClaim, recordLaneOutcome } = await import("../lib/market/multichain/mesh/lane-health");
    while (true) {
      const job = await claimDataJob(claimKinds);
      if (!job) break;
      if (!job.chainSlug) {
        await finishDataJob(job, "mesh lane has no chain slug");
        continue;
      }
      const laneKey = `${job.source}:${job.chainSlug}`;
      await recordLaneClaim(laneKey);
      console.log(`[mesh-tick] start ${job.jobKey}`);
      const code = await runLane(job.source, job.chainSlug, job.subject);
      // Exit code 2 is a real, deliberate "succeeded, but more real work
      // remains" signal (see mesh-lane.ts's anchored-membership handler) --
      // never a failure. finishDataJob first (its own unconditional status
      // UPDATE, matched by id/lease_owner, must land before any re-enqueue
      // or it would silently overwrite the re-enqueue's 'queued' status
      // right back to 'succeeded'), then re-enqueue the identical job key
      // so mesh-tick keeps picking this collection back up pass after pass
      // until its own real completion signal (`done: true`) actually fires
      // -- fixes a real bug live 2026-08-25: a bounded-window job that
      // finished one slice and returned was marked terminally 'succeeded'
      // and never claimed again, despite real remaining work.
      const isPartial = code === 2;
      await finishDataJob(job, code === 0 || isPartial ? undefined : `lane exited ${code}`);
      if (isPartial) {
        await enqueueDataJob({
          jobKey: job.jobKey,
          kind: job.kind,
          source: job.source,
          chainSlug: job.chainSlug,
          subject: job.subject ?? null,
        }).catch(() => {});
      }
      await recordLaneOutcome(laneKey, code === 0 || isPartial);
      console.log(`[mesh-tick] end ${job.jobKey} exit=${code}`);
    }
  }
  const n = Math.min(limit, Math.max(1, lanes.length));
  // Real bug found live 2026-08-25 ("resolve absolutely everything, no
  // shortcuts"): all N workers previously started their first claim in
  // the same instant. Real per-key OpenSea pacing (6.2s/key, 6 keys) caps
  // real sustained pool throughput at ~1 request/second -- a startup
  // burst of up to 16 simultaneous claims (mesh-tick's own concurrency,
  // raised tonight) could exceed OpenSea's real per-second ceiling before
  // the pacing/jail circuit breaker even had a chance to spread them out,
  // confirmed live: a fresh restart tripped a real 429 jail on
  // opensea-stats/opensea-membership within seconds, even though the pool
  // was healthy and well under its daily quota moments before. Staggering
  // each worker's start by a small, real, incremental delay spreads the
  // initial claim burst out instead of firing all of them in the same
  // instant -- the jail/pacing circuit breaker still protects against any
  // REAL sustained overuse; this only removes the artificial, avoidable
  // burst mesh-tick's own startup was creating.
  const workers = Array.from({ length: n }, (_, i) => {
    const startDelayMs = i * 150;
    return (async () => {
      if (startDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, startDelayMs));
      return worker();
    })();
  });
  await Promise.all(workers);
  console.log("[mesh-tick] pass done");
}

main()
  .then(async () => {
    try {
      const { hasPostgresConfig, postgresPool } = await import("../lib/postgres");
      if (hasPostgresConfig()) await postgresPool().end();
    } catch {
      /* */
    }
    process.exitCode = 0;
  })
  .catch((e) => {
    console.error("[mesh-tick] fatal", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
