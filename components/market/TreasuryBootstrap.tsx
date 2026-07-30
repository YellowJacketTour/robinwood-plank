"use client";

import { useEffect, useState } from "react";
import { formatTokenAmount, parseTokenAmount } from "@/lib/trade";
import { depositForShares, getPoolStatus, openPool, seedShares } from "@/lib/market/vault";
import { getAvgSalePriceWei } from "@/lib/market/pricing";
import { getOwnedInventory } from "@/lib/market/inventory";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import TokenPicker, { type PickerToken } from "@/components/market/TokenPicker";

type Props = {
  account: string;
};

/**
 * Treasury-only bootstrap panel — only ever rendered when the connected
 * wallet matches the vault's own on-chain treasury() (checked here AND
 * enforced on-chain by every function it calls; this component is a
 * convenience, not the security boundary). Walks the exact three-step
 * sequence documented in contracts/MarketplankVault.sol: deposit NFTs (use
 * the Deposit tab above — same public deposit() everyone uses), seed
 * shares+ETH atomically, then open the pool once, forever.
 */
// Module-level so switching tabs away and back (which unmounts this) still
// paints instantly instead of flashing "Reading vault state…" again. Short
// TTL and always-bypassed after an actual seed/open action (`refresh(true)`
// below) — this drives real financial decisions, so the moment right after
// you take an action is exactly when stale data would be actively
// misleading about whether it actually landed.
let cachedStatus: Awaited<ReturnType<typeof getPoolStatus>> | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 15_000;

