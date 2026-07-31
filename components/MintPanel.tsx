"use client";

import { useCallback, useEffect, useState } from "react";
import { formatEther } from "ethers";
import { NFT_CONTRACT_ADDRESS, ROBINHOOD_EXPLORER_URL } from "@/lib/mint-contract";
import { getMintReadClient, touchMintReadClient } from "@/lib/robinhood-provider";
import {
  ensureNftCacheHydrated,
  getCachedMintStats,
  getCachedMintStatsIfFresh,
  setCachedMintStats,
} from "@/lib/nft-cache";
import { startVisibleInterval } from "@/lib/useVisibleInterval";

const TOTAL_SUPPLY = 1542;
const COMMUNITY_SUPPLY = 777;
/** Historical fact — minting is closed forever, this can never change again. */
const ORIGINAL_PRICE_ETH = "0.01";
const MAX_PER_WALLET_WAS = 33;

type Stats = {
  total: number;
  community: number;
  free: number;
  allowlist: number;
  paid: number;
  priceWei: bigint;
  /** False until at least one successful chain read. */
  live: boolean;
};

const EMPTY_STATS: Stats = {
  total: 0,
  community: 0,
  free: 0,
  allowlist: 0,
  paid: 0,
  priceWei: BigInt(0),
  live: false,
};

/**
 * The RobinWood collection is fully minted out — 1,542 / 1,542, forever.
 * This panel keeps the live contract reads MintPanel always had (so the
 * numbers below stay honest if they were ever wrong), but there is
 * deliberately no mint form, quantity stepper, or wallet-connect-to-mint
 * flow left: DESIGN.md — "never ship a mint form that cannot succeed."
 * Every conversion path here goes to Marketplank instead.
 */
