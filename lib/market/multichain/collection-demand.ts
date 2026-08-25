import { enqueueDataJob } from "@/lib/market/multichain/control-plane";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { isBitcoinChainSlug, isRobinhoodChainSlug, isSolanaChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";
import { CRYPTOPUNKS_CONTRACT } from "@/lib/market/multichain/native-market-adapters/cryptopunks";

/**
 * Turn anonymous collection demand into durable shared work. Requests never
 * perform provider fan-out; the mesh deduplicates these keys and every later
 * visitor reads the resulting PostgreSQL projection.
 */
export async function prioritizeCollectionDemand(chainSlug: string, collectionKey: string): Promise<void> {
  const normalized = /^0x[0-9a-f]{40}$/i.test(collectionKey) ? collectionKey.toLowerCase() : collectionKey;
  const jobs: Parameters<typeof enqueueDataJob>[0][] = [];
  const add = (source: Parameters<typeof enqueueDataJob>[0]["source"], priority: number) => jobs.push({
    jobKey: `demand:${source}:${chainSlug}:${normalized}`,
    kind: `mesh-lane:${chainSlug}`,
    source,
    chainSlug,
    subject: normalized,
    priority,
  });

  if (isBitcoinChainSlug(chainSlug)) {
    add("unisat-membership", 98);
    add("unisat-rarity", 97);
  } else if (isSolanaChainSlug(chainSlug)) {
    add("helius-membership", 98);
    add("magiceden-solana", 96);
  } else if (isRobinhoodChainSlug(chainSlug)) {
    add("robinhood-membership", 98);
    add("evm-metadata", 97);
    add("opensea-stats", 96);
  } else if (foreignChainByChainSlug(chainSlug)) {
    add("opensea-membership", 98);
    add("evm-metadata", 97);
    add("opensea-stats", 96);
    if (chainSlug === "eth-mainnet" && normalized === CRYPTOPUNKS_CONTRACT) add("cryptopunks-native", 100);
  }
  await Promise.all(jobs.map((job) => enqueueDataJob(job))).then(() => undefined);
}
