"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { tierColor, tierGlow } from "@/lib/market/rarityClient";
import type { RarityLookup } from "@/lib/market/rarityClient";
import CachedNftImage from "@/components/CachedNftImage";
import { warmArtOnce } from "@/lib/art-warm-global";

type HeldToken = { tokenId: string; imageUrl: string | null };

type DragState = {
  tokenId: string;
  pointerId: number;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
};

type HoverInfo = { tokenId: string; left: number; top: number };

/**
 * The vault's held NFTs as an actual fence — vertical boards standing side
 * by side, not free-floating bubbles. Hover (or tap, on touch) lifts a
 * board and shows its real stats: name, rarity tier/rank/percentile
 * ("depth" into the collection), all from the same live rarity map every
 * other surface uses. Each board is also draggable — pick it up, fling it,
 * it springs back to its slot, the plank equivalent of pulling a board off
 * a fence and letting it snap back.
 */
export default function PlankFence({
  held,
  rarity,
}: {
  held: HeldToken[] | null;
  rarity: Map<string, RarityLookup>;
}) {
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [settling, setSettling] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  /** Client backfill for boards the held API still returned without art. */
  const [imageOverrides, setImageOverrides] = useState<Record<string, string>>({});

  // Warm boards with URLs (deduped globally with LivingLiquidityViz).
  useEffect(() => {
    if (!held?.length) return;
    warmArtOnce(
      held.map((t) => ({
        tokenId: t.tokenId,
        imageUrl: t.imageUrl || imageOverrides[t.tokenId],
      })),
      { concurrency: 3, flags: { vault: true } }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held]);

  useEffect(() => {
    if (!held?.length) return;
    const missing = held.filter((t) => !t.imageUrl && !imageOverrides[t.tokenId]);
    if (missing.length === 0) return;
    let cancelled = false;
    const CONCURRENCY = 4;
    (async () => {
      for (let i = 0; i < missing.length; i += CONCURRENCY) {
        if (cancelled) return;
        const slice = missing.slice(i, i + CONCURRENCY);
        await Promise.all(
          slice.map(async (t) => {
            try {
              const r = await fetch(`/api/market/token?tokenId=${encodeURIComponent(t.tokenId)}`);
              if (!r.ok) return;
              const d = (await r.json()) as { image?: string | null };
              if (d.image && !cancelled) {
                setImageOverrides((prev) =>
                  prev[t.tokenId] ? prev : { ...prev, [t.tokenId]: d.image! }
                );
              }
            } catch {
              /* keep placeholder board */
            }
          })
        );
      }
    })();
    return () => {
      cancelled = true;
    };
    // Only re-run when membership/image list identity changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held]);

  const onPointerEnter = useCallback((e: React.PointerEvent<HTMLDivElement>, tokenId: string) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setHover({ tokenId, left: rect.left + rect.width / 2, top: rect.top });
  }, []);

  const onPointerLeave = useCallback((tokenId: string) => {
    setHover((h) => (h?.tokenId === tokenId ? null : h));
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>, tokenId: string) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const next: DragState = { tokenId, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, dx: 0, dy: 0 };
    dragRef.current = next;
    setDrag(next);
    setSettling(null);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const cur = dragRef.current;
    if (!cur || cur.pointerId !== e.pointerId) return;
    const next = { ...cur, dx: e.clientX - cur.startX, dy: e.clientY - cur.startY };
    dragRef.current = next;
    setDrag(next);
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const cur = dragRef.current;
    if (!cur || cur.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    // A quick, satisfying spring back into the fence line — the "throw"
    // reads in the release, not a physics sim: the further it was flung,
    // the more it overshoots on the way back.
    setSettling(cur.tokenId);
    window.setTimeout(() => setSettling((s) => (s === cur.tokenId ? null : s)), 450);
  }, []);

  if (!held) {
    return (
      <div className="flex h-full items-center justify-center gap-1 px-3">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="h-4/5 w-6 animate-pulse rounded-sm bg-wood-900/70" />
        ))}
      </div>
    );
  }

  if (held.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-3 text-center text-xs text-foreground/40">
        Fence is empty — nothing held right now.
      </div>
    );
  }

  const hoveredToken = hover ? held.find((t) => t.tokenId === hover.tokenId) : undefined;
  const hoveredRarity = hover ? rarity.get(hover.tokenId) : undefined;
  const hoveredColor = hoveredRarity ? tierColor(hoveredRarity.tier) : "rgba(212,175,90,0.5)";

  return (
    <>
      <div className="flex h-full items-end gap-[3px] overflow-x-auto overflow-y-visible px-3 pb-3 pt-2">
        {held.map((t) => {
          const r = rarity.get(t.tokenId) ?? rarity.get(String(Number(t.tokenId)));
          const color = r ? tierColor(r.tier) : "rgba(212,175,90,0.5)";
          const glow = r ? tierGlow(r.tier) : "0 0 8px rgba(212,175,90,0.2)";
          const isHovered = hover?.tokenId === t.tokenId;
          const isDragging = drag?.tokenId === t.tokenId;
          const isSettling = settling === t.tokenId;
          const artUrl = t.imageUrl || imageOverrides[t.tokenId] || null;
          const transform = isDragging
            ? `translate(${drag!.dx}px, ${drag!.dy}px) rotate(${Math.max(-18, Math.min(18, drag!.dx / 6))}deg) scale(1.08)`
            : undefined;

          return (
            <div
              key={t.tokenId}
              className="relative shrink-0 touch-none select-none"
              // Tall fence posts — art fills the post (object-cover), with a
              // thin top/bottom margin of board color. object-contain made
              // square NFTs render as tiny centered squares on tall posts.
              style={{ width: 28, height: "90%" }}
              onPointerEnter={(e) => onPointerEnter(e, t.tokenId)}
              onPointerLeave={() => onPointerLeave(t.tokenId)}
              onPointerDown={(e) => onPointerDown(e, t.tokenId)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <div
                className={`relative h-full w-full cursor-grab overflow-hidden rounded-t-sm border-x border-t border-black/40 bg-[#0a1f0a] shadow-[inset_0_0_8px_rgba(0,0,0,0.5)] transition-[box-shadow,transform] duration-150 active:cursor-grabbing ${
                  isSettling ? "duration-[450ms] ease-[cubic-bezier(0.34,1.56,0.64,1)]" : ""
                }`}
                style={{
                  boxShadow: isHovered || isDragging ? `0 0 16px 3px ${color}, ${glow}` : glow,
                  borderColor: isHovered ? color : undefined,
                  transform,
                  zIndex: isDragging ? 30 : isHovered ? 20 : 1,
                }}
              >
                {artUrl ? (
                  <div className="absolute inset-x-0 top-1 bottom-1">
                    <CachedNftImage
                      imageUrl={artUrl}
                      tokenId={t.tokenId}
                      alt={`#${t.tokenId}`}
                      fill
                      sizes="28px"
                      className="object-cover object-center"
                      vault
                    />
                  </div>
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-[0.5rem] text-foreground/30">
                    #{t.tokenId}
                  </div>
                )}
                {/* Wood-grain seam so it reads as a board, not just a cropped photo */}
                <div className="pointer-events-none absolute inset-y-0 right-0 w-px bg-black/30" />
              </div>
            </div>
          );
        })}
      </div>

      {/* Rendered as a fixed-position sibling OUTSIDE the fence's scroll
          container on purpose — an absolutely-positioned popover nested
          inside overflow-x-auto (needed for the horizontal fence scroll)
          gets silently clipped by it regardless of overflow-y, which is
          why this was showing up cut off instead of prominent. Fixed
          positioning is anchored to the viewport via the hovered board's
          real on-screen rect (measured on pointerEnter), so it's never
          clipped by any ancestor and always draws on top. */}
      {hover && hoveredToken && !drag && (
        <div
          className="pointer-events-none fixed z-[200] w-40 -translate-x-1/2 -translate-y-[calc(100%+10px)] rounded-lg border bg-wood-950/98 p-2.5 text-left shadow-2xl"
          style={{ left: hover.left, top: hover.top, borderColor: hoveredColor }}
        >
          <p className="truncate text-xs font-bold" style={{ color: hoveredColor }}>
            {hoveredRarity?.name ?? `#${hover.tokenId}`}
          </p>
          <p className="mt-0.5 font-mono text-[0.6rem] text-foreground/50">#{hover.tokenId}</p>
          {hoveredRarity ? (
            <dl className="mt-1.5 space-y-0.5 text-[0.6rem] text-foreground/70">
              <div className="flex justify-between gap-2">
                <dt className="text-foreground/40">Tier</dt>
                <dd className="font-bold" style={{ color: hoveredColor }}>{hoveredRarity.tier}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-foreground/40">Rank</dt>
                <dd>#{hoveredRarity.rank}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-foreground/40">Depth</dt>
                <dd>beats {hoveredRarity.percentile.toFixed(0)}%</dd>
              </div>
            </dl>
          ) : (
            <p className="mt-1.5 text-[0.6rem] text-foreground/40">Not yet scored</p>
          )}
          <div
            className="absolute left-1/2 top-full h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r bg-wood-950"
            style={{ borderColor: hoveredColor }}
          />
        </div>
      )}
    </>
  );
}
