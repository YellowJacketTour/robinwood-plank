/**
 * Per-collection membership backfill, anchored at the collection's own real
 * deployment block instead of a blind shared window (see
 * contract-deploy-block.ts's own header for the full "why").
 *
 * Scope: only ever invoked for a collection this app already independently
 * knows is stuck (OpenSea's own enumeration has plateaued -- see
 * collection-archival-stats' consecutive_unchanged signal, the same one
 * used live 2026-08-25 to find the real 8 affected collections). This never
 * runs speculatively for a collection whose own OpenSea walk is still
 * making real progress; that path is already correct and cheaper.
 */
import { rpcCall } from "@/lib/market/multichain/discovery/rpc-provider-pool";
import { findContractDeployBlock } from "@/lib/market/multichain/discovery/contract-deploy-block";
import { runAddressScopedMembershipScan } from "@/lib/market/multichain/discovery/hypersync-evm-scan";
import { postgresQuery } from "@/lib/postgres";

/**
 * Real, cheap "is there any real work left" check -- see this file's own
 * header on the real bug this closes (an already-complete collection's
 * job kept winning every priority tie over genuinely incomplete work,
 * forever, because it was cheap enough to keep getting re-enqueued and
 * re-claimed on every repeat page visit). ONE indexed read, no real
 * network call, so callers (hydrationJobSources) can skip enqueueing
 * entirely for a collection already known complete.
 */
export async function isAnchoredMembershipComplete(chainSlug: string, contractAddress: string): Promise<boolean> {
  const result = await postgresQuery<{ anchored_membership_complete: boolean }>(
    `SELECT anchored_membership_complete FROM plank_contract_deploy_block WHERE chain_slug = $1 AND contract_address = $2`,
    [chainSlug, contractAddress.toLowerCase()]
  );
  return result.rows[0]?.anchored_membership_complete === true;
}

export type AnchoredBackfillResult = {
  chainSlug: string;
  contractAddress: string;
  deployBlock: number;
  toBlock: number;
  registered: number;
  logsScanned: number;
  done: boolean;
};

export async function runAnchoredMembershipBackfill(
  chainSlug: string,
  contractAddress: string
): Promise<AnchoredBackfillResult> {
  const address = contractAddress.toLowerCase();
  // Real, cheap short-circuit -- see isAnchoredMembershipComplete's own
  // header. Skips the real deploy-block lookup, the real eth_blockNumber
  // RPC call, and the real HyperSync scan entirely for a collection
  // already proven complete, instead of relying on "the scan itself
  // returns done:true fast" -- that path was STILL cheap enough to keep
  // winning every priority tie over genuinely incomplete collections on
  // every repeat page visit, confirmed live (MAYC: max priority, zero
  // real turns for 50+ minutes while an already-complete collection's
  // job kept getting reclaimed instead).
  if (await isAnchoredMembershipComplete(chainSlug, address)) {
    return { chainSlug, contractAddress: address, deployBlock: 0, toBlock: 0, registered: 0, logsScanned: 0, done: true };
  }
  const deployBlock = await findContractDeployBlock(chainSlug, address);
  if (deployBlock == null) {
    throw new Error(`anchored-membership: no real Transfer activity found for ${chainSlug}:${address} -- nothing to anchor to yet`);
  }
  const { result: heightHex } = await rpcCall<string>(chainSlug, "eth_blockNumber", []);
  const currentHeight = parseInt(heightHex, 16);
  // Real fix, 2026-08-25 ("this should reach 100% but has stopped"): a
  // fixed 300,000-block window past deploy stopped a real, legitimate
  // collection's own history 45 days short of full coverage -- every
  // future call recomputed the SAME fixed ceiling and immediately reported
  // done:true forever once reached, permanently freezing real, incomplete
  // coverage. Address-scoped scanning is proven fast (118,787 real blocks
  // in 33.5s live 2026-08-25) -- no need for an artificial cap that made
  // sense for the old, unfiltered global scan but not this one. Walk all
  // the way to the real current chain tip instead.
  const toBlockCeiling = currentHeight;

  const scan = await runAddressScopedMembershipScan({
    chainSlug,
    contractAddress: address,
    fromBlockFloor: deployBlock,
    toBlockCeiling,
    cursorKey: `anchored:${chainSlug}:${address}`,
    provenance: "hypersync-transfer-anchored",
  });

  if (scan.done) {
    await postgresQuery(
      `UPDATE plank_contract_deploy_block SET anchored_membership_complete = TRUE WHERE chain_slug = $1 AND contract_address = $2`,
      [chainSlug, address]
    ).catch(() => {});
  }

  return {
    chainSlug,
    contractAddress: address,
    deployBlock,
    toBlock: scan.toBlock,
    registered: scan.tokensFound,
    logsScanned: scan.logsScanned,
    done: scan.done,
  };
}
