"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { MARKET_FEE_RECIPIENT, MARKET_VAULT_ADDRESS } from "@/lib/constants";
import { getNativeBalance } from "@/lib/wallet";
import TreasuryBootstrap from "@/components/market/TreasuryBootstrap";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import {
  buyShares,
  claimRandomRedeemFor,
  contributeLiquidity,
  decodeVaultError,
  depositForShares,
  finishRandomRedeem,
  forfeitExpiredRedeem,
  getLpCredit,
  getPendingRequester,
  getPendingRound,
  getVaultShareBalance,
  kickServerRandomSettle,
  quoteBuyShares,
  quoteSellShares,
  redeemCostWei,
  removeLiquidity,
  requestAndFinishRandomRedeem,
  redeemTarget,
  sellShares,
  vaultSupportsContributeLiquidity,
  vaultSupportsRemoveLiquidity,
} from "@/lib/market/vault";
import {
  shortVault,
  vaultColorKind,
  VAULT_LABEL_CLASS,
  VAULT_TEXT_CLASS,
} from "@/lib/market/vault-registry";
import { formatTokenAmount, parseTokenAmount } from "@/lib/trade";
import { tierColor } from "@/lib/market/rarityClient";
import type { RarityTier } from "@/lib/market/rarityClient";
import { getOwnedInventory } from "@/lib/market/inventory";
import TokenPicker, { type PickerToken } from "@/components/market/TokenPicker";
import { addPendingVaultTx } from "@/lib/market/pendingVaultTx";
import { useVaultBook } from "@/lib/market/useVaultBook";
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
    <div className="flex items-center gap-3 rounded-lg border border-gold-500/20 bg-wood-950/90 px-3 py-2.5">
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
    const check = async () => {
      try {
        // Always try sponsored settle first when anything is pending — free for users.
        await kickServerRandomSettle(vaultAddress);
      } catch {
        /* ignore */
      }
      try {
        const [who, r] = await Promise.all([
          getPendingRequester(vaultAddress),
          getPendingRound(vaultAddress),
        ]);
        if (cancelled) return;
        const zero = "0x0000000000000000000000000000000000000000";
        setRequester(who && who.toLowerCase() !== zero ? who : null);
        setRound(r.round > BigInt(0) ? r.round : null);
        setAvailable(r.available);
      } catch {
        /* */
      }
    };
    void check();
    const interval = setInterval(() => void check(), 6_000);
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
            addPendingVaultTx({
              txHash,
              kind: "redeem",
              ethWei: null,
              tokenId: null,
              role: "settle",
            }),
          vaultAddress
        );
        setRequester(null);
        setStatus("Settled — NFT delivered to the original redeemer (not your inventory).");
      } else {
        setStatus("Forfeiting expired unpinned request…");
        await forfeitExpiredRedeem(
          account,
          requester,
          (txHash) =>
            addPendingVaultTx({
              txHash,
              kind: "redeem",
              ethWei: null,
              tokenId: null,
              role: "settle",
            }),
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
          <>Your random redeem is in flight — auto-finishing without extra gas from you.</>
        ) : (
          <>
            Someone else ({requester.slice(0, 6)}…{requester.slice(-4)}) holds the single vault-wide
            random-redeem slot. Background relayer is settling it (no gas from you). New redeems
            resume once free.
          </>
        )}
        {round != null ? (
          <>
            {" "}
            Drand round <span className="font-mono text-foreground/85">{round.toString()}</span>
            {available ? " is on-chain." : " waiting to publish…"}
          </>
        ) : null}
      </p>
      {/* Manual wallet actions only as last resort if sponsor is down. */}
      {account ? (
        <details className="text-xs text-foreground/55">
          <summary className="cursor-pointer text-sky-200/80 hover:text-sky-200">
            Advanced: manual relay / settle (uses your gas)
          </summary>
          <div className="mt-2 flex flex-col gap-1.5 sm:flex-row">
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
              >
                {busy && status?.includes("Settl") ? "Settling…" : "Settle for them"}
              </button>
            )}
            <button
              type="button"
              onClick={() => void run("forfeit")}
              disabled={busy}
              className="min-h-9 flex-1 rounded-lg border border-red-400/40 px-2 text-xs font-bold uppercase text-red-200/90 disabled:opacity-50"
            >
              Forfeit if expired
            </button>
          </div>
        </details>
      ) : null}
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
  const autoOnce = useRef(false);

  useEffect(() => {
    if (!account) {
      setIsPending(false);
      autoOnce.current = false;
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
      autoOnce.current = false;
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

  const claim = useCallback(async () => {
    if (!account) return;
    setError(null);
    setBusy(true);
    try {
      // Prefer sponsored server settle — no user gas / no second signature.
      setStep("Server finishing redeem (no gas from you)…");
      for (let i = 0; i < 24; i += 1) {
        const kick = await kickServerRandomSettle(vaultAddress, account);
        const who = (await getPendingRequester(vaultAddress)).toLowerCase();
        const me = account.toLowerCase();
        const zero = "0x0000000000000000000000000000000000000000";
        if (who === zero || who !== me) {
          setIsPending(false);
          setStep(null);
          return;
        }
        if (kick.status === "no_key") break;
        setStep(
          kick.status === "waiting_round"
            ? "Waiting for randomness (~seconds)…"
            : "Server settling…"
        );
        await new Promise((r) => setTimeout(r, 2_500));
      }
      // Fallback only if sponsor offline.
      setStep("Auto-finish offline — claim with your wallet…");
      await finishRandomRedeem(account, vaultAddress, {
        onProgress: (msg) => setStep(msg),
        onSubmitted: (txHash) =>
          addPendingVaultTx({ txHash, kind: "redeem", ethWei: null, tokenId: null }),
      });
      setIsPending(false);
      setStep(null);
    } catch (e) {
      setError(decodeVaultError(e));
      setStep(null);
    } finally {
      setBusy(false);
    }
  }, [account, vaultAddress]);

  // If user already holds the slot (refreshed mid-flow or stepped away after
  // step 1), kick server settle first — no wallet prompt.
  useEffect(() => {
    if (!isPending || !account || busy || autoOnce.current) return;
    autoOnce.current = true;
    void claim();
  }, [isPending, account, busy, claim]);

  if (!isPending) return null;

  return (
    <div className="space-y-2 rounded-lg border border-amber-400/40 bg-amber-400/10 p-3">
      <p className="text-xs font-bold uppercase tracking-wide text-amber-300">
        Finishing your random redeem
      </p>
      <p className="text-xs text-foreground/70">
        Shares are burned. A background relayer pushes randomness and delivers your NFT{" "}
        <strong className="text-foreground/85">without another gas fee from you</strong>
        {round != null ? (
          <>
            {" "}
            (drand round <span className="font-mono">{round.toString()}</span>)
          </>
        ) : null}
        . You can leave this tab — the vault slot frees automatically.
      </p>
      {available ? (
        <p className="text-xs text-emerald-200/90">Randomness is on-chain — completing claim…</p>
      ) : (
        <p className="text-xs text-foreground/55">
          Waiting for randomness (~seconds). No action needed.
        </p>
      )}
      <button
        type="button"
        onClick={() => void claim()}
        disabled={busy}
        className="min-h-9 w-full rounded-lg bg-amber-400 text-xs font-bold uppercase text-wood-950 disabled:opacity-50"
      >
        {busy ? step ?? "Working…" : "Retry relay + claim NFT"}
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
  // Per-selected-vault book (V1 or V2) — not the dual trade feed.
  const { stats: bookStats } = useVaultBook(vaultAddress);
  const stats = bookStats;

  const [mode, setMode] = useState<Mode>("buy");
  const [amount, setAmount] = useState("");
  /** Optional ETH amount when adding/removing LP. */
  const [lpEth, setLpEth] = useState("");
  const [lpDirection, setLpDirection] = useState<LpDirection>("add");
  /** Which LP field the user last edited — drives auto-ratio fill of the other. */
  const [lpEditSide, setLpEditSide] = useState<"shares" | "eth" | null>(null);
  const [tokenId, setTokenId] = useState("");
  /** Max slippage, percent. Converted to bps; vault trades REFUSE min-out of 0. */
  const [slippagePct, setSlippagePct] = useState("1");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lpFull, setLpFull] = useState<boolean | null>(null);
  const [lpRemove, setLpRemove] = useState<boolean | null>(null);
  const [lpCredit, setLpCredit] = useState<{ shareCredit: bigint; ethCredit: bigint } | null>(null);

  /** Pool ratio for balanced LP: eth = shares * ethR / shareR (and inverse). */
  const lpPoolRatio = useMemo(() => {
    if (!stats) return null;
    try {
      const shareR = BigInt(stats.shareReserveWei || "0");
      const ethR = BigInt(stats.ethReserveWei || "0");
      if (shareR <= BigInt(0) || ethR <= BigInt(0)) return null;
      return { shareR, ethR };
    } catch {
      return null;
    }
  }, [stats]);

  const ethFromShares = useCallback(
    (sharesWei: bigint): bigint | null => {
      if (!lpPoolRatio || sharesWei <= BigInt(0)) return null;
      return (sharesWei * lpPoolRatio.ethR) / lpPoolRatio.shareR;
    },
    [lpPoolRatio]
  );

  const sharesFromEth = useCallback(
    (ethWei: bigint): bigint | null => {
      if (!lpPoolRatio || ethWei <= BigInt(0)) return null;
      return (ethWei * lpPoolRatio.shareR) / lpPoolRatio.ethR;
    },
    [lpPoolRatio]
  );

  /** User typed shares — fill ETH to match pool ratio (add LP). */
  const onLpSharesChange = useCallback(
    (raw: string) => {
      const cleaned = raw.replace(/[^0-9.]/g, "");
      setLpEditSide("shares");
      setAmount(cleaned);
      if (lpDirection !== "add" || !lpPoolRatio || !lpFull) return;
      const wei = parseTokenAmount(cleaned, 18);
      if (wei == null || wei <= BigInt(0)) {
        setLpEth("");
        return;
      }
      const ethWei = ethFromShares(wei);
      if (ethWei == null || ethWei <= BigInt(0)) {
        setLpEth("");
        return;
      }
      setLpEth(formatTokenAmount(ethWei, 18, 6));
    },
    [lpDirection, lpPoolRatio, lpFull, ethFromShares]
  );

  /** User typed ETH — fill shares to match pool ratio (add LP). */
  const onLpEthChange = useCallback(
    (raw: string) => {
      const cleaned = raw.replace(/[^0-9.]/g, "");
      setLpEditSide("eth");
      setLpEth(cleaned);
      if (lpDirection !== "add" || !lpPoolRatio || !lpFull) return;
      const wei = parseTokenAmount(cleaned, 18);
      if (wei == null || wei <= BigInt(0)) {
        setAmount("");
        return;
      }
      const sh = sharesFromEth(wei);
      if (sh == null || sh <= BigInt(0)) {
        setAmount("");
        return;
      }
      setAmount(formatTokenAmount(sh, 18, 6));
    },
    [lpDirection, lpPoolRatio, lpFull, sharesFromEth]
  );

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
  const [ethBalance, setEthBalance] = useState<bigint | null>(null);

  /** Max shares add: wallet shares, capped so matching ETH still fits (gas pad). */
  const maxLpSharesAdd = useCallback(() => {
    if (shareBalance == null || shareBalance <= BigInt(0)) return;
    setLpEditSide("shares");
    let shares = shareBalance;
    let ethWei = ethFromShares(shares);
    if (ethWei != null && ethBalance != null && ethBalance > BigInt(0)) {
      const gasPad = parseTokenAmount("0.0003", 18) ?? BigInt(0);
      const ethCap = ethBalance > gasPad ? ethBalance - gasPad : BigInt(0);
      if (ethWei > ethCap && ethCap > BigInt(0)) {
        ethWei = ethCap;
        const cappedShares = sharesFromEth(ethCap);
        if (cappedShares != null && cappedShares > BigInt(0) && cappedShares < shares) {
          shares = cappedShares;
        }
      }
    }
    setAmount(formatTokenAmount(shares, 18, 6));
    if (lpFull && ethWei != null && ethWei > BigInt(0)) {
      setLpEth(formatTokenAmount(ethWei, 18, 6));
    } else if (lpFull) {
      setLpEth("");
    }
  }, [shareBalance, ethBalance, ethFromShares, sharesFromEth, lpFull]);

  /** Max ETH add: wallet ETH minus gas pad, capped so matching shares fit. */
  const maxLpEthAdd = useCallback(() => {
    if (ethBalance == null || ethBalance <= BigInt(0)) return;
    setLpEditSide("eth");
    const gasPad = parseTokenAmount("0.0003", 18) ?? BigInt(0);
    let ethWei = ethBalance > gasPad ? ethBalance - gasPad : BigInt(0);
    if (ethWei <= BigInt(0)) return;
    let shares = sharesFromEth(ethWei);
    if (shares != null && shareBalance != null && shares > shareBalance) {
      shares = shareBalance;
      const ethFromSh = ethFromShares(shareBalance);
      if (ethFromSh != null && ethFromSh > BigInt(0)) ethWei = ethFromSh;
    }
    setLpEth(formatTokenAmount(ethWei, 18, 6));
    if (shares != null && shares > BigInt(0)) {
      setAmount(formatTokenAmount(shares, 18, 6));
    } else {
      setAmount("");
    }
  }, [ethBalance, shareBalance, sharesFromEth, ethFromShares]);
  const refreshShareBalance = useCallback(async () => {
    if (!account) return;
    try {
      setShareBalance(await getVaultShareBalance(account, vaultAddress));
    } catch {
      // leave whatever balance we last had — a failed read shouldn't blank
      // out a number the user was already relying on
    }
  }, [account, vaultAddress]);

  const refreshEthBalance = useCallback(async () => {
    if (!account) {
      setEthBalance(null);
      return;
    }
    try {
      setEthBalance(await getNativeBalance(account));
    } catch {
      /* keep last */
    }
  }, [account]);

  // Always show wallet share + ETH balances for trade forms (buy needs ETH,
  // sell needs shares; receive side shows the other asset you already hold).
  useEffect(() => {
    if (!account) {
      setShareBalance(null);
      setEthBalance(null);
      return;
    }
    void refreshShareBalance();
    void refreshEthBalance();
  }, [mode, account, refreshShareBalance, refreshEthBalance, vaultAddress]);

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
      void refreshEthBalance();
      void refreshLpCredit();
    } catch (e) {
      setError(decodeVaultError(e));
    } finally {
      setBusy(false);
      setTimeout(() => setStatus(null), successLabel.includes("NFT") ? 8_000 : 3_000);
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
                  kind: "remove_lp",
                  ethWei: ethWei > BigInt(0) ? ethWei.toString() : null,
                  sharesWei: sharesWei > BigInt(0) ? sharesWei.toString() : null,
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
                kind: "add_lp",
                ethWei: ethWei > BigInt(0) ? ethWei.toString() : null,
                sharesWei: sharesWei > BigInt(0) ? sharesWei.toString() : null,
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
    // Full random redeem: after step-1 confirms, immediately relay + claim so
    // the single vault-wide slot is not left for the next redeemer to free.
    return run(
      () =>
        requestAndFinishRandomRedeem(account, vaultAddress, {
          onProgress: (msg) => setStatus(msg),
          onSubmitted: (txHash) =>
            addPendingVaultTx({ txHash, kind: "redeem", ethWei: null, tokenId: null }),
        }),
      "Random redeem: locking slot…",
      "NFT claimed — redeem complete (slot free)."
    );
  };

  const activeMode = MODES.find((m) => m.id === mode)!;

  const activeKind = vaultColorKind(vaultAddress);
  const activeTag = activeKind === "v1" ? "V1" : activeKind === "v2" ? "V2" : "Vault";
  const activeLabel =
    vaultLabel ??
    (activeKind === "v1" ? "V1 vault" : activeKind === "v2" ? "V2 vault" : "Vault");

  return (
    <div className="wood-frame relative overflow-hidden rounded-2xl bg-wood-900/95">
      {/* Corner confirmation: which vault this swap widget is bound to. */}
      <div
        className={`pointer-events-none absolute right-2 top-2 z-10 rounded-md border px-2 py-1 text-[0.65rem] font-extrabold uppercase tracking-wide shadow-lg ${VAULT_LABEL_CLASS[activeKind]}`}
        title={vaultAddress ? `All actions target ${vaultAddress}` : "Vault"}
      >
        {activeTag} · live
      </div>
      {/* Header: collection art leads, same "visually dominant" rule as
          every other surface — this used to be a bare form with no branding
          or context at all. */}
      <div className="flex items-center gap-3 border-b border-gold-500/20 bg-wood-950/90 px-4 py-3 pr-20">
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
            <span className="inline-flex items-center gap-1.5">
              <span
                className={`rounded border px-1.5 py-0.5 text-[0.65rem] font-extrabold uppercase tracking-wide ${VAULT_LABEL_CLASS[activeKind]}`}
              >
                {activeTag}
              </span>
              <span className={VAULT_TEXT_CLASS[activeKind]}>{activeLabel}</span>
            </span>
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
          <div className="rounded-lg border border-gold-500/25 bg-wood-950/90 px-3 py-2 text-[0.7rem] leading-relaxed text-foreground/75">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span>
                  <span className="font-bold uppercase tracking-wide text-foreground/45">Your shares </span>
                  <span className="font-mono text-gold-200">
                    {shareBalance != null ? formatTokenAmount(shareBalance, 18, 4) : "…"}
                  </span>
                  <span className="text-foreground/45"> vROBIN</span>
                </span>
                <span>
                  <span className="font-bold uppercase tracking-wide text-foreground/45">ETH </span>
                  <span className="font-mono text-gold-200">
                    {ethBalance != null ? formatTokenAmount(ethBalance, 18, 4) : "…"}
                  </span>
                  <span className="text-foreground/45"> Ξ</span>
                </span>
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

        <div className="grid grid-cols-3 gap-1 rounded-lg border border-gold-500/20 bg-wood-900/90 p-1 sm:grid-cols-5">
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
          <div className="rounded-lg border border-gold-500/30 bg-wood-900/90 p-2.5">
            <div className="flex items-center justify-between gap-2 text-[0.6rem] font-bold uppercase tracking-wide text-foreground/45">
              <span>You pay</span>
              <span className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-0.5 font-normal normal-case">
                <span className="font-bold uppercase tracking-wide text-foreground/45">
                  {mode === "buy" ? "ETH" : "Vault share"}
                </span>
                {account && (
                  <>
                    <span className="font-mono text-foreground/70">
                      bal{" "}
                      <span className="font-semibold text-gold-200">
                        {mode === "buy"
                          ? ethBalance != null
                            ? formatTokenAmount(ethBalance, 18, 4)
                            : "…"
                          : shareBalance != null
                            ? formatTokenAmount(shareBalance, 18, 4)
                            : "…"}
                      </span>
                      {mode === "buy" ? " Ξ" : " sh"}
                    </span>
                    <button
                      type="button"
                      className="rounded border border-gold-500/35 px-1.5 py-0.5 text-[0.6rem] font-bold uppercase text-gold-300 hover:border-gold-400 hover:bg-gold-500/10"
                      onClick={() => {
                        if (mode === "buy") {
                          if (ethBalance == null || ethBalance <= BigInt(0)) return;
                          // Leave a small gas buffer so Max does not empty the wallet.
                          const gasPad = parseTokenAmount("0.0003", 18) ?? BigInt(0);
                          const usable =
                            ethBalance > gasPad ? ethBalance - gasPad : BigInt(0);
                          setAmount(
                            usable > BigInt(0) ? formatTokenAmount(usable, 18, 6) : "0"
                          );
                        } else if (shareBalance != null && shareBalance > BigInt(0)) {
                          setAmount(formatTokenAmount(shareBalance, 18, 6));
                        }
                      }}
                    >
                      Max
                    </button>
                  </>
                )}
              </span>
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
            <div className="grid grid-cols-2 gap-1 rounded-lg border border-gold-500/20 bg-wood-950/90 p-1">
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
              {lpFull === false || lpRemove === false ? (
                <>
                  <strong className="text-foreground/85">Full Add/Remove LP is on V2 only.</strong> This
                  vault build (usually <span className="font-semibold text-orange-300">V1</span>) supports{" "}
                  <strong className="text-foreground/85">Deposit</strong> and{" "}
                  <strong className="text-foreground/85">Redeem</strong>, but not tracked LP credits. Switch
                  the vault picker above to <span className="font-semibold text-emerald-300">V2</span> to Add
                  LP / Remove LP. On V1 use Sell if you want ETH for shares.
                </>
              ) : lpDirection === "add" ? (
                <>
                  <strong className="text-foreground/85">Deposit is not LP.</strong> After deposit, shares
                  sit in <em>your wallet</em> (see balance above).{" "}
                  <strong className="text-foreground/85">Add LP</strong> moves shares and/or ETH into the
                  pool
                  {lpPoolRatio
                    ? " — enter either side and the other auto-matches the pool ratio"
                    : ""}
                  {" "}(credits you for Remove LP).
                </>
              ) : (
                <>
                  Pull back shares/ETH you previously added via{" "}
                  <strong className="text-foreground/85">Add LP</strong>. Capped by your credit and live pool
                  reserves. Existing <em>deposits</em> (wallet shares) are not LP credit — use Redeem or Sell
                  for those.
                </>
              )}
            </p>
            {lpCredit && (lpCredit.shareCredit > BigInt(0) || lpCredit.ethCredit > BigInt(0)) && (
              <p className="rounded-md border border-gold-500/20 bg-wood-950/90 px-2 py-1.5 text-[0.65rem] text-gold-200/90">
                Your LP credit: {formatTokenAmount(lpCredit.shareCredit, 18, 4)} shares ·{" "}
                {formatTokenAmount(lpCredit.ethCredit, 18, 5)} Ξ
              </p>
            )}
            <div className="rounded-xl border border-gold-500/30 bg-wood-900/90 px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[0.65rem] font-bold uppercase tracking-wide text-foreground/50">
                <span>{lpDirection === "remove" ? "Shares to remove" : "Shares to add"}</span>
                <span className="flex flex-wrap items-center gap-2 font-normal normal-case">
                  {account && shareBalance != null && lpDirection === "add" && (
                    <span className="font-mono text-foreground/60">
                      bal{" "}
                      <span className="font-semibold text-gold-200">
                        {formatTokenAmount(shareBalance, 18, 4)}
                      </span>{" "}
                      sh
                    </span>
                  )}
                  {lpDirection === "add" && shareBalance != null && shareBalance > BigInt(0) && (
                    <button
                      type="button"
                      className="rounded border border-gold-500/35 px-1.5 py-0.5 text-[0.6rem] font-bold uppercase text-gold-300 hover:border-gold-400 hover:bg-gold-500/10"
                      onClick={maxLpSharesAdd}
                    >
                      Max
                    </button>
                  )}
                  {lpDirection === "remove" && lpCredit && lpCredit.shareCredit > BigInt(0) && (
                    <button
                      type="button"
                      className="rounded border border-gold-500/35 px-1.5 py-0.5 text-[0.6rem] font-bold uppercase text-gold-300 hover:border-gold-400 hover:bg-gold-500/10"
                      onClick={() => {
                        setLpEditSide("shares");
                        setAmount(formatTokenAmount(lpCredit.shareCredit, 18, 6));
                      }}
                    >
                      Max {formatTokenAmount(lpCredit.shareCredit, 18, 4)}
                    </button>
                  )}
                </span>
              </div>
              <input
                type="text"
                inputMode="decimal"
                placeholder="0.0"
                value={amount}
                onChange={(e) =>
                  lpDirection === "add"
                    ? onLpSharesChange(e.target.value)
                    : setAmount(e.target.value.replace(/[^0-9.]/g, ""))
                }
                className="mt-1 w-full bg-transparent text-xl font-semibold text-foreground outline-none"
              />
            </div>
            <div className="rounded-xl border border-gold-500/30 bg-wood-900/90 px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[0.65rem] font-bold uppercase tracking-wide text-foreground/50">
                <span>
                  {lpDirection === "remove"
                    ? "ETH to remove"
                    : lpFull
                      ? "ETH to add"
                      : "ETH to add (optional)"}
                </span>
                <span className="flex flex-wrap items-center gap-2 font-normal normal-case">
                  {account && ethBalance != null && lpDirection === "add" && lpFull && (
                    <span className="font-mono text-foreground/60">
                      bal{" "}
                      <span className="font-semibold text-gold-200">
                        {formatTokenAmount(ethBalance, 18, 4)}
                      </span>{" "}
                      Ξ
                    </span>
                  )}
                  {lpDirection === "add" &&
                    lpFull &&
                    ethBalance != null &&
                    ethBalance > BigInt(0) && (
                      <button
                        type="button"
                        className="rounded border border-gold-500/35 px-1.5 py-0.5 text-[0.6rem] font-bold uppercase text-gold-300 hover:border-gold-400 hover:bg-gold-500/10"
                        onClick={maxLpEthAdd}
                      >
                        Max
                      </button>
                    )}
                  {lpDirection === "remove" && lpCredit && lpCredit.ethCredit > BigInt(0) ? (
                    <button
                      type="button"
                      className="rounded border border-gold-500/35 px-1.5 py-0.5 text-[0.6rem] font-bold uppercase text-gold-300 hover:border-gold-400 hover:bg-gold-500/10"
                      onClick={() => {
                        setLpEditSide("eth");
                        setLpEth(formatTokenAmount(lpCredit.ethCredit, 18, 6));
                      }}
                    >
                      Max {formatTokenAmount(lpCredit.ethCredit, 18, 5)} Ξ
                    </button>
                  ) : lpDirection === "remove" ? (
                    <span className="text-gold-300">Ξ</span>
                  ) : null}
                </span>
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
                onChange={(e) =>
                  lpDirection === "add"
                    ? onLpEthChange(e.target.value)
                    : setLpEth(e.target.value.replace(/[^0-9.]/g, ""))
                }
                className="mt-1 w-full bg-transparent text-xl font-semibold text-foreground outline-none disabled:opacity-40"
              />
            </div>
            {lpDirection === "add" && lpFull && lpPoolRatio && (
              <p className="text-[0.6rem] text-foreground/50">
                Auto-balance uses pool ratio{" "}
                <span className="font-mono text-foreground/70">
                  1 sh ≈{" "}
                  {formatTokenAmount(
                    (lpPoolRatio.ethR * BigInt(10) ** BigInt(18)) / lpPoolRatio.shareR,
                    18,
                    6
                  )}{" "}
                  Ξ
                </span>
                {lpEditSide ? (
                  <>
                    {" "}
                    · last edited <strong className="text-foreground/75">{lpEditSide}</strong>
                  </>
                ) : null}
                . Max caps to your wallet on both sides.
              </p>
            )}
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
          <div className="rounded-lg border border-dashed border-gold-500/25 bg-wood-950/90 px-2.5 py-2">
            <div className="flex items-center justify-between gap-2 text-[0.6rem] font-bold uppercase tracking-wide text-foreground/45">
              <span>You receive</span>
              <span className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-0.5 font-normal normal-case">
                <span className="font-bold uppercase tracking-wide text-foreground/45">
                  {mode === "buy" ? "Vault share" : "ETH"}
                </span>
                {account && (
                  <span className="font-mono text-foreground/70">
                    bal{" "}
                    <span className="font-semibold text-gold-200">
                      {mode === "buy"
                        ? shareBalance != null
                          ? formatTokenAmount(shareBalance, 18, 4)
                          : "…"
                        : ethBalance != null
                          ? formatTokenAmount(ethBalance, 18, 4)
                          : "…"}
                    </span>
                    {mode === "buy" ? " sh" : " Ξ"}
                    <span className="text-foreground/40"> now</span>
                  </span>
                )}
              </span>
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
          <label className="flex items-center justify-between gap-2 rounded-lg border border-gold-500/20 bg-wood-900/90 px-2.5 py-2">
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
            <div className="grid grid-cols-2 gap-1 rounded-lg border border-gold-500/20 bg-wood-900/90 p-1">
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
                  <strong className="text-foreground/70">Random</strong> locks the vault slot, then
                  auto-finishes via a gas-sponsored relayer (you only sign the request). Keep
                  this tab open and approve wallet prompts (usually 2–3 txs).
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
                    : "border-gold-500/20 bg-wood-950/90 text-foreground/60"
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
                    : "Random redeem (1 signature)"
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
