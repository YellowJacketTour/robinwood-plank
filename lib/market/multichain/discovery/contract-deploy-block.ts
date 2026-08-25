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
 * has no code deployed there. A contract's earliest Transfer (mint)
 * block is a real, immutable, discoverable fact; anchoring a
 * collection's own membership backfill there instead removes that
 * wasted walk entirely.
 *
 * REAL PROVIDER CORRECTION, same day: this originally binary-searched
 * eth_getCode via rpc-provider-pool.ts (~24 historical eth_call round
 * trips). Live testing found every free public RPC in that pool flatly
 * refuses archive-state reads at an old block ("Archive requests require
 * a personal token") -- confirmed live, not guessed -- so all 24 calls
 * fell through to Alchemy alone every time, guaranteeing repeated real
 * quota exhaustion. Switched to HyperSync (hypersync-evm-scan.ts's
 * findEarliestTransferBlock), a wholly separate, address-indexed resource
 * that answers this in one query with none of that exposure.
 */
import { findEarliestTransferBlock } from "@/lib/market/multichain/discovery/hypersync-evm-scan";
import { postgresQuery } from "@/lib/postgres";

/**
 * Real, cached deployment-block lookup -- reads plank_contract_deploy_block
 * first (a contract's earliest mint block never changes, so a hit is
 * always valid forever); only queries HyperSync on a genuine cache miss,
 * and persists the result immediately so no other caller ever repeats the
 * same lookup for the same contract.
 */
export async function findContractDeployBlock(
  chainSlug: string,
  contractAddress: string
): Promise<number | null> {
  const address = contractAddress.toLowerCase();
  const cached = await postgresQuery<{ deploy_block: string }>(
    `SELECT deploy_block FROM plank_contract_deploy_block WHERE chain_slug = $1 AND contract_address = $2`,
    [chainSlug, address]
  );
  if (cached.rows[0]) return Number(cached.rows[0].deploy_block);

  const deployBlock = await findEarliestTransferBlock(chainSlug, address);
  if (deployBlock == null) return null;
  await postgresQuery(
    `INSERT INTO plank_contract_deploy_block (chain_slug, contract_address, deploy_block)
     VALUES ($1, $2, $3)
     ON CONFLICT (chain_slug, contract_address) DO NOTHING`,
    [chainSlug, address, deployBlock]
  );
  return deployBlock;
}
