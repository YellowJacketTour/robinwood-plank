"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { MARKET_FEE_RECIPIENT, MARKET_VAULT_ADDRESS } from "@/lib/constants";
import TreasuryBootstrap from "@/components/market/TreasuryBootstrap";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import {
  buyShares,
  depositForShares,
  quoteBuyShares,
  quoteSellShares,
  requestRandomRedeem,
  redeemTarget,
  sellShares,
} from "@/lib/market/vault";
import { formatTokenAmount, parseTokenAmount } from "@/lib/trade";
import { tierColor } from "@/lib/market/rarityClient";
import type { RarityTier } from "@/lib/market/rarityClient";
import { getOwnedInventory } from "@/lib/market/inventory";
import TokenPicker, { type PickerToken } from "@/components/market/TokenPicker";
import { addPendingVaultTx } from "@/lib/market/pendingVaultTx";

type Mode = "buy" | "sell" | "deposit" | "redeem";

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "buy", label: "Buy", hint: "ETH → share" },
  { id: "sell", label: "Sell", hint: "share → ETH" },
  { id: "deposit", label: "Deposit", hint: "NFT → share" },
  { id: "redeem", label: "Redeem", hint: "share → NFT" },
];

type TokenPreview = {
  image: string | null;
  rarity: { tier: string; rank: number } | null;
} | null;

/** Live look-up used only to render a visual preview of the token the user
 * typed — never affects the transaction itself, which is validated on-chain
 * regardless. Debounced so every keystroke doesn't fire a request. */
function useTokenPreview(tokenId: string): { preview: TokenPreview; loading: boolean } {
  const [preview, setPreview] = useState<TokenPreview>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!tokenId) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      fetch(`/api/market/token?tokenId=${encodeURIComponent(tokenId)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (cancelled) return;
          setPreview(data ? { image: data.image ?? null, rarity: data.rarity ?? null } : null);
        })
        .catch(() => {
          if (!cancelled) setPreview(null);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tokenId]);

  return { preview, loading };
}

function TokenPreviewCard({ tokenId }: { tokenId: string }) {
  const { preview, loading } = useTokenPreview(tokenId);
  if (!tokenId) return null;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-gold-500/20 bg-black/20 px-3 py-2.5">
      <div
        className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-wood-900"
        style={
          preview?.rarity ? { boxShadow: `0 0 0 2px ${tierColor(preview.rarity.tier as RarityTier)}` } : undefined
        }
      >
        {preview?.image ? (
          <Image src={preview.image} alt={`#${tokenId}`} fill sizes="48px" className="object-cover" unoptimized />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[0.55rem] text-foreground/30">
            {loading ? "…" : "?"}
          </div>
        )}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-bold text-foreground">#{tokenId}</p>
        <p className="text-[0.65rem] text-foreground/50">
          {loading
            ? "Looking up…"
            : preview?.rarity
              ? `${preview.rarity.tier} · rank #${preview.rarity.rank}`
              : preview
                ? "Unrevealed / no rarity yet"
                : "Not found"}
        </p>
      </div>
    </div>
  );
}

type Props = {
  /** Shared with the rest of MarketView — was previously its own isolated
   * state, which meant a wallet already connected in the page header (and
   * every other tab) still showed "Connect wallet" here again the moment
   * you opened Instant Swap. One connection, one source of truth. */
  account: string | null;
  onConnect: () => void;
};

/**
 * Phase 2 — NFTX-style vault buy/sell. Fully wired against
 * contracts/MarketplankVault.sol's ABI (lib/market/vault.ts). Renders a
 * scoped notice instead of this UI until MARKET_VAULT_ADDRESS is set, which
 * doesn't happen until the vault is deployed and audited (SPEC.md §7).
 */
