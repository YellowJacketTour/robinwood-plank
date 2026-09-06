/**
 * Time-to-100% for one collection, measured, never estimated.
 *
 *   npx tsx --env-file=.env.local scripts/hydration-time-to-complete.ts --chain=base-mainnet [--collection=0x...]
 *       [--max-minutes=30] [--run-mesh]
 *
 * Picks the collection (or the most incomplete tracked one on that chain
 * with a known supply), publishes a click-tier intent on the demand bus,
 * then polls the REAL row counts (plank_collection_tokens vs the snapshot's
 * total_supply, metadata complete count) every 5 s and prints when
 * membership and metadata each reach 100%. With --run-mesh it spawns
 * `scripts/mesh-tick.ts --chain=<chain> --minutes=<max>` so the measurement
 * is self-contained; without it, a mesh must already be running.
 * Writes nothing but the intent row and the jobs the mesh would enqueue
 * anyway. Prints a JSON line at the end for the spec's table.
 */
import { spawn } from "node:child_process";
import { closePostgres, postgresQuery } from "../lib/postgres";
import { publishIntent } from "../lib/market/multichain/edge/demand-bus";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const chain = arg("chain");
const maxMinutes = Number(arg("max-minutes") ?? 30);
const runMesh = process.argv.includes("--run-mesh");
if (!chain) {
  console.error("--chain=<slug> is required");
  process.exit(1);
}

type Progress = { rows: number; supply: number | null; metadataComplete: number };

async function progress(collection: string): Promise<Progress> {
  const r = await postgresQuery<{ rows: string; meta: string }>(
    `SELECT COUNT(*)::text AS rows, COUNT(*) FILTER (WHERE metadata_state = 'complete')::text AS meta
       FROM plank_collection_tokens WHERE chain_slug = $1 AND lower(collection_slug) = lower($2)`,
    [chain, collection]
  );
  const s = await postgresQuery<{ total_supply: string | null }>(
    `SELECT s.total_supply::text FROM plank_multichain_collections c
       JOIN plank_multichain_snapshots s ON s.collection_id = c.id
      WHERE c.chain_slug = $1 AND lower(c.contract_address) = lower($2)`,
    [chain, collection]
  );
  const supply = s.rows[0]?.total_supply != null ? Number(s.rows[0].total_supply) : null;
  return { rows: Number(r.rows[0].rows), supply, metadataComplete: Number(r.rows[0].meta) };
}

async function pickCollection(): Promise<string | null> {
  const r = await postgresQuery<{ contract_address: string }>(
    `SELECT c.contract_address
       FROM plank_multichain_collections c
       JOIN plank_multichain_snapshots s ON s.collection_id = c.id
       LEFT JOIN LATERAL (SELECT COUNT(*) AS n FROM plank_collection_tokens t WHERE t.chain_slug = c.chain_slug AND lower(t.collection_slug) = lower(c.contract_address)) t ON TRUE
      WHERE c.chain_slug = $1 AND s.total_supply IS NOT NULL AND s.total_supply BETWEEN 500 AND 25000 AND t.n < s.total_supply
      ORDER BY (t.n::numeric / s.total_supply) ASC LIMIT 1`,
    [chain]
  );
  return r.rows[0]?.contract_address ?? null;
}

async function main() {
  const collection = arg("collection") ?? (await pickCollection());
  if (!collection) {
    console.error(`no incomplete collection with a known supply on ${chain}`);
    process.exit(1);
  }
  const start = await progress(collection);
  console.log(`[ttc] ${chain} ${collection} start rows=${start.rows}/${start.supply ?? "?"} metadata=${start.metadataComplete}`);
  await publishIntent({ kind: "click", chainSlug: chain!, subjects: [collection], context: "time-to-complete" }, { hash: "ttc-script" });

  let mesh: ReturnType<typeof spawn> | null = null;
  if (runMesh) {
    mesh = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/mesh-tick.ts", `--chain=${chain}`, `--minutes=${maxMinutes}`], { stdio: "inherit", env: process.env });
  }
  const t0 = Date.now();
  let membershipAt: number | null = null;
  let metadataAt: number | null = null;
  let last = start;
  while (Date.now() - t0 < maxMinutes * 60_000) {
    await new Promise((r) => setTimeout(r, 5_000));
    last = await progress(collection);
    const el = Math.round((Date.now() - t0) / 1000);
    if (last.supply != null && membershipAt == null && last.rows >= last.supply) membershipAt = el;
    if (last.supply != null && metadataAt == null && last.metadataComplete >= last.supply) metadataAt = el;
    console.log(`[ttc] +${el}s rows=${last.rows}/${last.supply ?? "?"} metadata=${last.metadataComplete}${membershipAt != null ? " membership=100%" : ""}${metadataAt != null ? " metadata=100%" : ""}`);
    if (membershipAt != null && metadataAt != null) break;
  }
  mesh?.kill();
  const result = {
    chain, collection, supply: last.supply, startRows: start.rows, endRows: last.rows, startMetadata: start.metadataComplete, endMetadata: last.metadataComplete,
    membershipSeconds: membershipAt, metadataSeconds: metadataAt, elapsedSeconds: Math.round((Date.now() - t0) / 1000), reached100: membershipAt != null && metadataAt != null,
  };
  console.log(JSON.stringify(result));
  await closePostgres();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
