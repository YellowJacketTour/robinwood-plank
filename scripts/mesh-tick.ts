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
import { configuredOpenSeaKeyCount } from "../lib/market/multichain/discovery/opensea-key-pool";

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : 6;
const chainFilter = process.argv.find((a) => a.startsWith("--chain="))?.slice("--chain=".length);
// --max-seconds=N: stop claiming new jobs after N seconds (running lanes
// finish). A cron tick under flock can otherwise run for hours on a deep
// queue; the provisioning job's proof run and the 5-minute cadence both
// want a bounded pass. Unset = drain the queue, the historical behaviour.
const maxSecondsArg = process.argv.find((a) => a.startsWith("--max-seconds="));
const claimDeadline = maxSecondsArg ? Date.now() + Number(maxSecondsArg.slice("--max-seconds=".length)) * 1000 : Number.POSITIVE_INFINITY;

/**
 * Real bug found live 2026-08-26 (throughput audit follow-up): --limit
 * bounds TOTAL concurrent lanes, but has no concept that several distinct
 * job sources (opensea-membership, opensea-stats, evm-metadata's OpenSea
 * fallback, robinhood-membership) all share ONE external resource -- the
 * 6-key OpenSea pool, whose real combined sustained throughput is ~1
 * call/sec (600/hr/key, opensea-key-pool.ts's own OPENSEA_MIN_CALL_INTERVAL_MS).
 * Confirmed live: with --limit=6 and several of those sources claimed in
 * the same pass, EVERY key could be simultaneously mid-cooldown at the
 * exact moment a live-priority call needed one, even after that call's
 * own built-in retries (opensea-key-pool.ts's LIVE_RETRY_DELAYS_MS) --
 * 100% failure rate on a healthy pool, a genuine contention regression
 * from this session's own earlier throughput fixes making many more
 * collections compete for real hydration at once instead of the same
 * few permanently starving the rest.
 *
 * A real, in-process semaphore -- independent of --limit -- caps how many
 * of THESE FOUR source kinds can be actually EXECUTING (not just
 * claimed/leased) at the same instant. A worker that claims one of these
 * jobs still owns the lease immediately; it only waits here, before
 * calling runLane, for a free slot. Everything else (fills-reconcile,
 * hypersync scans, unisat/helius lanes, etc.) is entirely unaffected and
 * keeps using the full --limit as before.
 *
 * Real gap found live 2026-08-27: this cap was a flat 2, tuned for this
 * app's real key count at the time (1-2 real keys total). With the pool
 * grown to 7 real, independently-paced keys, a flat 2 left 5 of 7 keys
 * idle at every instant -- real sustained throughput capped under a third
 * of what the pool can actually support, manifesting as spurious "pool
 * exhausted/jailed" contention (provider-pace.ts's own per-key 6.2s
 * cooldown, not a broken pool) even while a direct pool-health check
 * showed all 7 keys under 3% of their daily allowance. Scaled to the real
 * configured pool size (min 2, preserving prior single-key behavior)
 * instead of a number that silently goes stale every time a key is added
 * or removed.
 */
const OPENSEA_TOUCHING_SOURCES = new Set(["opensea-membership", "opensea-stats", "evm-metadata", "robinhood-membership"]);
const MAX_CONCURRENT_OPENSEA_LANES = Math.max(2, configuredOpenSeaKeyCount());

class Semaphore {
  private current = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.current++;
  }
  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) next();
  }
}

const openSeaSemaphore = new Semaphore(MAX_CONCURRENT_OPENSEA_LANES);

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

/**
 * Production (2026-09-06): the release tree has no tsx, so the mesh was
 * never runnable there and the documented cron could not be installed --
 * production hydration was 0 jobs/15 min with 400+ queued. Both scripts are
 * now esbuild-bundled (package.json build:mesh) and, when this scheduler is
 * itself the bundle, lanes are spawned as plain node on the sibling bundle.
 */
