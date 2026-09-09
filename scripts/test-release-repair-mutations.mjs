import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const root = new URL("../", import.meta.url);
const cases = [
  ["Esplora hash wire format", "packages/akasha/src/hose/rpc/bitcoin.ts", "`/block/${fromHex(hash)}`", "`/block/${hash}`"],
  ["repaired height index", "packages/akasha/src/hose/store.ts", "else arr[index] = h;", "/* stale height index */"],
  ["block identity", "packages/akasha/src/hose/rpc/bitcoin-raw.ts", 'block.getId() !== hash.replace(/^0x/, "").toLowerCase()', "false"],
  ["complete transaction commitment", "packages/akasha/src/hose/rpc/bitcoin-raw.ts", "!block.transactions?.length || !block.checkTxRoots()", "false"],
  ["complete serialized bytes", "packages/akasha/src/hose/rpc/bitcoin-raw.ts", "block.byteLength() !== bytes.length || block.weight() > 4_000_000", "false"],
  ["bounded block response", "packages/akasha/src/hose/rpc/bitcoin-raw.ts", "size > 4_000_000", "size > 8_000_000"],
  ["every epoch seam", "packages/akasha/src/hose/backfill.ts", "linked && height >= lowest.height", "false && height >= lowest.height"],
  ["phase fencing", "scripts/akasha-hose.ts", 'process.exit(75);\n          }, PHASE_TIMEOUT_MS)', '/* leave timed-out writer alive */\n          }, PHASE_TIMEOUT_MS)'],
  ["coalesced scope retention", "lib/market/multichain/edge/change-protocol.ts", "[...previous.scopes, ...next.scopes]", "[...next.scopes]"],
  ["coalesced overflow recovery", "lib/market/multichain/edge/change-protocol.ts", "scopes.length > 64", "scopes.length > 640"],
  ["historical failures do not mask progress", "app/api/market/multichain/worker-health/route.ts", 'backfill.last_error && Date.parse(backfill.last_failure_at ?? "") > (Date.parse(backfill.last_success_at ?? "") || 0)', 'backfill.last_error'],
  ["current stall deadline", "app/api/market/multichain/worker-health/route.ts", '> 120_000', '> 1_200_000'],
  ["progress verdict", "app/api/market/multichain/worker-health/route.ts", '?.tailMoved === true', '?.tailMoved === false'],
];
for (const [name,path,before,after] of cases) {
  const file = new URL(path,root); const original=readFileSync(file,"utf8");
  if(original.split(before).length!==2) throw new Error(`Ambiguous mutation: ${name}`);
  const mutated=original.replace(before,after);
  try {
    writeFileSync(file,mutated);
    if(readFileSync(file,"utf8")!==mutated || mutated===original)throw new Error(`Unapplied mutation: ${name}`);
    const result=spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs","--test","test/market/bitcoin-release-repair.test.ts","test/market/live-coalescing.test.ts","test/market/worker-health-verdict.test.ts"],
      {cwd:root,encoding:"utf8",timeout:20000});
    const killed=result.status!==0 && /AssertionError|ERR_ASSERTION/.test(result.stdout+result.stderr);
    console.log(JSON.stringify({name,applied:true,killed}));
    if(!killed)throw new Error(`Mutation survived or failed for unrelated reason: ${name}\n${result.stdout}\n${result.stderr}`);
  } finally {writeFileSync(file,original);}
}
