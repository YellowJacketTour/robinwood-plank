"use client";

import { useEffect, useState } from "react";
import { formatTokenAmount, parseTokenAmount } from "@/lib/trade";
import { getPoolStatus, openPool, seedShares } from "@/lib/market/vault";

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
export default function TreasuryBootstrap({ account }: Props) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof getPoolStatus>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [shareAmount, setShareAmount] = useState("");
  const [ethAmount, setEthAmount] = useState("");
  const [confirmOpen, setConfirmOpen] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionStatus, setStatusMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    getPoolStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  if (loading) {
    return <p className="text-center text-xs text-foreground/45">Reading vault state…</p>;
  }
  if (!status) {
    return <p className="text-center text-xs text-red-300">Could not read vault state.</p>;
  }
  if (status.open) {
    return (
      <p className="rounded-lg border border-emerald-500/30 bg-emerald-950/20 px-3 py-2.5 text-center text-xs text-emerald-300">
        Pool is open — bootstrap is done, this panel has nothing left to do.
      </p>
    );
  }

  const run = async (action: () => Promise<string>, label: string) => {
    setError(null);
    try {
      setBusy(true);
      setStatusMsg(label);
      await action();
      setStatusMsg("Confirmed.");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transaction failed.");
    } finally {
      setBusy(false);
      setTimeout(() => setStatusMsg(null), 3000);
    }
  };

  const canOpen = status.shareReserve > BigInt(0) && status.ethReserveWei > BigInt(0);

  return (
    <div className="space-y-3 rounded-xl border-2 border-dashed border-gold-500/40 bg-black/20 p-3">
      <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.14em] text-gold-300">
        Treasury bootstrap — only you can see this
      </p>

      <dl className="grid grid-cols-2 gap-2 text-center">
        <div className="rounded-lg border border-gold-500/20 bg-black/20 py-2">
          <dt className="text-[0.6rem] text-foreground/45">NFTs in vault</dt>
          <dd className="font-display text-lg text-gold-300">{status.heldCount.toString()}</dd>
        </div>
        <div className="rounded-lg border border-gold-500/20 bg-black/20 py-2">
          <dt className="text-[0.6rem] text-foreground/45">Your unseeded shares</dt>
          <dd className="font-display text-lg text-gold-300">
            {formatTokenAmount(status.treasuryShareBalance, 18, 2)}
          </dd>
        </div>
        <div className="rounded-lg border border-gold-500/20 bg-black/20 py-2">
          <dt className="text-[0.6rem] text-foreground/45">Pool shares (seeded)</dt>
          <dd className="font-display text-lg text-gold-300">
            {formatTokenAmount(status.shareReserve, 18, 2)}
          </dd>
        </div>
        <div className="rounded-lg border border-gold-500/20 bg-black/20 py-2">
          <dt className="text-[0.6rem] text-foreground/45">Pool ETH (seeded)</dt>
          <dd className="font-display text-lg text-gold-300">
            {formatTokenAmount(status.ethReserveWei, 18, 4)} Ξ
          </dd>
        </div>
      </dl>

      <div className="space-y-2 rounded-lg border border-gold-500/20 bg-wood-900/50 p-2.5">
        <p className="text-[0.65rem] font-bold text-foreground/60">
          Step 1 is the Deposit tab above (deposit NFTs from this wallet — you
          receive shares). Once you hold shares, seed them here:
        </p>
        <div className="flex gap-1.5">
          <input
            type="text"
            inputMode="decimal"
            placeholder="Shares to seed"
            value={shareAmount}
            onChange={(e) => setShareAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            className="min-h-10 flex-1 rounded-md border border-gold-500/30 bg-wood-950 px-2 text-xs text-foreground outline-none focus:border-gold-400"
          />
          <input
            type="text"
            inputMode="decimal"
            placeholder="ETH to seed"
            value={ethAmount}
            onChange={(e) => setEthAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            className="min-h-10 flex-1 rounded-md border border-gold-500/30 bg-wood-950 px-2 text-xs text-foreground outline-none focus:border-gold-400"
          />
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            const wei = parseTokenAmount(shareAmount, 18);
            if (wei === null || wei <= BigInt(0)) return setError("Enter a positive share amount.");
            return run(() => seedShares(account, wei, ethAmount), "Seeding…");
          }}
          className="min-h-10 w-full rounded-md bg-gold-500 text-xs font-bold text-wood-950 transition hover:bg-gold-400 disabled:opacity-50"
        >
          Seed shares + ETH
        </button>
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
