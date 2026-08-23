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
import { reserveProviderCapacity, settleProviderCapacity, utcDayWindow } from "@/lib/market/multichain/control-plane";
import { preferHighestResImageUrl } from "@/lib/market/collection-art";
import { hydrateBitcoinArt } from "@/lib/market/multichain/discovery/bitcoin-art-rotator";
import { runCoinGeckoNftStats } from "@/lib/market/multichain/discovery/coingecko-nft-stats";

/** Matches source-budget.ts's own DAILY_CEILING["magiceden-solana"] exactly. */
const ME_DAILY_ALLOWANCE = 2_000;

export type HydrateAllArtResult = {
  bitcoin: Awaited<ReturnType<typeof hydrateBitcoinArt>>;
  solana: { matched: number; updated: number };
  evmCg: Record<string, { updated: number; skipReason?: string }>;
};

type MeRow = { collectionSymbol?: string; name?: string | null; image?: string | null; cohort?: string | null };

/**
 * REAL BUG FIXED 2026-08-23: this previously fetched exactly one page
 * (limit=250, no offset) every call, forever -- hardcoded to whatever the
 * top 250 Solana collections by 1-day volume happened to be, so Solana
 * discovery could never grow past that fixed window no matter how many
 * times the supervisor loop ran. Confirmed live the endpoint DOES support
 * real offset pagination (offset=250 returns a genuinely different page,
 * not a repeat) -- there was never a real reason for the single-page cap.
 * PAGE_LIMIT below is the number of collections requested per page, not a
 * cap on how many pages are walked; the loop below walks with a real
 * offset until a short/empty page, so it converges toward the full ranked
 * catalog rather than a fixed top-250 slice.
 */
const PAGE_LIMIT = 250;

export async function hydrateSolanaFromMagicEden(): Promise<{ matched: number; updated: number }> {
  const src = "magiceden-solana";
  if (!checkSourceBudget(src).allowed) return { matched: 0, updated: 0 };

  let matched = 0;
  let updated = 0;
  let offset = 0;

  for (;;) {
    const window = utcDayWindow(ME_DAILY_ALLOWANCE);
    const account = "magiceden-solana:default";
    if (!(await reserveProviderCapacity(account, window))) break;

    let entries: MeRow[] = [];
    let settled = false;
    try {
      const res = await fetch(
        `https://stats-mainnet.magiceden.io/collection_stats/search/all?window=1d&limit=${PAGE_LIMIT}&offset=${offset}&sort=volume&direction=desc`,
        { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) }
      );
      await settleProviderCapacity(account, window, 1, true);
      settled = true;
      if (res.status === 429 || res.status === 403) {
        recordSourceFailure(src, true);
        break;
      }
      if (!res.ok) {
        recordSourceFailure(src, false);
        break;
      }
      recordSourceSuccess(src);
      entries = (await res.json()) as MeRow[];
    } catch {
      if (!settled) await settleProviderCapacity(account, window, 1, true).catch(() => {});
      recordSourceFailure(src, false);
      break;
    }

    if (entries.length === 0) break;
    offset += entries.length;

    const pageResult = await applyMagicEdenPage(entries);
    matched += pageResult.matched;
    updated += pageResult.updated;

    if (entries.length < PAGE_LIMIT) break;
    if (!checkSourceBudget(src).allowed) break;
  }

  return { matched, updated };
}

async function applyMagicEdenPage(entries: MeRow[]): Promise<{ matched: number; updated: number }> {
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
