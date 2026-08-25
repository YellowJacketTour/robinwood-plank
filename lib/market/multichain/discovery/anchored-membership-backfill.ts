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
import { runHypersyncPriorityWindowScan } from "@/lib/market/multichain/discovery/hypersync-evm-scan";

/**
 * Generous mint+early-secondary-market window past deployment -- most
 * collections fully mint out within days to a few weeks; 300,000 blocks
 * (~45 days at eth-mainnet's ~13s/block) covers a genuinely slow public
 * mint plus the immediate post-mint trading burst without still being a
 * blind multi-million-block walk.
 */
const ANCHOR_WINDOW_BLOCKS = 300_000;

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
  const { result: heightHex } = await rpcCall<string>(chainSlug, "eth_blockNumber", []);
  const currentHeight = parseInt(heightHex, 16);
  const deployBlock = await findContractDeployBlock(chainSlug, address, currentHeight);
  const toBlockCeiling = Math.min(currentHeight, deployBlock + ANCHOR_WINDOW_BLOCKS);

  const scan = await runHypersyncPriorityWindowScan({
    chainSlug,
    fromBlockFloor: deployBlock,
    toBlockCeiling,
    cursorKey: `anchored:${chainSlug}:${address}`,
  });

  return {
    chainSlug,
    contractAddress: address,
    deployBlock,
    toBlock: scan.toBlock,
    registered: scan.registered,
    logsScanned: scan.logsScanned,
    done: scan.done,
  };
}
