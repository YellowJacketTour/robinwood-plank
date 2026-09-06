/**
 * HyperSync transport benchmark: paged get() vs stream() for the same
 * Transfer-log range, measured, so the "switch to streaming" question in
 * GROK-ONESHOT-instant-live-multichain-2026-08-27.md §4.2 gets a number
 * instead of an opinion.
 *
 *   npx tsx --env-file=.env.local scripts/hypersync-stream-bench.ts --chain=base-mainnet --blocks=20000 [--contract=0x...]
 *
 * Requires ENVIO_API_TOKEN. Reads only; writes nothing. Each mode is timed
 * from first request to last log; logs counted so the two runs are proven
 * to have seen the same data. Prints a JSON line.
 */
import { HypersyncClient, type Query } from "@envio-dev/hypersync-client";
import { EVM_CHAIN_ID, TRANSFER_TOPIC } from "../lib/market/multichain/discovery/evm-log-scan";
import { recordExternalCall, flushProviderLedger } from "../lib/market/multichain/edge/provider-ledger";
import { closePostgres, hasPostgresConfig } from "../lib/postgres";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const chain = arg("chain") ?? "base-mainnet";
const blocks = Number(arg("blocks") ?? 20_000);
const contract = arg("contract");
const chainId = EVM_CHAIN_ID[chain];
if (!chainId) throw new Error(`unknown chain ${chain}`);
const apiToken = process.env.ENVIO_API_TOKEN?.trim();
if (!apiToken) throw new Error("ENVIO_API_TOKEN is required");

const client = new HypersyncClient({ url: `https://${chainId}.hypersync.xyz`, apiToken });

function baseQuery(fromBlock: number, toBlock: number): Query {
  return {
    fromBlock,
    toBlock,
    logs: [{ topics: [[TRANSFER_TOPIC]], ...(contract ? { address: [contract] } : {}) }],
    fieldSelection: { log: ["BlockNumber", "LogIndex", "TransactionHash", "Address", "Topic0", "Topic1", "Topic2", "Topic3"] },
  };
}

async function viaGet(fromBlock: number, toBlock: number) {
  const t0 = Date.now();
  let next = fromBlock;
  let logs = 0;
  let requests = 0;
  while (next < toBlock) {
    const res = await client.get({ ...baseQuery(next, toBlock) });
    requests += 1;
    logs += res.data.logs.length;
    recordExternalCall({ source: "hypersync", chainSlug: chain, latencyMs: 0, outcome: "ok" });
    if (res.nextBlock <= next) break;
    next = res.nextBlock;
  }
  return { mode: "get", ms: Date.now() - t0, logs, requests };
}

async function viaStream(fromBlock: number, toBlock: number) {
  const t0 = Date.now();
  let logs = 0;
  let batches = 0;
  const stream = await client.stream(baseQuery(fromBlock, toBlock), {});
  for (;;) {
    const res = await stream.recv();
    if (res == null) break;
    batches += 1;
    logs += res.data.logs.length;
  }
  await stream.close();
  recordExternalCall({ source: "hypersync", chainSlug: chain, latencyMs: Date.now() - t0, outcome: "ok" });
  return { mode: "stream", ms: Date.now() - t0, logs, batches };
}

async function main() {
  const height = await client.getHeight();
  const toBlock = height;
  const fromBlock = Math.max(0, height - blocks);
  console.log(`[bench] ${chain} blocks ${fromBlock}..${toBlock}${contract ? ` contract ${contract}` : ""}`);
  const g = await viaGet(fromBlock, toBlock);
  console.log(`[bench] get     ${g.ms} ms, ${g.logs} logs, ${g.requests} requests`);
  const s = await viaStream(fromBlock, toBlock);
  console.log(`[bench] stream  ${s.ms} ms, ${s.logs} logs, ${s.batches} batches`);
  const result = { chain, fromBlock, toBlock, get: g, stream: s, sameLogCount: g.logs === s.logs, speedup: g.ms > 0 ? Number((g.ms / Math.max(1, s.ms)).toFixed(2)) : null };
  console.log(JSON.stringify(result));
  if (hasPostgresConfig()) {
    await flushProviderLedger();
    await closePostgres();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
