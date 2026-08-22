"use client";

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  defaultFirstClause,
  formatCriteriaLabel,
  resolveCriteriaTokenIds,
  type CriteriaClause,
} from "@/lib/market/trait-criteria";
import type { TraitIndexResponse } from "@/lib/market/traits";
import { parseTokenAmount } from "@/lib/trade";
import { MARKETPLANK_NATIVE_LISTING_FEE_BPS } from "@/lib/constants";
import type { Listing, MarketCollection } from "@/lib/market/types";
import { chainDisplayName, foreignChainByChainSlug, foreignOfferCurrency, foreignRpcUrls, FOREIGN_SEAPORT_ADDRESS } from "@/lib/market/multichain/trading/foreign-chain-registry";
import EthUsdValue from "@/components/market/EthUsdValue";
import TraitCriteriaPicker from "@/components/market/TraitCriteriaPicker";
import { swrJson } from "@/lib/market/swr-fetch";
import { ensureChain } from "@/lib/wallet";
import CriteriaBidValueHud from "@/components/market/CriteriaBidValueHud";

type Props = {
  chainSlug: string;
  currencySymbol: string;
  account: string | null;
  collection: MarketCollection;
  listings?: Array<Pick<Listing, "tokenId" | "priceWei">>;
  onSubmitted: () => void;
  onConnect?: () => void;
};

const DURATIONS = [1, 3, 7, 30];

/**
 * Marketplank-native counterpart to ForeignOfferForm.tsx -- same
 * TraitCriteriaPicker, same pure resolveCriteriaTokenIds/formatCriteriaLabel
 * (trait-criteria.ts, entirely chain-agnostic, reused unchanged), same
 * review-before-sign UX. The real difference: this posts a signed order
 * directly to Marketplank (app/api/market/multichain/native-orders) at
 * MARKETPLANK_NATIVE_LISTING_FEE_BPS instead of building+submitting a
 * router-fee-mediated OpenSea order (foreign-offer.ts's buildForeignOffer).
 * A seller can accept this from ANY of their qualifying owned tokens --
 * see MultichainCollectionView.tsx's handleAcceptOffer native branch,
 * which mirrors MarketView.tsx's already-proven
 * assertAcceptableTraitOffer flow for the Robinhood-chain path.
 */
