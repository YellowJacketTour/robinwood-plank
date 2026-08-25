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

function runLane(source: string, chain: string, subject?: string | null): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(
      process.execPath,
      // The scheduler process is the environment boundary. Children inherit
      // its production/local environment; hard-coding .env.local here made a
      // correctly configured production tick fail before a lane could run.
      ["--import", "tsx", "scripts/mesh-lane.ts", `--source=${source}`, `--chain=${chain}`,
        ...(subject ? [`--subject=${subject}`] : [])],
      { cwd: process.cwd(), stdio: "inherit", shell: false }
    );
    p.on("exit", (code) => resolve(code ?? 1));
  });
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
    while (true) {
      const job = await claimDataJob(claimKinds);
      if (!job) break;
      if (!job.chainSlug) {
        await finishDataJob(job, "mesh lane has no chain slug");
        continue;
      }
      console.log(`[mesh-tick] start ${job.jobKey}`);
      const code = await runLane(job.source, job.chainSlug, job.subject);
      await finishDataJob(job, code === 0 ? undefined : `lane exited ${code}`);
      console.log(`[mesh-tick] end ${job.jobKey} exit=${code}`);
    }
  }
  const n = Math.min(limit, Math.max(1, lanes.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
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
