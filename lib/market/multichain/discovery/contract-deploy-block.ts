/**
 * Real, one-time contract-deployment-block discovery + cache.
 *
 * WHY THIS EXISTS
 * ----------------
 * Flagged live 2026-08-25: the priority-window backfill (hypersync-evm-
 * scan.ts's runHypersyncPriorityWindowScan) walks a blind, shared,
 * multi-million-block "NFT boom era" window (12M-15.5M) looking for
 * activity across EVERY contract at once. For any ONE already-tracked
 * collection stuck behind a plateaued OpenSea enumeration (Lil Pudgys:
 * OpenSea's own /nfts pagination looping over already-seen tokens,
 * confirmed live), that blind window wastes real scan time walking
 * through blocks the collection PROVABLY could not exist in yet -- it
 * has no code deployed there. A contract's deployment block is a real,
 * immutable, discoverable fact (the first block eth_getCode returns
 * non-empty); anchoring a collection's own membership backfill there
 * instead removes that wasted walk entirely.
 *
 * Binary search over eth_getCode is the only way to discover this for a
 * free public RPC (no vendor exposes contract-creation-block directly at
 * this tier) -- ~24 real eth_call round trips for the whole chain's
 * history, done ONCE per contract ever and cached in
 * plank_contract_deploy_block (migration 071) permanently after that.
 */
import { rpcCall } from "@/lib/market/multichain/discovery/rpc-provider-pool";
import { postgresQuery } from "@/lib/postgres";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function hasCodeAt(chainSlug: string, contractAddress: string, block: number): Promise<boolean> {
  const { result } = await rpcCall<string>(chainSlug, "eth_getCode", [contractAddress, "0x" + block.toString(16)]);
  return !!result && result !== "0x";
}

/**
 * Binary search [0, currentHeight] for the first block where the contract's
 * code exists. Small delay between probes -- a real, live-observed 429 from
 * a free public RPC mid-search (2026-08-25) proved a bare ~24-call tight
 * loop can trip a public node's own per-IP limit; 300ms keeps well under
 * that while still finishing in well under a minute.
 */
async function binarySearchDeployBlock(chainSlug: string, contractAddress: string, currentHeight: number): Promise<number> {
  let lo = 0;
  let hi = currentHeight;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const deployed = await hasCodeAt(chainSlug, contractAddress, mid);
    if (deployed) hi = mid;
    else lo = mid + 1;
    await sleep(300);
  }
  return lo;
}

/**
 * Real, cached deployment-block lookup -- reads plank_contract_deploy_block
 * first (a contract's creation block never changes, so a hit is always
 * valid forever); only binary-searches on a genuine cache miss, and
 * persists the result immediately so no other caller ever repeats the
 * same ~24-call search for the same contract.
 */
export async function findContractDeployBlock(
  chainSlug: string,
  contractAddress: string,
  currentHeight: number
): Promise<number> {
  const address = contractAddress.toLowerCase();
  const cached = await postgresQuery<{ deploy_block: string }>(
    `SELECT deploy_block FROM plank_contract_deploy_block WHERE chain_slug = $1 AND contract_address = $2`,
    [chainSlug, address]
  );
  if (cached.rows[0]) return Number(cached.rows[0].deploy_block);

  const deployBlock = await binarySearchDeployBlock(chainSlug, address, currentHeight);
  await postgresQuery(
    `INSERT INTO plank_contract_deploy_block (chain_slug, contract_address, deploy_block)
     VALUES ($1, $2, $3)
     ON CONFLICT (chain_slug, contract_address) DO NOTHING`,
    [chainSlug, address, deployBlock]
  );
  return deployBlock;
}
