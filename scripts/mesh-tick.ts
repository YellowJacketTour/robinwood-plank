/**
 * Scheduler: run un-jailed lanes in isolated child processes.
 * Bounded concurrency so we do not DDoS our own keys.
 *
 *   npx tsx --env-file=.env.local scripts/mesh-tick.ts
 *   npx tsx --env-file=.env.local scripts/mesh-tick.ts --limit=8
 */
import { spawn } from "node:child_process";
import { MESH_LANES } from "../lib/market/multichain/mesh/matrix";
import { isSourceJailed } from "../lib/market/multichain/mesh/jail";

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : 6;
const chainFilter = process.argv.find((a) => a.startsWith("--chain="))?.slice("--chain=".length);

function runLane(source: string, chain: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(
      process.execPath,
      ["--import", "tsx", "--env-file=.env.local", "scripts/mesh-lane.ts", `--source=${source}`, `--chain=${chain}`],
      { cwd: process.cwd(), stdio: "inherit", shell: false }
    );
    p.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const { hasDurableKv } = await import("../lib/market/durable-kv");
  if (!hasDurableKv()) throw new Error("mesh-tick: no PG");

  const lanes = [];
  for (const lane of MESH_LANES) {
    if (chainFilter && lane.chainSlug !== chainFilter) continue;
    if (await isSourceJailed(lane.source)) {
      console.log(`[mesh-tick] skip jailed ${lane.id}`);
      continue;
    }
    lanes.push(lane);
  }

  console.log(`[mesh-tick] ${lanes.length} live lanes, concurrency=${limit}`);
  let i = 0;
  async function worker(): Promise<void> {
    while (i < lanes.length) {
      const lane = lanes[i++];
      if (!lane) break;
      console.log(`[mesh-tick] start ${lane.id}`);
      const code = await runLane(lane.source, lane.chainSlug);
      console.log(`[mesh-tick] end ${lane.id} exit=${code}`);
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
    process.exit(0);
  })
  .catch((e) => {
    console.error("[mesh-tick] fatal", e instanceof Error ? e.message : e);
    process.exit(1);
  });
