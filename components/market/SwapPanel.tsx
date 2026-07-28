"use client";

import { useState } from "react";
import { MARKET_VAULT_ADDRESS } from "@/lib/constants";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import {
  buyShares,
  depositForShares,
  requestRandomRedeem,
  redeemTarget,
  sellShares,
} from "@/lib/market/vault";
import { connectWallet, ensureRobinhoodChain } from "@/lib/wallet";
import { parseTokenAmount } from "@/lib/trade";

type Mode = "buy" | "sell" | "deposit" | "redeem";

const MODES: { id: Mode; label: string }[] = [
  { id: "buy", label: "Buy" },
  { id: "sell", label: "Sell" },
  { id: "deposit", label: "Deposit" },
  { id: "redeem", label: "Redeem" },
];

/**
 * Phase 2 — NFTX-style vault buy/sell. Fully wired against
 * contracts/MarketplankVault.sol's ABI (lib/market/vault.ts). Renders a
 * scoped notice instead of this UI until MARKET_VAULT_ADDRESS is set, which
 * doesn't happen until the vault is deployed and audited (SPEC.md §7).
 */
export default function SwapPanel() {
  const collection = MARKET_COLLECTIONS[0];
  const hasVault = MARKET_VAULT_ADDRESS !== null;

  const [mode, setMode] = useState<Mode>("buy");
  const [account, setAccount] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [tokenId, setTokenId] = useState("");
  /** Max slippage, percent. Converted to bps; vault trades REFUSE min-out of 0. */
  const [slippagePct, setSlippagePct] = useState("1");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!hasVault) {
    return (
      <p className="rounded-lg border border-dashed border-gold-500/30 bg-wood-900/40 px-4 py-8 text-center text-sm text-foreground/60">
        The workshop isn't open yet — instant swap unlocks once the vault is stocked for {collection?.name ?? "a collection"}.
      </p>
    );
  }

  const handleConnect = async () => {
    setError(null);
    try {
      const addr = await connectWallet();
      await ensureRobinhoodChain();
      setAccount(addr);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect wallet.");
    }
  };

  const run = async (action: () => Promise<string>, label: string) => {
    setError(null);
    if (!account) {
      await handleConnect();
      return;
    }
    try {
      setBusy(true);
      setStatus(label);
      await action();
      setStatus("Confirmed.");
      setAmount("");
      setTokenId("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transaction failed.");
    } finally {
      setBusy(false);
      setTimeout(() => setStatus(null), 3000);
    }
  };

  /** "1" → 100 bps; null when unparseable/out of range (fail closed). */
  const slippageBps = (() => {
    const pct = Number(slippagePct);
    if (!Number.isFinite(pct) || pct < 0 || pct >= 100) return null;
    return Math.round(pct * 100);
  })();

  const submit = () => {
    if (!account) return; // run() reconnects, but every path below needs it typed
    if (mode === "buy" || mode === "sell") {
      if (slippageBps === null) return setError("Enter a slippage between 0 and 99%.");
    }
    if (mode === "buy") {
      if (!amount) return setError("Enter an ETH amount.");
      return run(() => buyShares(account, amount, slippageBps as number), "Buying…");
    }
    if (mode === "sell") {
      const wei = parseTokenAmount(amount, 18);
      if (wei === null || wei <= BigInt(0)) return setError("Enter a share amount.");
      return run(() => sellShares(account, wei, slippageBps as number), "Selling…");
    }
    if (mode === "deposit") {
      if (!tokenId) return setError("Enter a token ID.");
      return run(() => depositForShares(account, tokenId), "Depositing…");
    }
    // redeem
    if (tokenId) return run(() => redeemTarget(account, tokenId), "Redeeming (targeted)…");
    // FLAGGED (drand rework): this is only STEP 1 of the random redemption.
    // It burns the shares and anchors the draw to a drand round ~3-6s in the
    // future; the NFT arrives only after a second claimRandomRedeem() call,
    // once anyone relays that round. This still calls the correct entry point
    // (the old redeemRandom() did not exist and always reverted), but the UI
    // owes a "waiting for drand round N" state and a claim button. See
    // lib/market/vault.ts for the full flow.
    return run(
      () => requestRandomRedeem(account),
      "Requesting random redeem (claim in a few seconds)…"
    );
  };

  return (
    <div className="wood-ledger space-y-3 p-3">
      <div className="grid grid-cols-4 gap-1 rounded-lg border border-gold-500/20 bg-wood-900/50 p-1">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setMode(m.id)}
            className={`min-h-9 rounded-md text-xs font-bold uppercase transition-colors ${
              mode === m.id ? "bg-gold-500 text-wood-950" : "text-foreground/65 hover:text-gold-300"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {(mode === "buy" || mode === "sell") && (
        <div className="flex min-h-12 items-center gap-2 rounded-lg border border-gold-500/30 bg-wood-900/70 px-2.5">
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            className="min-w-0 flex-1 bg-transparent py-2.5 text-lg font-semibold text-foreground outline-none"
          />
          <span className="text-xs font-bold text-gold-300">{mode === "buy" ? "ETH" : "SHARE"}</span>
        </div>
      )}

      {(mode === "buy" || mode === "sell") && (
        <label className="flex items-center justify-between gap-2 rounded-lg border border-gold-500/20 bg-wood-900/50 px-2.5 py-2">
          <span className="text-[0.7rem] text-foreground/60">Max slippage</span>
          <span className="flex items-center gap-1">
            <input
              type="text"
              inputMode="decimal"
              value={slippagePct}
              onChange={(e) => setSlippagePct(e.target.value.replace(/[^0-9.]/g, ""))}
              className="w-14 rounded-md border border-gold-500/30 bg-wood-950 px-1.5 py-1 text-right text-xs text-foreground outline-none focus:border-gold-400"
              aria-label="Max slippage percent"
            />
            <span className="text-xs font-bold text-gold-300">%</span>
          </span>
        </label>
      )}

      {(mode === "deposit" || mode === "redeem") && (
        <input
          type="text"
          inputMode="numeric"
          placeholder={mode === "redeem" ? "Token ID (blank = random)" : "Token ID"}
          value={tokenId}
          onChange={(e) => setTokenId(e.target.value.replace(/[^0-9]/g, ""))}
          className="min-h-12 w-full rounded-lg border border-gold-500/30 bg-wood-900/70 px-2.5 text-foreground outline-none focus:border-gold-400"
        />
      )}

      {!account ? (
        <button
          type="button"
          onClick={handleConnect}
          className="min-h-12 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950 transition hover:bg-gold-400"
        >
          Connect wallet
        </button>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={submit}
          className="min-h-12 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950 transition hover:bg-gold-400 disabled:opacity-50"
        >
          {busy ? (status ?? "Working…") : MODES.find((m) => m.id === mode)?.label}
        </button>
      )}

      {error && (
        <p className="text-center text-xs text-red-300" role="alert">
          {error}
        </p>
      )}
      {status && !error && (
        <p className="text-center text-xs text-forest-600" role="status">
          {status}
        </p>
      )}
    </div>
  );
}
