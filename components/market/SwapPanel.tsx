"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { MARKET_FEE_RECIPIENT, MARKET_VAULT_ADDRESS } from "@/lib/constants";
import TreasuryBootstrap from "@/components/market/TreasuryBootstrap";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import {
  buyShares,
  claimRandomRedeem,
  claimRandomRedeemFor,
  contributeLiquidity,
  decodeVaultError,
  depositForShares,
  forfeitExpiredRedeem,
  getLpCredit,
  getPendingRequester,
  getPendingRound,
  getVaultOnChainSnapshot,
  getVaultShareBalance,
  quoteBuyShares,
  quoteSellShares,
  redeemCostWei,
  removeLiquidity,
  requestRandomRedeem,
  redeemTarget,
  sellShares,
  vaultSupportsContributeLiquidity,
  vaultSupportsRemoveLiquidity,
} from "@/lib/market/vault";
import { shortVault } from "@/lib/market/vault-registry";
import { formatTokenAmount, parseTokenAmount } from "@/lib/trade";
import { tierColor } from "@/lib/market/rarityClient";
import type { RarityTier } from "@/lib/market/rarityClient";
import { getOwnedInventory } from "@/lib/market/inventory";
import TokenPicker, { type PickerToken } from "@/components/market/TokenPicker";
import { addPendingVaultTx } from "@/lib/market/pendingVaultTx";
import { useVaultLive } from "@/lib/market/useVaultLive";
import { relayDrandRound } from "@/lib/market/drand";

type Mode = "buy" | "sell" | "deposit" | "redeem" | "lp";
type LpDirection = "add" | "remove";

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "buy", label: "Buy", hint: "ETH → share" },
  { id: "sell", label: "Sell", hint: "share → ETH" },
  { id: "lp", label: "LP", hint: "add / remove pool depth" },
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
  /** Target vault for Instant Swap txs (primary V2 or legacy V1). */
  vaultAddress?: string | null;
  /** Short UI label for the active vault (e.g. "V2 — new Instant Swap"). */
  vaultLabel?: string | null;
};

/**
 * The vault has exactly ONE random-redeem slot vault-wide — a pending
 * request that never gets relayed doesn't just block its own requester, it
 * blocks EVERY other requestRandomRedeem/redeemTarget call too
 * (RequestPending / ReservedForPendingRedeem), confirmed live against the
 * real deployed vault. Relaying is normally automatic (a GitHub Actions
 * cron, see .github/workflows/relay-drand.yml) but that's a single point
 * of failure with no visible symptom until someone tries to redeem and
 * silently can't. DrandBeacon.submitRound is permissionless (see
 * lib/market/drand.ts), so this gives ANY connected wallet — not just
 * whoever's request is stuck — a way to unstick the whole vault
 * themselves, the moment the round they're waiting on is actually
 * published (drand publishes globally over plain HTTP well before most
 * relayers would ever catch up).
 */
/**
 * Global pending random-redeem lock. Shows whenever ANYONE occupies the
 * single vault-wide slot — not only when randomness is unpublished. Anyone
 * can relay, settle (claimFor), or forfeit an expired unpinned request so
 * deposits/redeems cannot be bricked by abandonment.
 */