export default function TreasuryBootstrap({ account }: Props) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof getPoolStatus>> | null>(
    cachedStatus
  );
  const [loading, setLoading] = useState(!cachedStatus);
  const [shareAmount, setShareAmount] = useState("");
  const [ethAmount, setEthAmount] = useState("");
  const [confirmOpen, setConfirmOpen] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionStatus, setStatusMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualMode, setManualMode] = useState(false);

  // Tap-to-select flow: pick NFTs still in your wallet, deposit + seed them
  // in one guided action instead of typing a share count by hand. Typing it
  // by hand is exactly what caused a real "insufficient funds" failure —
  // deposit fees mean you never hold a clean round number of shares, so a
  // manually-typed "3" almost never matches your actual balance.
  const [ownedTokens, setOwnedTokens] = useState<PickerToken[]>([]);
  const [ownedLoading, setOwnedLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [avgPriceWei, setAvgPriceWei] = useState<bigint | null>(null);
  const [depositSeedBusy, setDepositSeedBusy] = useState(false);
  const [depositSeedStep, setDepositSeedStep] = useState<string | null>(null);

  const loadOwned = (force = true) => {
    setOwnedLoading(true);
    // Always force-refresh for treasury seed — empty inventory cache was hiding
    // planks that still sit in the treasury wallet (confirmed on-chain).
    getOwnedInventory(MARKET_COLLECTIONS, account, { force })
      .then((inv) => {
        const items = inv.flatMap((g) => g.items).map((i) => ({ tokenId: i.tokenId, imageUrl: i.imageUrl }));
        setOwnedTokens(items);
      })
      .catch(() => setOwnedTokens([]))
      .finally(() => setOwnedLoading(false));
  };

  useEffect(() => {
    loadOwned();
    getAvgSalePriceWei()
      .then((p) => {
        setAvgPriceWei(p);
        // Sensible default if user hasn't typed ETH yet (~0.01 Ξ/plank when no sales)
        if (p == null && !ethAmount) setEthAmount("0.02");
      })
      .catch(() => {
        setAvgPriceWei(null);
        if (!ethAmount) setEthAmount("0.02");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  const toggleOwned = (tokenId: string) => {
    if (depositSeedBusy) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(tokenId)) next.delete(tokenId);
      else next.add(tokenId);
      return next;
    });
  };

  // Auto-suggest ETH from avg sale × count when selection changes (user can edit).
  useEffect(() => {
    if (selectedIds.size === 0) return;
    if (avgPriceWei != null) {
      const wei = avgPriceWei * BigInt(selectedIds.size);
      setEthAmount(formatTokenAmount(wei, 18, 6));
    } else if (!ethAmount || ethAmount === "0") {
      // Fallback: 0.01 ETH per selected plank
      setEthAmount((0.01 * selectedIds.size).toFixed(4));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds.size, avgPriceWei]);

  /** ETH wei to seed: typed field wins; else avg×n; else 0.01×n */
  const resolveSeedEthWei = (): bigint | null => {
    const typed = parseTokenAmount(ethAmount, 18);
    if (typed != null && typed > BigInt(0)) return typed;
    if (avgPriceWei != null && selectedIds.size > 0) {
      return avgPriceWei * BigInt(selectedIds.size);
    }
    if (selectedIds.size > 0) {
      // 0.01 ether per plank
      return BigInt(selectedIds.size) * BigInt("10000000000000000");
    }
    return null;
  };

  const ethPreviewWei = resolveSeedEthWei();

  const refresh = (force = false) => {
    if (!force && cachedStatus && Date.now() - cachedAt < CACHE_TTL_MS) return;
    setLoading(!cachedStatus);
    getPoolStatus()
      .then((next) => {
        cachedStatus = next;
        cachedAt = Date.now();
        setStatus(next);
      })
      .catch(() => {
        if (!cachedStatus) setStatus(null);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  // Pool already live — hide bootstrap entirely (no leftover banner).
  if (status?.open) {
    return null;
  }

  if (loading || !status) {
    return (
      <div className="rounded-xl border border-line bg-panel-strong p-4 text-sm text-foreground/70">
        Loading seed interface (NFT picker + ETH)…
      </div>
    );
  }

  const run = async (action: () => Promise<string>, label: string) => {
    setError(null);
    try {
      setBusy(true);
      setStatusMsg(label);
      await action();
      setStatusMsg("Confirmed.");
      refresh(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transaction failed.");
    } finally {
      setBusy(false);
      setTimeout(() => setStatusMsg(null), 3000);
    }
  };

  const depositAndSeed = async () => {
    setError(null);
    if (selectedIds.size === 0) return setError("Tap at least one NFT to seed.");
    const ethWei = resolveSeedEthWei();
    if (ethWei == null || ethWei <= BigInt(0)) {
      return setError("Enter ETH to pair (e.g. 0.02). Sales-based price was unavailable.");
    }
    try {
      setDepositSeedBusy(true);
      const ids = Array.from(selectedIds);
      for (let i = 0; i < ids.length; i += 1) {
        setDepositSeedStep(`Depositing #${ids[i]} (${i + 1}/${ids.length})…`);
        await depositForShares(account, ids[i]);
      }
      // REAL post-deposit balance (mint fee makes hand-typed shares wrong)
      setDepositSeedStep("Reading your real share balance…");
      refresh(true);
      const fresh = await getPoolStatus();
      cachedStatus = fresh;
      cachedAt = Date.now();
      setStatus(fresh);
      const realShares = fresh.treasuryShareBalance;
      if (realShares <= BigInt(0)) {
        throw new Error(
          "Deposits landed but no shares yet — wait a few seconds, then use “Seed all my unseeded shares + ETH” below."
        );
      }
      setDepositSeedStep("Seeding shares + ETH into the pool…");
      const ethString = formatTokenAmount(ethWei, 18, 18);
      await seedShares(account, realShares, ethString);
      setDepositSeedStep(null);
      setStatusMsg(
        `Deposited ${ids.length} and seeded ${formatTokenAmount(realShares, 18, 4)} shares + ${formatTokenAmount(ethWei, 18, 5)} Ξ.`
      );
      setSelectedIds(new Set());
      loadOwned();
      refresh(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Deposit + seed failed.");
    } finally {
      setDepositSeedBusy(false);
      setDepositSeedStep(null);
      setTimeout(() => setStatusMsg(null), 5000);
    }
  };

  /** Deposit selected NFTs only (no seed) — if ETH pricing blocked you before. */
  const depositOnly = async () => {
    setError(null);
    if (selectedIds.size === 0) return setError("Tap at least one NFT.");
    try {
      setDepositSeedBusy(true);
      const ids = Array.from(selectedIds);
      for (let i = 0; i < ids.length; i += 1) {
        setDepositSeedStep(`Depositing #${ids[i]} (${i + 1}/${ids.length})…`);
        await depositForShares(account, ids[i]);
      }
      setStatusMsg(`Deposited ${ids.length}. Now set ETH and seed unseeded shares.`);
      setSelectedIds(new Set());
      loadOwned();
      refresh(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Deposit failed.");
    } finally {
      setDepositSeedBusy(false);
      setDepositSeedStep(null);
    }
  };

  /** Seed ALL unseeded treasury shares + typed ETH (after deposit, or re-seed). */
  const seedUnseeded = async () => {
    setError(null);
    const ethWei = parseTokenAmount(ethAmount, 18);
    if (ethWei == null || ethWei <= BigInt(0)) {
      return setError("Enter ETH amount to seed (e.g. 0.02).");
    }
    try {
      setDepositSeedBusy(true);
      setDepositSeedStep("Reading share balance…");
      const fresh = await getPoolStatus();
      const realShares = fresh.treasuryShareBalance;
      if (realShares <= BigInt(0)) {
        throw new Error("No unseeded shares — deposit NFTs first.");
      }
      setDepositSeedStep("Seeding…");
      await seedShares(account, realShares, formatTokenAmount(ethWei, 18, 18));
      setStatusMsg(`Seeded ${formatTokenAmount(realShares, 18, 4)} shares + ETH.`);
      refresh(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Seed failed.");
    } finally {
      setDepositSeedBusy(false);
      setDepositSeedStep(null);
    }
  };

  const canOpen = status.shareReserve > BigInt(0) && status.ethReserveWei > BigInt(0);

  return (
    <div className="space-y-3 rounded-xl border border-line bg-panel-strong p-3">
      <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.14em] text-gold-300">
        Treasury bootstrap — only you can see this
      </p>

      <dl className="grid grid-cols-2 gap-2 text-center">
        <div className="rounded-lg border border-line bg-panel-strong py-2">
          <dt className="text-[0.6rem] text-foreground/45">NFTs in vault</dt>
          <dd className="font-display text-lg text-gold-300">{status.heldCount.toString()}</dd>
        </div>
        <div className="rounded-lg border border-line bg-panel-strong py-2">
          <dt className="text-[0.6rem] text-foreground/45">Your unseeded shares</dt>
          <dd className="font-display text-lg text-gold-300">
            {formatTokenAmount(status.treasuryShareBalance, 18, 2)}
          </dd>
        </div>
        <div className="rounded-lg border border-line bg-panel-strong py-2">
          <dt className="text-[0.6rem] text-foreground/45">Pool shares (seeded)</dt>
          <dd className="font-display text-lg text-gold-300">
            {formatTokenAmount(status.shareReserve, 18, 2)}
          </dd>
        </div>
        <div className="rounded-lg border border-line bg-panel-strong py-2">
          <dt className="text-[0.6rem] text-foreground/45">Pool ETH (seeded)</dt>
          <dd className="font-display text-lg text-gold-300">
            {formatTokenAmount(status.ethReserveWei, 18, 4)} Ξ
          </dd>
        </div>
      </dl>

      <div className="space-y-2 rounded-lg border border-line bg-panel p-2.5">
        <p className="text-[0.65rem] font-bold text-foreground/60">
          1) Tap planks to deposit. 2) Set ETH below (editable). 3) Deposit &amp; seed.
          {avgPriceWei != null
            ? ` Suggested from avg sale ~${formatTokenAmount(avgPriceWei, 18, 5)} Ξ each.`
            : " Sales avg unavailable — type ETH yourself (default ~0.01 Ξ per plank)."}
        </p>

        <div className="flex items-center justify-between gap-2">
          <p className="text-[0.6rem] text-foreground/45">
            {ownedLoading
              ? "Loading wallet NFTs…"
              : ownedTokens.length > 0
                ? `${ownedTokens.length} plank(s) in this wallet`
                : "No planks listed — try reload"}
          </p>
          <button
            type="button"
            disabled={ownedLoading || depositSeedBusy}
            onClick={() => loadOwned(true)}
            className="text-[0.65rem] font-bold text-gold-300 underline disabled:opacity-40"
          >
            Reload NFTs from chain
          </button>
        </div>
        <TokenPicker
          tokens={ownedTokens}
          loading={ownedLoading}
          selected={Array.from(selectedIds)}
          onSelect={toggleOwned}
          allowManualEntry={false}
          emptyMessage="No undeposited RobinWood tokens found. They are still in your wallet if deposit never confirmed — tap Reload NFTs."
        />
        {selectedIds.size > 0 && (
          <div className="flex flex-wrap gap-1">
            {Array.from(selectedIds).map((id) => (
              <span
                key={id}
                className="rounded-full border border-line-strong bg-gold-500/15 px-2 py-0.5 text-[0.65rem] font-bold text-gold-300"
              >
                #{id}
              </span>
            ))}
          </div>
        )}

        <label className="block text-[0.65rem] font-bold text-foreground/50">
          ETH to seed into the pool (required — edit freely)
          <input
            type="text"
            inputMode="decimal"
            placeholder="e.g. 0.02"
            value={ethAmount}
            onChange={(e) => setEthAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            className="mt-1 min-h-11 w-full rounded-md border border-line-strong bg-wood-950 px-3 font-mono text-sm font-bold text-gold-300 outline-none focus:border-gold-400"
          />
        </label>
        <p className="text-[0.6rem] text-foreground/45">
          {selectedIds.size} selected
          {ethPreviewWei != null
            ? ` · will send ${formatTokenAmount(ethPreviewWei, 18, 5)} Ξ with seedShares`
            : " · enter ETH above"}
        </p>

        <button
          type="button"
          disabled={depositSeedBusy || selectedIds.size === 0}
          onClick={() => void depositAndSeed()}
          className="min-h-11 w-full rounded-md bg-gold-500 text-xs font-bold text-wood-950 transition hover:bg-gold-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {depositSeedBusy
            ? depositSeedStep ?? "Working…"
            : `Deposit ${selectedIds.size || ""} & seed (shares + ETH)`}
        </button>

        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            disabled={depositSeedBusy || selectedIds.size === 0}
            onClick={() => void depositOnly()}
            className="min-h-10 rounded-md border border-line-strong text-[0.65rem] font-bold text-gold-200 disabled:opacity-40"
          >
            Deposit only (no seed)
          </button>
          <button
            type="button"
            disabled={depositSeedBusy || status.treasuryShareBalance <= BigInt(0)}
            onClick={() => void seedUnseeded()}
            className="min-h-10 rounded-md border border-line-strong text-[0.65rem] font-bold text-gold-200 disabled:opacity-40"
          >
            Seed unseeded shares + ETH
          </button>
        </div>

        <button
          type="button"
          onClick={() => setManualMode((v) => !v)}
          className="text-[0.65rem] font-bold text-foreground/45 underline decoration-dotted hover:text-gold-300"
        >
          {manualMode ? "Hide advanced share amount" : "Advanced: custom share amount"}
        </button>

        {manualMode && (
          <div className="space-y-2 border-t border-line pt-2">
            <p className="text-[0.6rem] text-foreground/45">
              Prefer &quot;Seed unseeded shares + ETH&quot; — it uses your exact balance after mint fees.
              Only type shares if you know the exact wei amount.
            </p>
            <input
              type="text"
              inputMode="decimal"
              placeholder="Exact shares (optional override)"
              value={shareAmount}
              onChange={(e) => setShareAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              className="min-h-10 w-full rounded-md border border-line bg-wood-950 px-2 text-xs text-foreground outline-none focus:border-gold-400"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const wei = parseTokenAmount(shareAmount, 18);
                if (wei === null || wei <= BigInt(0)) return setError("Enter a positive share amount.");
                if (!ethAmount) return setError("Enter ETH above.");
                return run(() => seedShares(account, wei, ethAmount), "Seeding…");
              }}
              className="min-h-10 w-full rounded-md border border-line-strong text-xs font-bold text-gold-300 transition hover:border-gold-400 disabled:opacity-50"
            >
              Seed custom shares + ETH
            </button>
          </div>
        )}
      </div>

      <div className="space-y-2 rounded-lg border border-red-500/30 bg-red-950/10 p-2.5">
        <p className="text-[0.65rem] font-bold text-red-200">
          Step 3 — opening is one-way and permanent. The moment this lands,
          trading is public forever and seeding is closed forever, for
          everyone, including you.
        </p>
        {!canOpen && (
          <p className="text-[0.65rem] text-foreground/45">
            Needs a non-zero pool on both sides (seed shares + ETH above)
            before this unlocks.
          </p>
        )}
        <input
          type="text"
          placeholder='Type "OPEN" to confirm'
          value={confirmOpen}
          onChange={(e) => setConfirmOpen(e.target.value)}
          disabled={!canOpen}
          className="min-h-10 w-full rounded-md border border-red-500/30 bg-wood-950 px-2 text-xs text-foreground outline-none focus:border-red-400 disabled:opacity-40"
        />
        <button
          type="button"
          disabled={busy || !canOpen || confirmOpen !== "OPEN"}
          onClick={() => run(() => openPool(account), "Opening pool (permanent)…")}
          className="min-h-10 w-full rounded-md bg-red-500 text-xs font-bold text-white transition hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Open pool — permanent
        </button>
      </div>

      {error && (
        <p className="text-center text-xs text-red-300" role="alert">
          {error}
        </p>
      )}
      {actionStatus && !error && (
        <p className="text-center text-xs text-forest-600" role="status">
          {actionStatus}
        </p>
      )}
    </div>
  );
}
