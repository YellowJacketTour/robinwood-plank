/**
 * All-chain collection art hydrate. One jailed source never stops the rest.
 *
 * Solana: Magic Eden stats-search (keyless, has `image`) exact symbol match.
 * Bitcoin: OrdinalsWallet + CoinGecko rotator.
 * EVM: OpenSea display already writes images in opensea-stats; this pass
 * only fills remaining via CoinGecko exact contract when OS is jailed/404.
 */
import { updateCollectionDisplay, upsertTrackedCollection } from "@/lib/market/multichain/store";
import { checkSourceBudget, recordSourceSuccess, recordSourceFailure } from "@/lib/market/multichain/discovery/source-budget";
import { preferHighestResImageUrl } from "@/lib/market/collection-art";
import { hydrateBitcoinArt } from "@/lib/market/multichain/discovery/bitcoin-art-rotator";
import { runCoinGeckoNftStats } from "@/lib/market/multichain/discovery/coingecko-nft-stats";

export type HydrateAllArtResult = {
  bitcoin: Awaited<ReturnType<typeof hydrateBitcoinArt>>;
  solana: { matched: number; updated: number };
  evmCg: Record<string, { updated: number; skipReason?: string }>;
};

type MeRow = { collectionSymbol?: string; name?: string | null; image?: string | null; cohort?: string | null };

async function hydrateSolanaFromMagicEden(): Promise<{ matched: number; updated: number }> {
  const src = "magiceden-solana";
  if (!checkSourceBudget(src).allowed) return { matched: 0, updated: 0 };
  let entries: MeRow[] = [];
  try {
    const res = await fetch(
      "https://stats-mainnet.magiceden.io/collection_stats/search/all?window=1d&limit=250&sort=volume&direction=desc",
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) }
    );
    if (res.status === 429 || res.status === 403) {
      recordSourceFailure(src, true);
      return { matched: 0, updated: 0 };
    }
    if (!res.ok) {
      recordSourceFailure(src, false);
      return { matched: 0, updated: 0 };
    }
    recordSourceSuccess(src);
    entries = (await res.json()) as MeRow[];
  } catch {
    recordSourceFailure(src, false);
    return { matched: 0, updated: 0 };
  }

  let matched = 0;
  let updated = 0;
  for (const row of entries) {
    const symbol = row.collectionSymbol;
    if (!symbol) continue;
    if (row.cohort && row.cohort !== "solana") continue;
    matched += 1;
    await upsertTrackedCollection({
      chainSlug: "solana-mainnet",
      chainId: null,
      contractAddress: symbol,
      adapter: "magiceden-solana",
    });
    const imageUrl = preferHighestResImageUrl(row.image);
    const name = row.name?.trim() || null;
    if (!imageUrl && !name) continue;
    await updateCollectionDisplay("solana-mainnet", symbol, { name, imageUrl });
    updated += 1;
  }
  return { matched, updated };
}

const EVM_CG = [
  "eth-mainnet",
  "polygon-mainnet",
  "base-mainnet",
  "arb-mainnet",
  "opt-mainnet",
  "bnb-mainnet",
  "avax-mainnet",
] as const;

export async function hydrateAllCollectionArt(): Promise<HydrateAllArtResult> {
  const bitcoin = await hydrateBitcoinArt(40);
  const solana = await hydrateSolanaFromMagicEden();
  const evmCg: HydrateAllArtResult["evmCg"] = {};
  for (const chain of EVM_CG) {
    try {
      const r = await runCoinGeckoNftStats(chain, 8);
      evmCg[chain] = { updated: r.updated, skipReason: r.skipReason };
    } catch (e) {
      evmCg[chain] = { updated: 0, skipReason: e instanceof Error ? e.message : String(e) };
    }
  }
  try {
    const solCg = await runCoinGeckoNftStats("solana-mainnet", 8);
    evmCg["solana-mainnet"] = { updated: solCg.updated, skipReason: solCg.skipReason };
  } catch (e) {
    evmCg["solana-mainnet"] = { updated: 0, skipReason: e instanceof Error ? e.message : String(e) };
  }
  return { bitcoin, solana, evmCg };
}