function StuckRedeemRelay({
  account,
  vaultAddress,
}: {
  account: string | null;
  vaultAddress?: string | null;
}) {
  const [requester, setRequester] = useState<string | null>(null);
  const [round, setRound] = useState<bigint | null>(null);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      Promise.all([getPendingRequester(vaultAddress), getPendingRound(vaultAddress)])
        .then(([who, r]) => {
          if (cancelled) return;
          const zero = "0x0000000000000000000000000000000000000000";
          setRequester(who && who.toLowerCase() !== zero ? who : null);
          setRound(r.round > BigInt(0) ? r.round : null);
          setAvailable(r.available);
        })
        .catch(() => {});
    };
    check();
    const interval = setInterval(check, 6_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [vaultAddress]);

  if (!requester) return null;

  const isMine =
    account != null && requester.toLowerCase() === account.toLowerCase();
  const needsRelay = round != null && !available;

  const run = async (action: "relay" | "settle" | "forfeit") => {
    if (!account) return;
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      if (action === "relay") {
        if (round == null) throw new Error("No round to relay.");
        setStatus("Relaying randomness…");
        await relayDrandRound(account, round);
        setAvailable(true);
        setStatus("Randomness on-chain — settle when ready.");
      } else if (action === "settle") {
        if (needsRelay && round != null) {
          setStatus("Relaying then settling…");
          try {
            await relayDrandRound(account, round);
          } catch {
            /* may already be available */
          }
        }
        setStatus("Settling redeem for requester…");
        await claimRandomRedeemFor(
          account,
          requester,
          (txHash) =>
            addPendingVaultTx({ txHash, kind: "redeem", ethWei: null, tokenId: null }),
          vaultAddress
        );
        setRequester(null);
        setStatus("Settled — NFT delivered to requester.");
      } else {
        setStatus("Forfeiting expired unpinned request…");
        await forfeitExpiredRedeem(
          account,
          requester,
          (txHash) =>
            addPendingVaultTx({ txHash, kind: "redeem", ethWei: null, tokenId: null }),
          vaultAddress
        );
        setRequester(null);
        setStatus("Slot freed (expired request forfeited).");
      }
    } catch (e) {
      setError(decodeVaultError(e));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-sky-400/40 bg-sky-400/10 p-3">
      <p className="text-xs font-bold uppercase tracking-wide text-sky-300">
        Vault redeem slot is busy
      </p>
      <p className="text-xs text-foreground/70">
        {isMine ? (
          <>Your random redeem is in flight.</>
        ) : (
          <>
            Someone else ({requester.slice(0, 6)}…{requester.slice(-4)}) holds the single vault-wide
            random-redeem slot. New random/targeted redeems wait until it settles.
          </>
        )}
        {round != null ? (
          <>
            {" "}
            Drand round <span className="font-mono text-foreground/85">{round.toString()}</span>
            {available ? " is on-chain." : " is not on-chain yet."}
          </>
        ) : null}
      </p>
      {account ? (
        <div className="flex flex-col gap-1.5 sm:flex-row">
          {needsRelay && (
            <button
              type="button"
              onClick={() => void run("relay")}
              disabled={busy}
              className="min-h-9 flex-1 rounded-lg bg-sky-400 text-xs font-bold uppercase text-wood-950 disabled:opacity-50"
            >
              {busy && status?.includes("Relay") ? "Relaying…" : "Relay randomness"}
            </button>
          )}
          {!isMine && (
            <button
              type="button"
              onClick={() => void run("settle")}
              disabled={busy}
              className="min-h-9 flex-1 rounded-lg border border-sky-300/50 px-2 text-xs font-bold uppercase text-sky-200 disabled:opacity-50"
              title="Permissionless claimRandomRedeemFor — delivers NFT to the requester, frees the slot"
            >
              {busy && status?.includes("Settl") ? "Settling…" : "Settle for them"}
            </button>
          )}
          <button
            type="button"
            onClick={() => void run("forfeit")}
            disabled={busy}
            className="min-h-9 flex-1 rounded-lg border border-red-400/40 px-2 text-xs font-bold uppercase text-red-200/90 disabled:opacity-50"
            title="Only works if the request expired without pinning (~24h unrelayed)"
          >
            Forfeit if expired
          </button>
        </div>
      ) : (
        <p className="text-xs text-foreground/50">Connect a wallet to relay or settle.</p>
      )}
      {status && <p className="text-xs text-emerald-200/90">{status}</p>}
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
}

/**
 * Step 2 of random redeem for the connected wallet. Step 1 burns shares via
 * requestRandomRedeem; without this panel those shares were stuck. Polls
 * pendingRequester so a claim survives refresh / new device.
 */
