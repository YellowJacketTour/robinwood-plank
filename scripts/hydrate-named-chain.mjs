/**
 * Claynosaurz-style massage for hub rows: hydrate named collections on one
 * chain (OpenSea/CG/ME/UniSat), skip junk titles. Detached:
 *   node --env-file=.env.local scripts/hydrate-named-chain.mjs avax-mainnet 20
 */
import { readFileSync } from "node:fs";
import pg from "pg";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  if (!process.env[t.slice(0, i)]) process.env[t.slice(0, i)] = t.slice(i + 1);
}

const chain = process.argv[2];
const limit = Number(process.argv[3] || 20);
if (!chain) {
  console.error("usage: hydrate-named-chain.mjs <chainSlug> [limit]");
  process.exit(1);
}

const c = new pg.Client({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
});
await c.connect();
const q = await c.query(
  `SELECT c.contract_address, c.name
   FROM plank_multichain_collections c
   LEFT JOIN plank_multichain_snapshots s ON s.collection_id = c.id
   WHERE c.chain_slug = $1
     AND c.name IS NOT NULL
     AND c.name NOT ILIKE '0x%'
     AND char_length(trim(c.name)) > 2
   ORDER BY s.synced_at ASC NULLS FIRST
   LIMIT $2`,
  [chain, limit]
);
await c.end();
console.log(`[hydrate-named] ${chain} ${q.rows.length} rows`);

const origin = process.env.HYDRATE_ORIGIN || "http://localhost:3800";
for (let i = 0; i < q.rows.length; i += 8) {
  const chunk = q.rows.slice(i, i + 8);
  const res = await fetch(`${origin}/api/market/multichain/hydrate-stats`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      rows: chunk.map((r) => ({ chainSlug: chain, contractAddress: r.contract_address })),
    }),
  }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
  const text = await res.text();
  console.log(`chunk ${i}-${i + chunk.length}: ${res.status} ${text.slice(0, 200)}`);
  await new Promise((r) => setTimeout(r, 1500));
}