export default function NativeForeignOfferForm({ chainSlug, currencySymbol, account, collection, listings, onSubmitted, onConnect }: Props) {
  const [priceEth, setPriceEth] = useState("");
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [indexReloadKey, setIndexReloadKey] = useState(0);

  const [index, setIndex] = useState<TraitIndexResponse | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [clauses, setClauses] = useState<CriteriaClause[]>([]);

  useEffect(() => {
    let cancelled = false;
    swrJson<TraitIndexResponse>(
      `/api/market/multichain/trait-index?chainSlug=${chainSlug}&collectionSlug=${encodeURIComponent(collection.slug)}`,
      { ttlMs: 300_000, swrMs: 3_600_000, session: true, isGood: (d) => Boolean((d as TraitIndexResponse)?.complete) }
    )
      .then((res) => {
        if (cancelled) return;
        setIndex(res);
        if (res.complete && res.traits) {
          setClauses((prev) => {
            if (prev.length > 0) return prev;
            const first = defaultFirstClause(res.traits!);
            return first ? [first] : [];
          });
        }
      })
      .catch((e) => {
        if (!cancelled) setIndexError(e instanceof Error ? e.message : "Could not load traits.");
      });
    return () => {
      cancelled = true;
    };
  }, [chainSlug, collection.slug, indexReloadKey]);

  const qualifyingIds = useMemo(() => resolveCriteriaTokenIds(index?.traits, clauses, index?.rankings), [index, clauses]);
  const offerWei = useMemo(() => parseTokenAmount(priceEth, 18), [priceEth]);
  const feePct = MARKETPLANK_NATIVE_LISTING_FEE_BPS / 100;

  const submit = async () => {
    setError(null);
    setSuccess(null);
    if (!account) {
      onConnect?.();
      return;
    }
    const wei = parseTokenAmount(priceEth, 18);
    if (wei === null || wei <= 0n) {
      setError("Enter an amount.");
      return;
    }
    if (clauses.length === 0 || qualifyingIds.length === 0) {
      setError("Pick at least one trait or rarity that matches some items.");
      return;
    }
    try {
      setBusy(true);
      const target = foreignChainByChainSlug(chainSlug);
      if (!target) throw new Error(`"${chainSlug}" is not a supported foreign chain.`);
      await ensureChain({
        chainId: target.chainId,
        name: chainDisplayName(chainSlug),
        nativeCurrencySymbol: target.nativeCurrencySymbol,
        rpcUrl: foreignRpcUrls(chainSlug)[0],
        blockExplorerUrl: target.blockExplorerUrl,
      });

      const { buildOffer } = await import("@/lib/market/seaport");
      const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
      const rawOrder = await buildOffer(
        account,
        {
          offerWei: wei.toString(),
          considerationTokenAddress: collection.contractAddress,
          criteriaTokenIds: qualifyingIds,
          expiresAt,
          feeBps: MARKETPLANK_NATIVE_LISTING_FEE_BPS,
          royaltyBps: 0,
          royaltyRecipient: "0x0000000000000000000000000000000000000000",
          offerCurrency: foreignOfferCurrency(chainSlug) ?? undefined,
        },
        {
          chainSlug,
          chainId: target.chainId,
          chainName: chainDisplayName(chainSlug),
          nativeCurrencySymbol: target.nativeCurrencySymbol,
          rpcUrl: foreignRpcUrls(chainSlug)[0],
          blockExplorerUrl: target.blockExplorerUrl,
          seaportAddress: FOREIGN_SEAPORT_ADDRESS,
        }
      );

      const res = await fetch("/api/market/multichain/native-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chainSlug,
          kind: "offer",
          contractAddress: collection.contractAddress,
          rawOrder,
          // ALL clause kinds must be transmitted -- an omitted clause (e.g.
          // "rank" dropped) would make the server re-derive a DIFFERENT
          // token-id set than what the client signed the order's Merkle
          // root against, failing verification with a real, confusing
          // "criteria root mismatch" instead of a clear error here.
          criteria: {
            traits: clauses.filter((c) => c.kind === "trait"),
            rarityTier: clauses.find((c) => c.kind === "rarity")?.tier,
            rankMax: clauses.find((c) => c.kind === "rank")?.maxRank,
          },
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) throw new Error(data.message || "The relay rejected this bid.");

      setPriceEth("");
      setReviewOpen(false);
      setSuccess("Bid placed directly with Marketplank -- no router, no third party.");
      onSubmitted();
    } catch (e) {
      console.error("Native criteria offer failed:", e);
      setError(e instanceof Error ? e.message : "Offer failed.");
    } finally {
      setBusy(false);
    }
  };

  const traitReady = Boolean(index?.complete && index.traits && clauses.length > 0 && qualifyingIds.length > 0);

  const openReview = () => {
    setError(null);
    setSuccess(null);
    const wei = parseTokenAmount(priceEth, 18);
    if (wei === null || wei <= 0n) {
      setError("Enter an amount.");
      return;
    }
    if (clauses.length === 0 || qualifyingIds.length === 0) {
      setError("Pick at least one trait or rarity that matches some items.");
      return;
    }
    setReviewOpen(true);
  };

  return (
    <div className="wood-ledger w-full space-y-3 rounded-xl border border-line p-4">
      {reviewOpen && (
        <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="native-offer-review-title">
          <div className="wood-ledger w-full max-w-lg rounded-t-xl border border-line-strong p-4 sm:rounded-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[0.65rem] font-black uppercase tracking-[0.14em] text-gold-300/75">Verify before signing</p>
                <h3 id="native-offer-review-title" className="mt-1 font-display text-2xl text-gold-300">
                  Review criteria bid
                </h3>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setReviewOpen(false);
                }}
                className="flex h-10 w-10 items-center justify-center rounded-md border border-line text-foreground/65 hover:text-gold-300 disabled:opacity-40"
                aria-label="Close review"
              >
                <X size={14} strokeWidth={2.5} />
              </button>
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-line bg-wood-950 px-3 py-2">
                <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Scope</dt>
                <dd className="mt-1 text-xs font-bold text-foreground">{formatCriteriaLabel(clauses)}</dd>
              </div>
              <div className="rounded-lg border border-line bg-wood-950 px-3 py-2">
                <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Qualifying</dt>
                <dd className="mt-1 text-xs font-bold text-foreground">{qualifyingIds.length} items</dd>
              </div>
              <div className="rounded-lg border border-line bg-wood-950 px-3 py-2">
                <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Offer</dt>
                <dd className="mt-1 text-xs font-bold text-foreground">
                  <span className="block">
                    {priceEth} {currencySymbol}
                  </span>
                  <EthUsdValue wei={offerWei} className="mt-0.5 block text-[0.65rem] text-foreground/50" />
                </dd>
              </div>
              <div className="rounded-lg border border-line bg-wood-950 px-3 py-2">
                <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Duration</dt>
                <dd className="mt-1 text-xs font-bold text-foreground">{days} days</dd>
              </div>
              <div className="col-span-2 rounded-lg border border-line bg-wood-950 px-3 py-2">
                <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Chain</dt>
                <dd className="mt-1 text-xs font-bold text-foreground">{chainDisplayName(chainSlug)} · Seaport 1.6 · Marketplank direct ({feePct}% fee)</dd>
              </div>
            </dl>

            <p className="mt-3 text-xs leading-5 text-foreground/55">
              This is a direct Marketplank bid, not an OpenSea order -- any seller who owns a qualifying item can
              accept it straight against Seaport. {currencySymbol} balance, allowance, expiry, and the order payload
              are checked before signing. The token-id set is snapshotted into the signed order&apos;s Merkle root at this
              exact moment.
            </p>

            {error && (
              <p role="alert" className="mt-3 rounded-lg border border-red-500/35 bg-red-950/25 px-3 py-2.5 text-sm text-red-100">
                {error}
              </p>
            )}

            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setReviewOpen(false);
                }}
                className="min-h-11 rounded-lg border border-line text-sm text-foreground/75 hover:text-gold-300 disabled:opacity-40"
              >
                Back
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void submit()}
                className="min-h-11 rounded-lg bg-gold-500 text-sm font-bold text-wood-950 hover:bg-gold-400 disabled:opacity-50"
              >
                {busy ? "Confirm in wallet…" : account ? "Continue to wallet" : "Connect wallet & continue"}
              </button>
            </div>
          </div>
        </div>
      )}

      <h3 className="font-display text-lg text-gold-300">Build a criteria bid -- direct with Marketplank</h3>

      <div className="space-y-2">
        <p className="text-center text-[0.65rem] text-foreground/55">
          Same scopes as Sweep: rarity tier, single trait, or AND combo. Any seller of a matching item can accept
          directly -- no OpenSea, {feePct}% Marketplank fee baked into the signed order.
        </p>
        <div className="flex flex-wrap justify-center gap-1">
          {(
            [
              { id: "rarity", label: "Rarity" },
              { id: "trait", label: "Trait" },
              { id: "combo", label: "Combo" },
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                if (!index?.traits) return;
                if (m.id === "rarity") {
                  setClauses([{ kind: "rarity", tier: "Rare" }]);
                } else if (m.id === "trait") {
                  const first = defaultFirstClause(index.traits);
                  setClauses(first ? [first] : []);
                } else {
                  const first = defaultFirstClause(index.traits);
                  setClauses(first ? [first, { kind: "rarity", tier: "Epic" }] : [{ kind: "rarity", tier: "Epic" }]);
                }
              }}
              className="min-h-8 rounded-md border border-line-strong px-2.5 text-[0.65rem] font-bold text-gold-300 transition hover:border-gold-400"
            >
              {m.label}
            </button>
          ))}
        </div>
        <TraitCriteriaPicker
          traits={index?.traits ?? null}
          rankings={index?.rankings}
          complete={Boolean(index?.complete && index.traits)}
          building={index?.building}
          scanned={index?.scanned}
          totalSupply={index?.totalSupply}
          loading={!index && !indexError}
          loadError={indexError}
          onRetry={() => {
            setIndexError(null);
            setIndex(null);
            setIndexReloadKey((key) => key + 1);
          }}
          clauses={clauses}
          onChange={setClauses}
          listings={listings}
        />
        {clauses.length > 0 && qualifyingIds.length > 0 && (
          <p className="text-center text-[0.6rem] text-foreground/40">
            Bid locks {formatCriteriaLabel(clauses)} · {qualifyingIds.length} items snapshotted into the signed order.
          </p>
        )}
        <CriteriaBidValueHud offerWei={offerWei} qualifyingIds={qualifyingIds} listings={listings} currencySymbol={currencySymbol} totalFeeBps={MARKETPLANK_NATIVE_LISTING_FEE_BPS} />
      </div>

      <div className="flex min-h-12 items-center gap-2 rounded-lg border border-line bg-panel px-2.5">
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.0"
          value={priceEth}
          onChange={(e) => setPriceEth(e.target.value.replace(/[^0-9.]/g, ""))}
          className="min-w-0 flex-1 bg-transparent py-2.5 text-lg font-semibold text-foreground outline-none"
        />
        <span className="text-xs font-bold text-gold-300">{currencySymbol}</span>
      </div>
      <EthUsdValue wei={offerWei} className="block text-right text-[0.65rem] text-foreground/50" />

      <div className="flex gap-1.5">
        {DURATIONS.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDays(d)}
            className={`min-h-9 flex-1 rounded-md text-xs font-bold ${days === d ? "bg-gold-500 text-wood-950" : "border border-line text-foreground/70"}`}
          >
            {d}d
          </button>
        ))}
      </div>

      <p className="text-center text-[0.65rem] text-foreground/50">
        {feePct}% Marketplank fee, fixed -- the real order posts directly to Marketplank, not OpenSea&apos;s orderbook.
      </p>

      <button
        type="button"
        disabled={busy || !traitReady}
        onClick={openReview}
        className="min-h-12 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950 transition hover:bg-gold-400 disabled:opacity-50"
      >
        {busy ? "Signing…" : "Review & sign criteria bid"}
      </button>
      {error && (
        <p className="text-center text-xs text-red-300" role="alert">
          {error}
        </p>
      )}
      {success && (
        <p className="text-center text-xs text-emerald-300" role="status">
          {success}
        </p>
      )}
    </div>
  );
}