function PendingRedeemClaim({
  account,
  vaultAddress,
}: {
  account: string | null;
  vaultAddress?: string | null;
}) {
  const [isPending, setIsPending] = useState(false);
  const [round, setRound] = useState<bigint | null>(null);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!account) {
      setIsPending(false);
      return;
    }
    let cancelled = false;

    const check = () => {
      getPendingRequester(vaultAddress)
        .then((requester) => {
          if (cancelled) return;
          setIsPending(requester.toLowerCase() === account.toLowerCase());
        })
        .catch(() => {
          if (!cancelled) setIsPending(false);
        });
    };

    check();
    const interval = setInterval(check, 5_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [account, vaultAddress]);

  useEffect(() => {
    if (!isPending) {
      setRound(null);
      setAvailable(false);
      return;
    }
    let cancelled = false;
    const poll = () => {
      getPendingRound(vaultAddress)
        .then((r) => {
          if (cancelled) return;
          setRound(r.round > BigInt(0) ? r.round : null);
          setAvailable(r.available);
        })
        .catch(() => {});
    };
    poll();
    const interval = setInterval(poll, 3_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isPending, vaultAddress]);

  if (!isPending) return null;

  const claim = async () => {
    if (!account) return;
    setError(null);
    setBusy(true);
    try {
      // If the round isn't on-chain yet, try relaying first (same wallet can
      // do both). Without this, users saw "waiting…" forever when the GH
      // relayer lagged and never clicked the separate global Relay banner.
      if (!available && round != null && round > BigInt(0)) {
        setStep("Relaying randomness…");
        try {
          await relayDrandRound(account, round);
          setAvailable(true);
        } catch (relayErr) {
          // Round may not be published on drand yet — surface and keep polling.
          throw relayErr;
        }
      }
      setStep("Claiming NFT…");
      await claimRandomRedeem(
        account,
        (txHash) =>
          addPendingVaultTx({ txHash, kind: "redeem", ethWei: null, tokenId: null }),
        vaultAddress
      );
      setIsPending(false);
      setStep(null);
    } catch (e) {
      setError(decodeVaultError(e));
      setStep(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-amber-400/40 bg-amber-400/10 p-3">
      <p className="text-xs font-bold uppercase tracking-wide text-amber-300">
        Finish your random redeem (step 2 of 2)
      </p>
      <p className="text-xs text-foreground/70">
        Your shares are already burned. The NFT only leaves the vault when you{" "}
        <strong className="text-foreground/90">claim</strong>
        {round != null ? ` (drand round ${round.toString()})` : ""}. This does not complete by
        itself if you close the tab after step 1.
      </p>
      {available ? (
        <p className="text-xs text-emerald-200/90">Randomness is on-chain — claim whenever ready.</p>
      ) : (
        <p className="text-xs text-foreground/55">
          Waiting for randomness (~seconds to a few minutes). You can retry claim anytime; if the
          round is public but not on-chain yet, the button will relay it first.
        </p>
      )}
      <button
        type="button"
        onClick={claim}
        disabled={busy}
        className="min-h-9 w-full rounded-lg bg-amber-400 text-xs font-bold uppercase text-wood-950 disabled:opacity-50"
      >
        {busy
          ? step ?? "Working…"
          : available
            ? "Claim your NFT now"
            : "Relay + claim NFT"}
      </button>
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
}

/**
 * Phase 2 — NFTX-style vault buy/sell. Fully wired against
 * contracts/MarketplankVault.sol's ABI (lib/market/vault.ts). Renders a
 * scoped notice instead of this UI until MARKET_VAULT_ADDRESS is set, which
 * doesn't happen until the vault is deployed and audited (SPEC.md §7).
 */
export default function SwapPanel({
  account,
  onConnect,
  vaultAddress: vaultAddressProp,
  vaultLabel,
}: Props) {
  const collection = MARKET_COLLECTIONS[0];
  const vaultAddress = vaultAddressProp ?? MARKET_VAULT_ADDRESS;
  const hasVault = vaultAddress !== null;
  const isPrimaryVault =
    !vaultAddress ||
    !MARKET_VAULT_ADDRESS ||
    vaultAddress.toLowerCase() === MARKET_VAULT_ADDRESS.toLowerCase();

  const { stats: liveStats } = useVaultLive();
  const [localStats, setLocalStats] = useState<{
    poolOpen: boolean;
    ethReserveWei: string;
    shareReserveWei: string;
    heldTokenCount: number;
    mintFeeBps: number;
    redeemFeeBps: number;
    targetPremiumBps: number;
  } | null>(null);

  // Live SSE feed is primary-only; when on V1/legacy, poll on-chain snapshot.
  useEffect(() => {
    if (!vaultAddress) {
      setLocalStats(null);
      return;
    }
    if (isPrimaryVault) {
      setLocalStats(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const s = await getVaultOnChainSnapshot(vaultAddress);
        if (cancelled) return;
        setLocalStats({
          poolOpen: s.poolOpen,
          ethReserveWei: s.ethReserve.toString(),
          shareReserveWei: s.shareReserve.toString(),
          heldTokenCount: s.held,
          mintFeeBps: s.mintFeeBps,
          redeemFeeBps: s.redeemFeeBps,
          targetPremiumBps: s.targetPremiumBps,
        });
      } catch {
        /* keep last */
      }
    };
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [vaultAddress, isPrimaryVault]);

  const stats = isPrimaryVault
    ? liveStats
    : localStats
      ? {
          poolOpen: localStats.poolOpen,
          ethReserveWei: localStats.ethReserveWei,
          shareReserveWei: localStats.shareReserveWei,
          heldTokenCount: localStats.heldTokenCount,
          heldTokenIds: [] as string[],
          sharePriceWei: null as string | null,
          mintFeeBps: localStats.mintFeeBps,
          redeemFeeBps: localStats.redeemFeeBps,
          targetPremiumBps: localStats.targetPremiumBps,
          ethUsd: null as number | null,
          aprPct: null as number | null,
          aprBasisHours: null as number | null,
          depositCount: 0,
          redeemCount: 0,
          vaultFeeRevenueWei: "0",
          marketplaceFeeRevenueEstWei: "0",
        }
      : null;

  const [mode, setMode] = useState<Mode>("buy");
  const [amount, setAmount] = useState("");
  /** Optional ETH amount when adding/removing LP. */
  const [lpEth, setLpEth] = useState("");
  const [lpDirection, setLpDirection] = useState<LpDirection>("add");
  const [tokenId, setTokenId] = useState("");
  /** Max slippage, percent. Converted to bps; vault trades REFUSE min-out of 0. */
  const [slippagePct, setSlippagePct] = useState("1");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lpFull, setLpFull] = useState<boolean | null>(null);
  const [lpRemove, setLpRemove] = useState<boolean | null>(null);
  const [lpCredit, setLpCredit] = useState<{ shareCredit: bigint; ethCredit: bigint } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      vaultSupportsContributeLiquidity(vaultAddress),
      vaultSupportsRemoveLiquidity(vaultAddress),
    ])
      .then(([addOk, remOk]) => {
        if (cancelled) return;
        setLpFull(addOk);
        setLpRemove(remOk);
      })
      .catch(() => {
        if (!cancelled) {
          setLpFull(false);
          setLpRemove(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [vaultAddress]);

  const refreshLpCredit = useCallback(async () => {
    if (!account) {
      setLpCredit(null);
      return;
    }
    try {
      setLpCredit(await getLpCredit(account, vaultAddress));
    } catch {
      /* keep last */
    }
  }, [account, vaultAddress]);

  useEffect(() => {
    if (mode !== "lp" || !account) return;
    void refreshLpCredit();
  }, [mode, account, refreshLpCredit]);

  // The single biggest reason "I can't withdraw" happened before this: a
  // redeem costs 1.0 share (+ fee, + a premium on top for a targeted pick),
  // but the user's actual share balance was never shown next to that cost —
  // the only way anyone found out they were short was a failed transaction
  // with an opaque revert. Fetched whenever redeem mode opens and refreshed
  // after every transaction (run(), below).
  const [shareBalance, setShareBalance] = useState<bigint | null>(null);
  const refreshShareBalance = useCallback(async () => {
    if (!account) return;
    try {
      setShareBalance(await getVaultShareBalance(account, vaultAddress));
    } catch {
      // leave whatever balance we last had — a failed read shouldn't blank
      // out a number the user was already relying on
    }
  }, [account, vaultAddress]);

  // Always show wallet share balance for existing depositors (any mode).
  // Deposits mint shares to the wallet — not the pool — so this is the number
  // that unlocks Redeem / Sell / Add LP. Refresh on account, mode, and after txs.
  useEffect(() => {
    if (!account) {
      setShareBalance(null);
      return;
    }
    void refreshShareBalance();
  }, [mode, account, refreshShareBalance, vaultAddress]);

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

  // Live "you receive ~Y" quote — public RPC (no wallet). Debounced so it
  // doesn't fire per keystroke; cleared immediately on input/mode change.
  const [quote, setQuote] = useState<bigint | null>(null);
  const [quoting, setQuoting] = useState(false);

  useEffect(() => {
    setQuote(null);
    if ((mode !== "buy" && mode !== "sell") || !amount) return;
    let cancelled = false;
    setQuoting(true);
    const timer = setTimeout(() => {
      const run =
        mode === "buy"
          ? quoteBuyShares(account, amount, vaultAddress)
          : (() => {
              const wei = parseTokenAmount(amount, 18);
              return wei && wei > BigInt(0)
                ? quoteSellShares(account, wei, vaultAddress)
                : Promise.resolve(null);
            })();
      run
        .then((q) => {
          if (!cancelled) setQuote(q);
        })
        .catch(() => {
          if (!cancelled) setQuote(null);
        })
        .finally(() => {
          if (!cancelled) setQuoting(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mode, account, amount, vaultAddress]);

  useEffect(() => {
    if (mode !== "redeem") return;
    let cancelled = false;
    setHeldLoading(true);
    const q = vaultAddress
      ? `?vault=${encodeURIComponent(vaultAddress)}`
      : "";
    fetch(`/api/market/vault/held${q}`)
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
  }, [mode, vaultAddress]);

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

  const run = async (action: () => Promise<string>, label: string, successLabel = "Confirmed.") => {
    setError(null);
    if (!account) {
      onConnect();
      return;
    }
    try {
      setBusy(true);
      setStatus(label);
      await action();
      setStatus(successLabel);
      setAmount("");
      setLpEth("");
      setTokenId("");
      void refreshShareBalance();
      void refreshLpCredit();
    } catch (e) {
      setError(decodeVaultError(e));
    } finally {
      setBusy(false);
      setTimeout(() => setStatus(null), successLabel.startsWith("Step 1") ? 12_000 : 3_000);
    }
  };

  const redeemCostForMode = stats
    ? redeemCostWei(stats.redeemFeeBps, stats.targetPremiumBps, Boolean(tokenId))
    : BigInt(0);
  const redeemInsufficient =
    mode === "redeem" && stats != null && shareBalance != null && shareBalance < redeemCostForMode;

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
    if (mode === "redeem" && redeemInsufficient) {
      return setError(
        `You need ${formatTokenAmount(redeemCostForMode, 18, 4)} shares to redeem${tokenId ? " that specific plank" : ""}, but you have ${
          shareBalance != null ? formatTokenAmount(shareBalance, 18, 4) : "0"
        }.`
      );
    }
    if (mode === "buy") {
      if (!amount) return setError("Enter an ETH amount.");
      const ethWei = parseTokenAmount(amount, 18);
      return run(
        () =>
          buyShares(
            account,
            amount,
            slippageBps as number,
            (txHash) =>
              addPendingVaultTx({
                txHash,
                kind: "buy",
                ethWei: ethWei?.toString() ?? null,
                tokenId: null,
              }),
            vaultAddress
          ),
        "Buying…"
      );
    }
    if (mode === "sell") {
      const wei = parseTokenAmount(amount, 18);
      if (wei === null || wei <= BigInt(0)) return setError("Enter a share amount.");
      return run(
        () =>
          sellShares(
            account,
            wei,
            slippageBps as number,
            (txHash) =>
              addPendingVaultTx({ txHash, kind: "sell", ethWei: null, tokenId: null }),
            vaultAddress
          ),
        "Selling…"
      );
    }
    if (mode === "lp") {
      const sharesWei = parseTokenAmount(amount, 18) ?? BigInt(0);
      const ethWei = parseTokenAmount(lpEth, 18) ?? BigInt(0);
      if (sharesWei <= BigInt(0) && ethWei <= BigInt(0)) {
        return setError(
          lpDirection === "remove"
            ? "Enter shares and/or ETH to remove from the pool."
            : "Enter shares and/or ETH to add to the pool."
        );
      }
      if (lpDirection === "remove") {
        if (lpRemove === false) {
          return setError(
            "Remove LP needs the vault upgrade (removeLiquidity). Until then use Sell to trade shares for ETH."
          );
        }
        return run(
          () =>
            removeLiquidity(
              account,
              sharesWei,
              ethWei,
              (txHash) =>
                addPendingVaultTx({
                  txHash,
                  kind: "buy",
                  ethWei: ethWei > BigInt(0) ? ethWei.toString() : null,
                  tokenId: null,
                }),
              vaultAddress
            ),
          "Removing liquidity…",
          "LP removed — shares and/or ETH returned to your wallet."
        );
      }
      return run(
        async () => {
          const r = await contributeLiquidity(
            account,
            sharesWei,
            ethWei,
            (txHash) =>
              addPendingVaultTx({
                txHash,
                kind: "sell",
                ethWei: ethWei > BigInt(0) ? ethWei.toString() : null,
                tokenId: null,
              }),
            vaultAddress
          );
          return r.hash;
        },
        "Adding liquidity…",
        lpFull
          ? "Liquidity added — credited for Remove LP."
          : "Shares moved into the pool (no remove credit until vault upgrade). ETH add needs upgrade."
      );
    }
    if (mode === "deposit") {
      if (!tokenId) return setError("Enter a token ID.");
      return run(
        () =>
          depositForShares(
            account,
            tokenId,
            (txHash) =>
              addPendingVaultTx({ txHash, kind: "deposit", ethWei: null, tokenId }),
            vaultAddress
          ),
        "Depositing…"
      );
    }
    // redeem — targeted is one tx; random is commit then claim (see PendingRedeemClaim).
    if (tokenId) {
      return run(
        () =>
          redeemTarget(
            account,
            tokenId,
            (txHash) =>
              addPendingVaultTx({ txHash, kind: "redeem", ethWei: null, tokenId }),
            vaultAddress
          ),
        "Redeeming specific plank…"
      );
    }
    // Step 1 only — NFT does not transfer until claimRandomRedeem (step 2).
    return run(
      () =>
        requestRandomRedeem(
          account,
          (txHash) =>
            addPendingVaultTx({ txHash, kind: "redeem", ethWei: null, tokenId: null }),
          vaultAddress
        ),
      "Step 1/2: locking random redeem…",
      "Step 1 done — use Claim your NFT above when ready (step 2)."
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
            {collection?.name ?? "Collection"} ·{" "}
            {vaultLabel ?? (isPrimaryVault ? "V2 vault" : "V1 vault")}
          </p>
          <p className="text-[0.65rem] text-foreground/50">
            {activeMode.hint}
            {vaultAddress ? (
              <>
                {" "}
                ·{" "}
                <span className="font-mono text-foreground/40">{shortVault(vaultAddress)}</span>
              </>
            ) : null}
          </p>
        </div>
      </div>

      <div className="space-y-3 p-3">
        {/* Existing deposits: shares live in the wallet on this vault address.
            Never strand them by switching MARKET_VAULT_ADDRESS without redeem. */}
        {account && (
          <div className="rounded-lg border border-gold-500/25 bg-black/25 px-3 py-2 text-[0.7rem] leading-relaxed text-foreground/75">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p>
                <span className="font-bold uppercase tracking-wide text-foreground/45">Your shares </span>
                <span className="font-mono text-gold-200">
                  {shareBalance != null ? formatTokenAmount(shareBalance, 18, 4) : "…"}
                </span>
                <span className="text-foreground/45"> vROBIN in your wallet</span>
              </p>
              {stats && (
                <p className="text-foreground/45">
                  Vault holds {stats.heldTokenCount} planks · pool{" "}
                  {formatTokenAmount(stats.shareReserveWei, 18, 2)} sh /{" "}
                  {formatTokenAmount(stats.ethReserveWei, 18, 4)} Ξ
                </p>
              )}
            </div>
            <p className="mt-1 text-[0.65rem] text-foreground/55">
              Deposits already on this vault stay here. Use <strong className="text-foreground/80">Redeem</strong>{" "}
              to get an NFT back, <strong className="text-foreground/80">Sell</strong> for ETH, or{" "}
              <strong className="text-foreground/80">LP</strong> to deepen the pool. Your shares are not stuck
              just because the AMM pool is smaller than total deposits.
            </p>
          </div>
        )}

        {/* Only show bootstrap while the pool is still closed. Once open
            (stats.poolOpen), never mount it — even for the treasury wallet —
            so Instant Swap doesn't keep a bootstrap/loading chrome on screen. */}
        {account &&
          account.toLowerCase() === MARKET_FEE_RECIPIENT.toLowerCase() &&
          stats?.poolOpen === false && (
          <TreasuryBootstrap account={account} />
        )}

        <StuckRedeemRelay account={account} vaultAddress={vaultAddress} />
        <PendingRedeemClaim account={account} vaultAddress={vaultAddress} />

        <div className="grid grid-cols-3 gap-1 rounded-lg border border-gold-500/20 bg-wood-900/50 p-1 sm:grid-cols-5">
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

        {mode === "lp" && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-1 rounded-lg border border-gold-500/20 bg-black/20 p-1">
              <button
                type="button"
                onClick={() => {
                  setLpDirection("add");
                  setAmount("");
                  setLpEth("");
                  setError(null);
                }}
                className={`min-h-8 rounded-md text-xs font-bold uppercase ${
                  lpDirection === "add" ? "bg-gold-500 text-wood-950" : "text-foreground/65 hover:text-gold-300"
                }`}
              >
                Add LP
              </button>
              <button
                type="button"
                onClick={() => {
                  setLpDirection("remove");
                  setAmount("");
                  setLpEth("");
                  setError(null);
                }}
                className={`min-h-8 rounded-md text-xs font-bold uppercase ${
                  lpDirection === "remove" ? "bg-gold-500 text-wood-950" : "text-foreground/65 hover:text-gold-300"
                }`}
              >
                Remove LP
              </button>
            </div>
            <p className="text-[0.7rem] text-foreground/65">
              {lpDirection === "add" ? (
                <>
                  <strong className="text-foreground/85">Deposit is not LP.</strong> After deposit, shares
                  sit in <em>your wallet</em> (see balance above) — you can Redeem anytime.{" "}
                  <strong className="text-foreground/85">Add LP</strong> optionally moves some of those
                  shares into the trading pool so Instant Swap has more depth
                  {lpFull ? " (and credits you for Remove LP)" : ""}.
                </>
              ) : lpRemove ? (
                <>
                  Pull back shares/ETH you previously added via <strong className="text-foreground/85">Add LP</strong>.
                  Capped by your credit and live pool reserves. Existing <em>deposits</em> (wallet shares) are
                  not LP credit — use Redeem or Sell for those.
                </>
              ) : (
                <>
                  <strong className="text-foreground/85">Existing deposits do not need Remove LP.</strong>{" "}
                  If you deposited a plank, your vROBIN shares are already in your wallet — use{" "}
                  <strong className="text-foreground/85">Redeem</strong> (NFT) or{" "}
                  <strong className="text-foreground/85">Sell</strong> (ETH). Remove LP only undoes pool
                  contributions after a vault upgrade that tracks LP credits. This live vault address keeps
                  all 57+ current deposits — we will not switch contracts out from under you.
                </>
              )}
            </p>
            {lpCredit && (lpCredit.shareCredit > BigInt(0) || lpCredit.ethCredit > BigInt(0)) && (
              <p className="rounded-md border border-gold-500/20 bg-black/15 px-2 py-1.5 text-[0.65rem] text-gold-200/90">
                Your LP credit: {formatTokenAmount(lpCredit.shareCredit, 18, 4)} shares ·{" "}
                {formatTokenAmount(lpCredit.ethCredit, 18, 5)} Ξ
              </p>
            )}
            <div className="rounded-xl border border-gold-500/30 bg-wood-900/70 px-3 py-2.5">
              <div className="flex items-center justify-between text-[0.65rem] font-bold uppercase tracking-wide text-foreground/50">
                <span>{lpDirection === "remove" ? "Shares to remove" : "Shares to add"}</span>
                {lpDirection === "add" && shareBalance != null && (
                  <button
                    type="button"
                    className="text-gold-300 hover:underline"
                    onClick={() => setAmount(formatTokenAmount(shareBalance, 18, 6))}
                  >
                    Max {formatTokenAmount(shareBalance, 18, 4)}
                  </button>
                )}
                {lpDirection === "remove" && lpCredit && lpCredit.shareCredit > BigInt(0) && (
                  <button
                    type="button"
                    className="text-gold-300 hover:underline"
                    onClick={() => setAmount(formatTokenAmount(lpCredit.shareCredit, 18, 6))}
                  >
                    Max {formatTokenAmount(lpCredit.shareCredit, 18, 4)}
                  </button>
                )}
              </div>
              <input
                type="text"
                inputMode="decimal"
                placeholder="0.0"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                className="mt-1 w-full bg-transparent text-xl font-semibold text-foreground outline-none"
              />
            </div>
            <div className="rounded-xl border border-gold-500/30 bg-wood-900/70 px-3 py-2.5">
              <div className="flex items-center justify-between text-[0.65rem] font-bold uppercase tracking-wide text-foreground/50">
                <span>{lpDirection === "remove" ? "ETH to remove" : "ETH to add (optional)"}</span>
                {lpDirection === "remove" && lpCredit && lpCredit.ethCredit > BigInt(0) ? (
                  <button
                    type="button"
                    className="text-gold-300 hover:underline"
                    onClick={() => setLpEth(formatTokenAmount(lpCredit.ethCredit, 18, 6))}
                  >
                    Max {formatTokenAmount(lpCredit.ethCredit, 18, 5)} Ξ
                  </button>
                ) : (
                  <span className="text-gold-300">Ξ</span>
                )}
              </div>
              <input
                type="text"
                inputMode="decimal"
                placeholder={
                  lpDirection === "add" && lpFull === false
                    ? "Requires vault upgrade"
                    : lpDirection === "remove" && lpRemove === false
                      ? "Requires vault upgrade"
                      : "0.0"
                }
                value={lpEth}
                disabled={
                  (lpDirection === "add" && lpFull === false) ||
                  (lpDirection === "remove" && lpRemove === false)
                }
                onChange={(e) => setLpEth(e.target.value.replace(/[^0-9.]/g, ""))}
                className="mt-1 w-full bg-transparent text-xl font-semibold text-foreground outline-none disabled:opacity-40"
              />
            </div>
            {stats && (
              <p className="text-[0.6rem] text-foreground/45">
                Pool now: {formatTokenAmount(stats.shareReserveWei, 18, 4)} shares ·{" "}
                {formatTokenAmount(stats.ethReserveWei, 18, 4)} Ξ · vault holds {stats.heldTokenCount}{" "}
                planks (≠ pool size).{" "}
                <a href="/learn#vault-lp" className="text-gold-300 underline">
                  Learn how this works
                </a>
              </p>
            )}
            {lpDirection === "add" && lpFull === false && (
              <p className="rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-1.5 text-[0.65rem] text-amber-100/90">
                On this vault build, Add LP transfers shares into the pool{" "}
                <strong>without a Remove LP path</strong>. Prefer keeping shares in your wallet (Redeem
                anytime) unless you intend to permanently deepen the book. A future vault upgrade can add
                credit + remove without moving existing deposits off this address until holders choose to
                migrate.
              </p>
            )}
            {lpDirection === "remove" && lpRemove === false && (
              <p className="rounded-md border border-emerald-400/25 bg-emerald-400/10 px-2 py-1.5 text-[0.65rem] text-emerald-50/90">
                <strong>Nothing to remove for normal depositors.</strong> Your deposited planks minted
                shares to your wallet — they are not locked as LP. Switch to{" "}
                <strong>Redeem</strong> (get NFT) or <strong>Sell</strong> (get ETH). Pool Remove LP
                requires an upgraded vault with <code className="font-mono">removeLiquidity</code>; until
                then, do not expect pool-side share recovery.
              </p>
            )}
          </div>
        )}

        {(mode === "buy" || mode === "sell") && (
          <div className="rounded-lg border border-dashed border-gold-500/25 bg-black/15 px-2.5 py-2">
            <div className="flex items-center justify-between text-[0.6rem] font-bold uppercase tracking-wide text-foreground/45">
              <span>You receive</span>
              <span>{mode === "buy" ? "Vault share" : "ETH"}</span>
            </div>
            <p className="mt-0.5 font-display text-lg text-gold-300">
              {!amount
                ? "—"
                : quoting
                  ? "Quoting…"
                  : quote != null
                    ? `~${formatTokenAmount(quote, 18, mode === "buy" ? 4 : 6)} ${
                        mode === "buy" ? "shares" : "Ξ"
                      }`
                    : "Quote unavailable — try a smaller amount"}
            </p>
            {stats?.sharePriceWei && (
              <p className="mt-0.5 text-[0.6rem] text-foreground/45">
                Pool mid ≈ {formatTokenAmount(stats.sharePriceWei, 18, 5)} Ξ / share · reserve{" "}
                {formatTokenAmount(stats.ethReserveWei, 18, 4)} Ξ
              </p>
            )}
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
            <div className="grid grid-cols-2 gap-1 rounded-lg border border-gold-500/20 bg-wood-900/50 p-1">
              <button
                type="button"
                onClick={() => setTokenId("")}
                className={`min-h-9 rounded-md text-[0.65rem] font-bold uppercase transition ${
                  !tokenId ? "bg-gold-500 text-wood-950" : "text-foreground/60 hover:text-gold-300"
                }`}
              >
                Random
              </button>
              <button
                type="button"
                onClick={() => {
                  /* keep current pick if any; user selects from grid */
                }}
                className={`min-h-9 rounded-md text-[0.65rem] font-bold uppercase transition ${
                  tokenId ? "bg-gold-500 text-wood-950" : "text-foreground/60 hover:text-gold-300"
                }`}
              >
                Specific plank
              </button>
            </div>
            <p className="text-[0.65rem] text-foreground/50">
              {!tokenId ? (
                <>
                  <strong className="text-foreground/70">Random</strong> is two wallet steps: (1)
                  lock shares, (2) claim NFT after randomness. Only one random redeem can be in
                  flight vault-wide.
                </>
              ) : (
                <>
                  <strong className="text-foreground/70">Specific</strong> is one transaction and
                  costs a target premium on top of the redeem fee.
                </>
              )}
            </p>
            <p className="text-[0.65rem] font-bold uppercase tracking-wide text-foreground/45">
              {tokenId ? "Vault holdings — pick a plank" : "Or pick a specific plank below"}
            </p>
            <TokenPicker
              tokens={heldTokens}
              loading={heldLoading}
              selected={tokenId || null}
              onSelect={setTokenId}
              emptyMessage="The vault isn't holding anything right now."
            />
            {tokenId && <TokenPreviewCard tokenId={tokenId} />}
            {stats && (
              <div
                className={`rounded-lg border px-2.5 py-2 text-[0.65rem] ${
                  redeemInsufficient
                    ? "border-red-500/40 bg-red-500/10 text-red-200"
                    : "border-gold-500/20 bg-black/15 text-foreground/60"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span>Your balance</span>
                  <span className="font-mono font-bold text-foreground">
                    {shareBalance != null ? formatTokenAmount(shareBalance, 18, 4) : "…"} shares
                  </span>
                </div>
                <div className="mt-0.5 flex items-center justify-between">
                  <span>Costs{tokenId ? " (targeted, +premium)" : " (random)"}</span>
                  <span className="font-mono font-bold text-foreground">
                    {formatTokenAmount(redeemCostForMode, 18, 4)} shares
                  </span>
                </div>
                <p className="mt-1.5 text-[0.6rem] text-foreground/45">
                  One deposit mints ~{formatTokenAmount(
                    BigInt(10) ** BigInt(18) - (BigInt(10) ** BigInt(18) * BigInt(stats.mintFeeBps)) / BigInt(10_000),
                    18,
                    2
                  )}{" "}
                  shares (mint fee {stats.mintFeeBps / 100}%). Random redeem needs{" "}
                  {formatTokenAmount(
                    redeemCostWei(stats.redeemFeeBps, stats.targetPremiumBps, false),
                    18,
                    2
                  )}{" "}
                  — typically two deposits or buy the shortfall.
                </p>
                {redeemInsufficient && (
                  <>
                    <p className="mt-1 font-bold">
                      {shareBalance != null && shareBalance > BigInt(0)
                        ? "Not enough for a whole plank — sell shares for ETH instead, or deposit/buy more."
                        : "Nothing to redeem — no shares yet. Deposit a plank or buy shares first."}
                    </p>
                    {shareBalance != null && shareBalance > BigInt(0) && (
                      <button
                        type="button"
                        onClick={() => {
                          setMode("sell");
                          setAmount(formatTokenAmount(shareBalance, 18, 18));
                        }}
                        className="mt-1.5 w-full rounded-md border border-emerald-400/40 bg-emerald-400/10 px-2 py-1.5 text-[0.65rem] font-bold text-emerald-200 transition hover:border-emerald-300"
                      >
                        Sell your {formatTokenAmount(shareBalance, 18, 4)} shares for ETH instead →
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
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
            disabled={busy || redeemInsufficient}
            onClick={submit}
            className="min-h-12 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950 transition hover:bg-gold-400 disabled:opacity-50"
          >
            {busy
              ? (status ?? "Working…")
              : redeemInsufficient
                ? "Not enough shares"
                : mode === "redeem"
                  ? tokenId
                    ? "Redeem this plank"
                    : "Start random redeem (step 1/2)"
                  : mode === "lp"
                    ? lpDirection === "remove"
                      ? "Remove LP"
                      : "Add LP"
                    : activeMode.label}
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
