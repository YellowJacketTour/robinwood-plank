"use client";

/**
 * Seed PRIMARY vault (V2): NFT image picker + ETH + open pool.
 * Image grid only for on-chain treasury wallet (seedShares is treasury-only).
 */

import { useCallback, useEffect, useState } from "react";
import {
  MARKET_FEE_RECIPIENT,
  MARKET_VAULT_ADDRESS,
  MARKET_VAULT_DUAL_MODE,
  MARKET_VAULT_LEGACY_ADDRESS,
  CHAIN,
} from "@/lib/constants";
import { shortVault } from "@/lib/market/vault-registry";
import { getVaultOnChainSnapshot } from "@/lib/market/vault";
import TreasuryBootstrap from "@/components/market/TreasuryBootstrap";
import { formatTokenAmount } from "@/lib/trade";

type Props = {
  account: string | null;
  onConnect: () => void;
};

/** On-chain treasury for V2 (immutable constructor arg) — same as MARKET_FEE_RECIPIENT. */
const TREASURY = MARKET_FEE_RECIPIENT;

export default function SeedVaultPanel({ account, onConnect }: Props) {
  const primary = MARKET_VAULT_ADDRESS;
  const [open, setOpen] = useState<boolean | null>(null);
  const [held, setHeld] = useState(0);
  const [eth, setEth] = useState("0");
  const [poolSh, setPoolSh] = useState("0");
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!primary) return;
    try {
      const s = await getVaultOnChainSnapshot(primary, account);
      setOpen(s.poolOpen);
      setHeld(s.held);
      setEth(formatTokenAmount(s.ethReserve, 18, 5));
      setPoolSh(formatTokenAmount(s.shareReserve, 18, 4));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not read primary vault");
    }
  }, [primary, account]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 12_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!primary) return null;
  if (open === true) return null;

  const treasury = TREASURY;
  const isTreasury =
    Boolean(account) && account!.toLowerCase() === treasury.toLowerCase();

  return (
    <div
      id="seed-v2"
      className="wood-frame space-y-3 scroll-mt-24 overflow-hidden rounded-2xl border-2 border-gold-400/50 bg-wood-900/95 p-4 sm:p-5"
    >
      <div>
        <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.18em] text-gold-300">
          Seed new vault (treasury) · same UI as last time
        </p>
        <h3 className="mt-1 font-display text-xl text-gold-200">
          Tap NFTs → deposit &amp; seed ETH
        </h3>
        <p className="mt-2 text-sm text-foreground/75">
          Image picker + starting ETH only appear when the{" "}
          <strong className="text-gold-300">treasury</strong> wallet is connected (same as V1). Scroll
          to this gold card on <strong>Instant Swap</strong>.
        </p>
      </div>

      <div className="rounded-lg border border-gold-500/25 bg-wood-950/90 px-3 py-2 font-mono text-[0.7rem] text-gold-200/90">
        <a
          href={`${CHAIN.blockExplorers.default.url}/address/${primary}`}
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          {primary}
        </a>
        <p className="mt-1 text-foreground/55">
          held {held} · pool shares {poolSh} · ethReserve {eth} Ξ · poolOpen{" "}
          {open === null ? "…" : String(open)}
          {MARKET_VAULT_DUAL_MODE ? " · dual mode on" : ""}
        </p>
        <p className="mt-1 text-foreground/45">
          treasury (required): {shortVault(treasury)}
          {account ? (
            <>
              {" · "}
              you: {shortVault(account)}
              {isTreasury ? " ✓" : " ✗ not treasury"}
            </>
          ) : (
            " · you: not connected"
          )}
        </p>
      </div>

      {!account && (
        <div className="space-y-2">
          <p className="text-sm text-foreground/70">
            Connect treasury{" "}
            <code className="rounded bg-wood-950/90 px-1 font-mono text-xs break-all">{treasury}</code>
          </p>
          <button
            type="button"
            onClick={onConnect}
            className="min-h-11 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950 hover:bg-gold-400"
          >
            Connect treasury wallet to seed
          </button>
        </div>
      )}

      {account && !isTreasury && (
        <div className="space-y-2 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-3 text-sm text-amber-50/95">
          <p className="font-bold text-amber-100">Wrong wallet for seed UI</p>
          <p>
            Connected:{" "}
            <code className="break-all font-mono text-xs">{account}</code>
          </p>
          <p>
            Need treasury:{" "}
            <code className="break-all font-mono text-xs">{treasury}</code>
          </p>
          <p className="text-[0.8rem] text-amber-50/80">
            In Rabby, switch to the treasury account (same one that seeded V1), then reconnect. The NFT
            image grid only unlocks for that address because <code className="font-mono">seedShares</code>{" "}
            is treasury-only on-chain.
          </p>
          <button
            type="button"
            onClick={onConnect}
            className="min-h-11 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950"
          >
            Reconnect as treasury
          </button>
        </div>
      )}

      {account && isTreasury && (
        <div className="space-y-2">
          <p className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2 py-1.5 text-xs text-emerald-100/90">
            Treasury connected ✓ — pick planks below, ETH is auto-filled from recent sales × count (or
            use manual entry).
          </p>
          <TreasuryBootstrap account={account} />
        </div>
      )}

      {err && <p className="text-xs text-red-300">{err}</p>}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => void refresh()}
          className="text-[0.65rem] font-bold text-foreground/45 underline"
        >
          Refresh vault status
        </button>
        {MARKET_VAULT_LEGACY_ADDRESS && (
          <span className="text-[0.65rem] text-foreground/35">
            Legacy V1 stays at {shortVault(MARKET_VAULT_LEGACY_ADDRESS)}
          </span>
        )}
      </div>
    </div>
  );
}