function laneEntry(): string[] {
  const self = process.argv[1] ?? "";
  if (self.endsWith("mesh-tick-standalone.mjs")) {
    return [self.replace(/mesh-tick-standalone\.mjs$/, "mesh-lane-standalone.mjs")];
  }
  return ["--import", "tsx", "scripts/mesh-lane.ts"];
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
        [...laneEntry(), `--source=${source}`, `--chain=${chain}`,
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

  // Real bug found live 2026-08-25 ("doesnt appear to be fast live
  // filling"): confirmed live 217 collections across every chain were
  // PINNED at the max viewport-visibility priority (120), most last
  // actually pinged 30+ real minutes ago -- see demoteStaleVisibleDemand's
  // own header for the full "why" (a ratchet-only-up field, same shape as
  // the earlier not_before starvation bug, with nothing to ever bring it
  // back down once the tab that earned it closes). Left unattended this
  // permanently starves every real, currently-open detail-page's own
  // demand (anchored-membership/opensea-stats/etc top out around 95-100)
  // -- run the correction every real pass, before claiming, so a stuck
  // backlog never gets more than one pass' worth of head start.
  try {
    const { demoteStaleVisibleDemand } = await import("../lib/market/multichain/collection-demand");
    const { demoted } = await demoteStaleVisibleDemand();
    if (demoted) console.log(`[mesh-tick] demoted ${demoted} stale-visible job(s) back to background priority`);
  } catch (error) {
    console.error("[mesh-tick] demoteStaleVisibleDemand failed", error instanceof Error ? error.message : error);
  }

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
      // Real gap found live 2026-08-26 (throughput audit: "why does real
      // visitor demand only crawl"): these three sources' 100 sat ABOVE
      // every real-visitor demand tier (DETAIL_PAGE=95..98, VISIBLE=110 is
      // the only thing actually above it) and TIED PREDICT_NEXT=100 --
      // see collection-demand.ts's own DEMAND_PRIORITY comments, whose
      // entire stated intent is that background work must never outrank a
      // real click. Their not_before also ratchets to the earliest
      // enqueue moment (control-plane.ts's own LEAST()), so once ahead on
      // a tie they stayed ahead every pass, forever. Lowered to 60 --
      // still well above the generic 20 background floor (these sources
      // clearly need to matter more than typical background lanes), but
      // below every real-demand tier so a visitor's own page never loses
      // its turn to them.
      priority: lane.source === "seaport-fills" || lane.source === "seaport-fills-genesis" || lane.source === "native-robinwood" ? 60 : 20,
    });
  }

  console.log(`[mesh-tick] ${lanes.length} live lanes queued, concurrency=${limit}`);
  if (lanes.length === 0) return;
  const claimKinds = [...new Set(lanes.map((lane) => `mesh-lane:${lane.chainSlug}`))];
  async function worker(): Promise<void> {
    const { recordLaneClaim, recordLaneOutcome } = await import("../lib/market/multichain/mesh/lane-health");
    while (true) {
      if (Date.now() >= claimDeadline) break;
      const job = await claimDataJob(claimKinds);
      if (!job) break;
      if (!job.chainSlug) {
        await finishDataJob(job, "mesh lane has no chain slug");
        continue;
      }
      const laneKey = `${job.source}:${job.chainSlug}`;
      await recordLaneClaim(laneKey);
      console.log(`[mesh-tick] start ${job.jobKey}`);
      // See OPENSEA_TOUCHING_SOURCES's own header: this job is already
      // claimed/leased to this worker regardless -- only its EXECUTION
      // waits here for a free OpenSea-pool slot, so extra concurrent
      // OpenSea demand queues in-process instead of every claimed lane
      // hammering the shared 6-key pool at the exact same instant.
      const needsOpenSeaSlot = OPENSEA_TOUCHING_SOURCES.has(job.source);
      if (needsOpenSeaSlot) await openSeaSemaphore.acquire();
      let code: number;
      try {
        code = await runLane(job.source, job.chainSlug, job.subject);
      } finally {
        if (needsOpenSeaSlot) openSeaSemaphore.release();
      }
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
