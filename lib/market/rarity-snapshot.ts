import { Contract, JsonRpcProvider } from "ethers";
import {
  NFT_ABI,
  NFT_CONTRACT_ADDRESS,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_RPC_URLS,
} from "@/lib/mint-contract";
import { fetchNftMetadata } from "@/lib/ipfs";
import { computeRaritySnapshot } from "@/lib/rarity";
import type { RarityInput, RaritySnapshot, RarityTier } from "@/lib/rarity";

/**
 * Server-side rarity snapshot — the SAME computeRaritySnapshot() math the
 * Gallery page already uses client-side, run once here so every other
 * surface (marketplace cards, item detail, activity feed) shows a tier/rank
 * that agrees with Gallery instead of a second, drifted rarity system.
 *
 * NFT metadata is immutable once minted, so a full scan only needs to
 * happen once per process — cached indefinitely in memory, not re-derived
 * per request. A cold scan of ~1,542 tokens' tokenURI + IPFS metadata is a
 * real one-time cost; every request after the first hits the cache.
 */

let cached: { snapshot: RaritySnapshot; at: number } | null = null;
let inflight: Promise<RaritySnapshot> | null = null;

const BATCH_SIZE = 25;

async function firstHealthyProvider(): Promise<JsonRpcProvider> {
  let lastError: unknown = null;
  for (const url of ROBINHOOD_RPC_URLS) {
    const provider = new JsonRpcProvider(url, ROBINHOOD_CHAIN_ID, {
      staticNetwork: true,
      batchMaxCount: 1,
    });
    try {
      await provider.getBlockNumber();
      return provider;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`No healthy Robinhood RPC: ${String(lastError)}`);
}

async function buildSnapshot(): Promise<RaritySnapshot> {
  const provider = await firstHealthyProvider();
  const contract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, provider);
  const supply = Number(await contract.totalSupply());

  const inputs: RarityInput[] = [];
  for (let start = 1; start <= supply; start += BATCH_SIZE) {
    const ids = Array.from(
      { length: Math.min(BATCH_SIZE, supply - start + 1) },
      (_, i) => start + i
    );
    const batch = await Promise.all(
      ids.map(async (tokenId): Promise<RarityInput> => {
        try {
          const tokenUri: string = await contract.tokenURI(tokenId);
          const metadata = await fetchNftMetadata(tokenUri);
          return { tokenId, attributes: metadata?.attributes ?? [], loaded: true };
        } catch {
          // A token we couldn't read is scored as unloaded, not dropped —
          // computeRaritySnapshot excludes unloaded tokens from the sample
          // rather than silently treating a fetch failure as "no traits".
          return { tokenId, attributes: [], loaded: false };
        }
      })
    );
    inputs.push(...batch);
  }

  return computeRaritySnapshot(inputs);
}

/** Fails closed: any error propagates rather than caching a partial/empty snapshot. */
export async function getRaritySnapshot(): Promise<RaritySnapshot> {
  if (cached) return cached.snapshot;
  if (inflight) return inflight;

  inflight = buildSnapshot()
    .then((snapshot) => {
      cached = { snapshot, at: Date.now() };
      return snapshot;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

export type CompactRarity = {
  name: string;
  tier: RarityTier;
  rank: number;
  percentile: number;
  normalizedScore: number;
};

export function compactRarityFor(
  snapshot: RaritySnapshot,
  tokenId: number
): CompactRarity | null {
  const r = snapshot.byTokenId.get(tokenId);
  if (!r) return null;
  return {
    name: r.name,
    tier: r.tier,
    rank: r.rank,
    percentile: r.percentile,
    normalizedScore: r.normalizedScore,
  };
}