export default function SwapPanel({ account, onConnect }: Props) {
  const collection = MARKET_COLLECTIONS[0];
  const hasVault = MARKET_VAULT_ADDRESS !== null;

  const [mode, setMode] = useState<Mode>("buy");
  const [amount, setAmount] = useState("");
  const [tokenId, setTokenId] = useState("");
  /** Max slippage, percent. Converted to bps; vault trades REFUSE min-out of 0. */
  const [slippagePct, setSlippagePct] = useState("1");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Deposit picks FROM what the connected wallet actually owns — visual,
  // never a blind typed id. Redeem (targeted) picks from what the vault
  // actually holds right now, same principle, different source.
  const [ownedTokens, setOwnedTokens] = useState<PickerToken[]>([]);
  const [ownedLoading, setOwnedLoading] = useState(false);
  const [heldTokens, setHeldTokens] = useState<PickerToken[]>([]);
  const [heldLoading, setHeldLoading] = useState(false);

  useEffect(() => {
    if (mode !== "deposit" || !account) return;
    let cancelled = false;
    setOwnedLoading(true);
    getOwnedInventory(MARKET_COLLECTIONS, account)
      .then((inv) => {
        if (cancelled) return;
        const items = inv.flatMap((i) => i.items).map((i) => ({ tokenId: i.tokenId, imageUrl: i.imageUrl }));
        setOwnedTokens(items);
      })
      .catch(() => {
        if (!cancelled) setOwnedTokens([]);
      })
      .finally(() => {
        if (!cancelled) setOwnedLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, account]);

  // Live "you receive ~Y" quote — the actual staticCall the transaction
  // itself will use, not an estimate. Debounced so it doesn't fire an
  // eth_call per keystroke, and cleared immediately on any input/mode
  // change so a stale quote is never shown as current.
  const [quote, setQuote] = useState<bigint | null>(null);
  const [quoting, setQuoting] = useState(false);

  useEffect(() => {
    setQuote(null);
    if ((mode !== "buy" && mode !== "sell") || !account || !amount) return;
    let cancelled = false;
    setQuoting(true);
    const timer = setTimeout(() => {
      const run =
        mode === "buy"
          ? quoteBuyShares(account, amount)
          : (() => {
              const wei = parseTokenAmount(amount, 18);
              return wei && wei > BigInt(0) ? quoteSellShares(account, wei) : Promise.resolve(null);
            })();
      run
        .then((q) => {
          if (!cancelled) setQuote(q);
        })
        .finally(() => {
          if (!cancelled) setQuoting(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mode, account, amount]);

  useEffect(() => {
    if (mode !== "redeem") return;
    let cancelled = false;
    setHeldLoading(true);
    fetch("/api/market/vault/held")
      .then((r) => (r.ok ? r.json() : { tokens: [] }))
      .then((data) => {
        if (!cancelled) setHeldTokens(data.tokens ?? []);
      })
      .catch(() => {
        if (!cancelled) setHeldTokens([]);
      })
      .finally(() => {
        if (!cancelled) setHeldLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  if (!hasVault) {
    return (
      <div className="wood-frame overflow-hidden rounded-2xl bg-wood-900/95">
        <div className="relative flex flex-col items-center gap-4 px-6 py-10 text-center">
          <div className="relative h-20 w-20 overflow-hidden rounded-2xl border-2 border-gold-500/40 shadow-[0_0_24px_-4px_rgba(248,217,138,0.5)]">
            <Image
              src={collection?.image ?? "/images/plank-logo.webp"}
              alt={collection?.name ?? "Collection"}
              fill
              sizes="80px"
              className="object-cover"
              unoptimized
            />
          </div>
          <div>
            <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.18em] text-gold-300">
              Instant Swap · {collection?.name ?? "Collection"}
            </p>
            <h3 className="mt-1 font-display text-2xl text-foreground">The workshop isn't open yet</h3>
            <p className="mx-auto mt-2 max-w-sm text-sm text-foreground/60">
              One-click buy/sell/deposit/redeem against a shared liquidity vault unlocks the moment
              it's stocked and opened — no waiting on a matching buyer or seller.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const run = async (action: () => Promise<string>, label: string) => {
    setError(null);
    if (!account) {
      onConnect();
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
      const ethWei = parseTokenAmount(amount, 18);
      return run(
        () =>
          buyShares(account, amount, slippageBps as number, (txHash) =>
            addPendingVaultTx({ txHash, kind: "buy", ethWei: ethWei?.toString() ?? null, tokenId: null })
          ),
        "Buying…"
      );
    }
    if (mode === "sell") {
      const wei = parseTokenAmount(amount, 18);
      if (wei === null || wei <= BigInt(0)) return setError("Enter a share amount.");
      return run(
        () =>
          sellShares(account, wei, slippageBps as number, (txHash) =>
            addPendingVaultTx({ txHash, kind: "sell", ethWei: null, tokenId: null })
          ),
        "Selling…"
      );
    }
    if (mode === "deposit") {
      if (!tokenId) return setError("Enter a token ID.");
      return run(
        () =>
          depositForShares(account, tokenId, (txHash) =>
            addPendingVaultTx({ txHash, kind: "deposit", ethWei: null, tokenId })
          ),
        "Depositing…"
      );
    }
    // redeem
    if (tokenId) {
      return run(
        () =>
          redeemTarget(account, tokenId, (txHash) =>
            addPendingVaultTx({ txHash, kind: "redeem", ethWei: null, tokenId })
          ),
        "Redeeming (targeted)…"
      );
    }
    // FLAGGED (drand rework): this is only STEP 1 of the random redemption.
    // It burns the shares and anchors the draw to a drand round ~3-6s in the
    // future; the NFT arrives only after a second claimRandomRedeem() call,
    // once anyone relays that round. This still calls the correct entry point
    // (the old redeemRandom() did not exist and always reverted), but the UI
    // owes a "waiting for drand round N" state and a claim button. See
    // lib/market/vault.ts for the full flow.
    return run(
      () =>
        requestRandomRedeem(account, (txHash) =>
          addPendingVaultTx({ txHash, kind: "redeem", ethWei: null, tokenId: null })
        ),
      "Requesting random redeem (claim in a few seconds)…"
    );
  };

  const activeMode = MODES.find((m) => m.id === mode)!;

  return (
    <div className="wood-frame overflow-hidden rounded-2xl bg-wood-900/95">
      {/* Header: collection art leads, same "visually dominant" rule as
          every other surface — this used to be a bare form with no branding
          or context at all. */}
      <div className="flex items-center gap-3 border-b border-gold-500/20 bg-black/20 px-4 py-3">
        <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-gold-500/30">
          <Image
            src={collection?.image ?? "/images/plank-logo.webp"}
            alt={collection?.name ?? "Collection"}
            fill
            sizes="40px"
            className="object-cover"
            unoptimized
          />
        </div>
        <div className="min-w-0">
          <p className="truncate font-display text-base text-foreground">
            {collection?.name ?? "Collection"} vault
          </p>
          <p className="text-[0.65rem] text-foreground/50">{activeMode.hint}</p>
        </div>
      </div>

      <div className="space-y-3 p-3">
        {account && account.toLowerCase() === MARKET_FEE_RECIPIENT.toLowerCase() && (
          <TreasuryBootstrap account={account} />
        )}

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
          <div className="rounded-lg border border-gold-500/30 bg-wood-900/70 p-2.5">
            <div className="flex items-center justify-between text-[0.6rem] font-bold uppercase tracking-wide text-foreground/45">
              <span>You pay</span>
              <span>{mode === "buy" ? "ETH" : "Vault share"}</span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-black text-wood-950"
                style={{ backgroundColor: "#f8d98a" }}
              >
                {mode === "buy" ? "Ξ" : "S"}
              </span>
              <input
                type="text"
                inputMode="decimal"
                placeholder="0.0"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                className="min-w-0 flex-1 bg-transparent py-1 text-2xl font-semibold text-foreground outline-none"
              />
            </div>
          </div>
        )}

        {(mode === "buy" || mode === "sell") && (
          <div className="rounded-lg border border-dashed border-gold-500/25 bg-black/15 px-2.5 py-2">
            <div className="flex items-center justify-between text-[0.6rem] font-bold uppercase tracking-wide text-foreground/45">
              <span>You receive</span>
              <span>{mode === "buy" ? "Vault share" : "ETH"}</span>
            </div>
            <p className="mt-0.5 font-display text-lg text-gold-300">
              {!account
                ? "Connect wallet for a live quote"
                : !amount
                  ? "—"
                  : quoting
                    ? "Quoting…"
                    : quote != null
                      ? `~${formatTokenAmount(quote, 18, mode === "buy" ? 4 : 6)} ${
                          mode === "buy" ? "shares" : "Ξ"
                        }`
                      : "Quote unavailable — try a smaller amount"}
            </p>
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

        {mode === "deposit" && (
          <div className="space-y-2">
            <p className="text-[0.65rem] font-bold uppercase tracking-wide text-foreground/45">
              Choose which Plank to deposit
            </p>
            <TokenPicker
              tokens={ownedTokens}
              loading={ownedLoading}
              selected={tokenId || null}
              onSelect={setTokenId}
              emptyMessage={
                account
                  ? `You don't own any ${collection?.name ?? "eligible"} tokens right now.`
                  : "Connect a wallet to see what you can deposit."
              }
            />
            {tokenId && <TokenPreviewCard tokenId={tokenId} />}
          </div>
        )}

        {mode === "redeem" && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[0.65rem] font-bold uppercase tracking-wide text-foreground/45">
                Choose which Plank to redeem
              </p>
              <button
                type="button"
                onClick={() => setTokenId("")}
                className={`text-[0.65rem] font-bold underline decoration-dotted ${
                  tokenId ? "text-foreground/45 hover:text-gold-300" : "text-gold-300"
                }`}
              >
                {tokenId ? "Redeem random instead" : "Random selected ✓"}
              </button>
            </div>
            <TokenPicker
              tokens={heldTokens}
              loading={heldLoading}
              selected={tokenId || null}
              onSelect={setTokenId}
              emptyMessage="The vault isn't holding anything right now."
            />
            {tokenId && <TokenPreviewCard tokenId={tokenId} />}
          </div>
        )}

        {!account ? (
          <button
            type="button"
            onClick={onConnect}
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
            {busy ? (status ?? "Working…") : activeMode.label}
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
    </div>
  );
}