export default function MintPanel() {
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);

  const applyCachedStats = useCallback(() => {
    ensureNftCacheHydrated();
    const cached = getCachedMintStats();
    if (!cached) return false;
    setStats({
      total: cached.total,
      community: cached.community,
      free: cached.free,
      allowlist: cached.allowlist,
      paid: cached.paid,
      priceWei: BigInt(cached.priceWei || "0"),
      live: true,
    });
    return true;
  }, []);

  const loadStats = useCallback(async (forceRpc = false) => {
    try {
      if (!forceRpc) {
        const fresh = getCachedMintStatsIfFresh();
        if (fresh) {
          setStats({
            total: fresh.total,
            community: fresh.community,
            free: fresh.free,
            allowlist: fresh.allowlist,
            paid: fresh.paid,
            priceWei: BigInt(fresh.priceWei || "0"),
            live: true,
          });
          return;
        }
        applyCachedStats();
      }

      const { contract } = await getMintReadClient(forceRpc);
      const [phase, paused, total, community, free, allowlist, paid, remainingCommunity, remainingTotal, remainingPaidSupply, priceWei, communityReleased] =
        await Promise.all([
          contract.salePhase(),
          contract.paused(),
          contract.totalSupply(),
          contract.communityMintsClaimed(),
          contract.freeMintsClaimed(),
          contract.allowlistMintsClaimed(),
          contract.paidMintsClaimed(),
          contract.remainingCommunitySupply(),
          contract.remainingTotalSupply(),
          contract.remainingNonCommunitySupply(),
          contract.mintPrice(),
          contract.communitySupplyReleased(),
        ]);
      touchMintReadClient();

      setCachedMintStats({
        phase: Number(phase),
        paused: Boolean(paused),
        total: Number(total),
        community: Number(community),
        free: Number(free),
        allowlist: Number(allowlist),
        paid: Number(paid),
        remainingCommunity: Number(remainingCommunity),
        remainingTotal: Number(remainingTotal),
        remainingPaidSupply: Number(remainingPaidSupply),
        priceWei: (priceWei as bigint).toString(),
        communityReleased: Boolean(communityReleased),
      });

      setStats({
        total: Number(total),
        community: Number(community),
        free: Number(free),
        allowlist: Number(allowlist),
        paid: Number(paid),
        priceWei: priceWei as bigint,
        live: true,
      });
    } catch {
      // Keep last good live stats if we had them; otherwise fall back to the
      // known historical totals below (minting is closed, these never move).
    }
  }, [applyCachedStats]);

  useEffect(() => {
    applyCachedStats();
    const initialLoad = window.setTimeout(() => void loadStats(), 0);
    const stop = startVisibleInterval(() => void loadStats(), 60_000);
    return () => {
      window.clearTimeout(initialLoad);
      stop();
    };
  }, [loadStats, applyCachedStats]);

  const totalSupply = stats.live ? stats.total : TOTAL_SUPPLY;
  const community = stats.live ? stats.community : COMMUNITY_SUPPLY;
  const free = stats.live ? stats.free : undefined;
  const allowlist = stats.live ? stats.allowlist : undefined;
  const paid = stats.live ? stats.paid : undefined;
  const priceEth = stats.live && stats.priceWei > BigInt(0) ? formatEther(stats.priceWei) : ORIGINAL_PRICE_ETH;
  const paidAndReserve = totalSupply - community;

  return (
    <div className="wood-frame wood-grain-surface w-full rounded-2xl bg-wood-900/95 p-4 text-left shadow-2xl sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gold-500/20 pb-4">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-900/30 px-3 py-1 text-[0.65rem] font-black uppercase tracking-wide text-emerald-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
          Sold out · fully minted
        </span>
        <a
          href={`${ROBINHOOD_EXPLORER_URL}/address/${NFT_CONTRACT_ADDRESS}`}
          target="_blank"
          rel="noopener noreferrer"
          className="min-h-11 shrink-0 text-xs font-bold text-gold-300 hover:text-gold-400 sm:text-sm"
        >
          NFT contract ↗
        </a>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="rounded-lg border border-line bg-panel-strong px-3 py-2">
          <dt className="text-[0.62rem] font-extrabold uppercase tracking-[0.12em] text-cream-muted">Total supply</dt>
          <dd className="mt-0.5 font-display text-base text-cream">
            {totalSupply.toLocaleString()} / {TOTAL_SUPPLY.toLocaleString()}
          </dd>
        </div>
        <div className="rounded-lg border border-line bg-panel-strong px-3 py-2">
          <dt className="text-[0.62rem] font-extrabold uppercase tracking-[0.12em] text-cream-muted">Original price</dt>
          <dd className="mt-0.5 font-display text-base text-cream">{priceEth} ETH</dd>
        </div>
        <div className="rounded-lg border border-line bg-panel-strong px-3 py-2">
          <dt className="text-[0.62rem] font-extrabold uppercase tracking-[0.12em] text-cream-muted">Community</dt>
          <dd className="mt-0.5 font-display text-base text-cream">
            {community.toLocaleString()} / {COMMUNITY_SUPPLY.toLocaleString()}
          </dd>
        </div>
        <div className="rounded-lg border border-line bg-panel-strong px-3 py-2">
          <dt className="text-[0.62rem] font-extrabold uppercase tracking-[0.12em] text-cream-muted">Free / Wood List</dt>
          <dd className="mt-0.5 font-display text-base text-cream">
            {free != null && allowlist != null ? `${free} / ${allowlist}` : "642 / 135"}
          </dd>
        </div>
        <div className="rounded-lg border border-line bg-panel-strong px-3 py-2">
          <dt className="text-[0.62rem] font-extrabold uppercase tracking-[0.12em] text-cream-muted">Paid &amp; reserve</dt>
          <dd className="mt-0.5 font-display text-base text-cream">
            {paid != null ? paidAndReserve.toLocaleString() : (TOTAL_SUPPLY - COMMUNITY_SUPPLY).toLocaleString()}
          </dd>
        </div>
        <div className="rounded-lg border border-line bg-panel-strong px-3 py-2">
          <dt className="text-[0.62rem] font-extrabold uppercase tracking-[0.12em] text-cream-muted">Max / wallet was</dt>
          <dd className="mt-0.5 font-display text-base text-cream">{MAX_PER_WALLET_WAS}</dd>
        </div>
      </dl>

      <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-black/35">
        <div className="h-full w-full rounded-full bg-gold-500" />
      </div>
      <div className="mt-1.5 flex justify-between text-xs font-bold text-foreground/70">
        <span>{totalSupply.toLocaleString()} minted</span>
        <span>100% claimed</span>
      </div>

      <div className="mt-5 flex flex-wrap gap-2.5">
        <a
          href="/market"
          className="min-h-14 flex-1 rounded-lg bg-gold-500 px-6 py-4 text-center text-base font-extrabold text-wood-950 transition-colors hover:bg-gold-400"
        >
          Buy on the Market →
        </a>
        <a
          href="/market?tab=swap"
          className="min-h-14 flex-1 rounded-lg border border-gold-500/50 bg-wood-950/70 px-6 py-4 text-center text-base font-extrabold text-gold-300 transition-colors hover:border-gold-400"
        >
          Instant Swap
        </a>
      </div>
      <p className="mt-3 text-center text-xs text-foreground/65">
        Every Plank now trades peer-to-peer on Marketplank — verified listings only.
      </p>

      <p className="mt-3 text-xs text-foreground/45">Gas paid in ETH (Chain ID 4663).</p>
    </div>
  );
}
