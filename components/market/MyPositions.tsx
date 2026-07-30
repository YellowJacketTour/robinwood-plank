"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  cancelOrder,
  getMarketApprovals,
  revokeCollectionApproval,
  revokeWethApproval,
  type MarketApprovals,
} from "@/lib/market/seaport";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import { formatTokenAmount } from "@/lib/trade";
import type { Listing, Offer } from "@/lib/market/types";

type Props = {
  account: string;
  listings: Array<Listing & { rawOrder: unknown }>;
  offers: Array<Offer & { rawOrder: unknown }>;
  onChanged: () => void;
};

type Row = {
  id: string;
  kind: "Listing" | "Offer";
  tokenId?: string;
  traits?: Array<{ traitType: string; value: string }>;
  criteriaTokenIds?: string[];
  priceWei: string;
  expiresAt: string;
  rawOrder: unknown;
};

const COLLECTION = MARKET_COLLECTIONS[0];

/** Desktop: table. Mobile: the same rows stacked as cards — SPEC.md §4. */
export default function MyPositions({ account, listings, offers, onChanged }: Props) {
  const [scope, setScope] = useState<"Listing" | "Offer">("Listing");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<MarketApprovals | null>(null);
  const [approvalLoading, setApprovalLoading] = useState(true);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<"nft" | "weth" | null>(null);

  const mine: Row[] = [
    ...listings
      .filter((l) => l.maker.toLowerCase() === account.toLowerCase())
      .map((l) => ({
        id: l.id,
        kind: "Listing" as const,
        tokenId: l.tokenId,
        priceWei: l.priceWei,
        expiresAt: l.expiresAt,
        rawOrder: l.rawOrder,
      })),
    ...offers
      .filter((o) => o.maker?.toLowerCase() === account.toLowerCase())
      .map((o) => ({
        id: o.id,
        kind: "Offer" as const,
        tokenId: o.tokenId,
        traits: o.traits,
        criteriaTokenIds: o.criteriaTokenIds,
        priceWei: o.priceWei,
        expiresAt: o.expiresAt,
        rawOrder: o.rawOrder,
      })),
  ];

  const refreshApprovals = useCallback(async () => {
    if (!COLLECTION) return;
    try {
      const next = await getMarketApprovals(account, COLLECTION.contractAddress);
      setApprovals(next);
      setApprovalError(null);
    } catch {
      setApprovalError("Could not read marketplace approvals.");
    } finally {
      setApprovalLoading(false);
    }
  }, [account]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void refreshApprovals();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [refreshApprovals]);

  const cancel = useCallback(
    async (row: Row) => {
      setError(null);
      try {
        setBusyId(row.id);
        // Routed through lib/wallet.ts (chain re-check + destination
        // allowlist + pre-flight simulation), not a raw ethers signer.
        const raw = row.rawOrder as {
          parameters: Parameters<typeof cancelOrder>[0];
        };
        await cancelOrder(raw.parameters, account);

        // Cancelling on-chain doesn't remove the order from the relay, so
        // without this the dead listing keeps showing and buyers waste gas
        // reverting on it. The endpoint re-checks Seaport itself before
        // removing anything, so this is a hint, not an authorization.
        await fetch(`/api/market/orders?id=${encodeURIComponent(row.id)}`, {
          method: "DELETE",
        }).catch(() => {});

        onChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not cancel.");
      } finally {
        setBusyId(null);
      }
    },
    [account, onChanged]
  );

  const revoke = useCallback(
    async (which: "nft" | "weth") => {
      if (!COLLECTION || revoking) return;
      setError(null);
      try {
        setRevoking(which);
        if (which === "nft") {
          await revokeCollectionApproval(account, COLLECTION.contractAddress);
        } else {
          await revokeWethApproval(account);
        }
        await refreshApprovals();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not revoke.");
      } finally {
        setRevoking(null);
      }
    },
    [account, revoking, refreshApprovals]
  );

  const hasLiveApproval =
    approvals !== null &&
    (approvals.collectionApprovedForAll || approvals.wethAllowance > BigInt(0));
  const visible = mine.filter((row) => row.kind === scope);
  const listingCount = mine.filter((row) => row.kind === "Listing").length;
  const offerCount = mine.length - listingCount;

  return (
    <div className="space-y-3">
      {error && (
        <p className="px-3 text-center text-xs text-red-300" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[0.6rem] font-black uppercase tracking-[0.14em] text-gold-300/75">Your market desk</p>
          <h3 className="font-display text-xl text-gold-300">Open positions</h3>
          <p className="text-xs text-cream-muted">
            Listings and offers remain separate and cancellable.
          </p>
        </div>
        <div className="grid grid-cols-2 rounded-lg border border-line bg-wood-950 p-1">
          {(["Listing", "Offer"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => setScope(kind)}
              className={`min-h-9 rounded-md px-3 text-xs font-bold ${
                scope === kind
                  ? "bg-gold-500 text-wood-950"
                  : "text-foreground/65 hover:text-gold-300"
              }`}
            >
              {kind === "Listing" ? "Listings" : "Offers"}{" "}
              <span aria-hidden>{kind === "Listing" ? listingCount : offerCount}</span>
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-xl border border-line bg-panel px-4 py-8 text-center text-sm text-cream-muted">
          No active {scope === "Listing" ? "listings" : "offers"}.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line">
          <div className="hidden bg-[rgba(219,165,63,0.07)] px-3 py-2 text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted sm:flex sm:items-center sm:justify-between sm:gap-3">
            <span>Position</span>
            <span>Price / Expiry</span>
          </div>
          <ul>
            {visible.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 border-t border-line bg-panel px-3 py-2.5 first:border-t-0"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      background: row.kind === "Listing" ? "var(--gold-400, #efc463)" : "#60d890",
                    }}
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-foreground">
                      {row.kind} ·{" "}
                      {row.tokenId
                        ? `#${row.tokenId}`
                        : row.traits?.length
                          ? row.traits
                              .map((trait) => `${trait.traitType}: ${trait.value}`)
                              .join(" AND ")
                          : `${row.criteriaTokenIds?.length ?? 0} qualifying Planks`}
                    </p>
                    <p className="text-[0.65rem] text-cream-muted">
                      {/* Listings settle in native ETH; bids are WETH-denominated
                          because Seaport cannot pull ETH from an offerer. Labelling
                          both "Ξ" would misstate what actually moves. */}
                      {formatTokenAmount(row.priceWei, 18, 4)}{" "}
                      {row.kind === "Offer" ? "WETH" : "Ξ"} · expires{" "}
                      {new Date(row.expiresAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                      {!row.tokenId && row.criteriaTokenIds
                        ? ` · ${row.criteriaTokenIds.length} qualify`
                        : ""}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busyId === row.id}
                  onClick={() => cancel(row)}
                  className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border border-red-500/30 px-3 text-xs font-bold text-red-300 transition hover:border-red-400 disabled:opacity-50"
                >
                  {busyId === row.id ? <Loader2 size={13} strokeWidth={2.5} className="animate-spin" /> : "Cancel"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Live marketplace approvals — cancelling an order does NOT undo the
          approval that was granted while creating it, so surface + revoke
          them here (audit 2026-07-27). */}
      {approvalLoading ? (
        <div className="rounded-xl border border-line bg-panel p-3 text-xs text-cream-muted">
          Reading marketplace approvals…
        </div>
      ) : approvalError ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-panel p-3"
          role="alert"
        >
          <p className="text-xs text-red-300">{approvalError}</p>
          <button
            type="button"
            onClick={() => {
              setApprovalLoading(true);
              setApprovalError(null);
              void refreshApprovals();
            }}
            className="min-h-9 rounded-md border border-line-strong px-3 text-xs font-bold text-gold-300"
          >
            Retry approvals
          </button>
        </div>
      ) : approvals && COLLECTION ? (
        <div className="rounded-xl border border-line bg-panel space-y-2 p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[0.76rem] font-black uppercase tracking-[0.06em] text-foreground">
              Marketplace approvals
            </p>
            <span
              className={`flex items-center gap-1.5 rounded-full border px-2 py-1 text-[0.62rem] font-bold ${
                hasLiveApproval
                  ? "border-emerald-400/30 text-emerald-300"
                  : "border-line text-foreground/45"
              }`}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: hasLiveApproval ? "#60d890" : "currentColor" }}
                aria-hidden
              />
              {hasLiveApproval ? "Active" : "Inactive"}
            </span>
          </div>
          {mine.length === 0 && (
            <p className="text-[0.65rem] text-cream-muted">
              You have no active orders, but the marketplace still holds these
              permissions from earlier ones. Revoking them costs a little gas
              and takes nothing else.
            </p>
          )}
          <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-wood-950 px-3 py-2">
            <p className="text-xs text-foreground/70">
              {COLLECTION.name}:{" "}
              {approvals.collectionApprovedForAll
                ? "transfer approval for the whole collection"
                : "not approved"}
            </p>
            {approvals.collectionApprovedForAll && (
              <button
                type="button"
                disabled={revoking !== null}
                onClick={() => revoke("nft")}
                className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border border-red-500/30 px-3 text-xs font-bold text-red-300 transition hover:border-red-400 disabled:opacity-50"
              >
                {revoking === "nft" ? <Loader2 size={13} strokeWidth={2.5} className="animate-spin" /> : "Revoke"}
              </button>
            )}
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-wood-950 px-3 py-2">
            <p className="text-xs text-foreground/70">
              WETH allowance: {formatTokenAmount(approvals.wethAllowance.toString(), 18, 4)}
            </p>
            {approvals.wethAllowance > BigInt(0) && (
              <button
                type="button"
                disabled={revoking !== null}
                onClick={() => revoke("weth")}
                className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border border-red-500/30 px-3 text-xs font-bold text-red-300 transition hover:border-red-400 disabled:opacity-50"
              >
                {revoking === "weth" ? <Loader2 size={13} strokeWidth={2.5} className="animate-spin" /> : "Revoke"}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-line bg-panel p-3 text-xs text-cream-muted" role="status">
          Marketplace approvals are unavailable.
        </div>
      )}
    </div>
  );
}
