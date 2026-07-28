"use client";

import { useCallback, useRef, useState } from "react";
import Image from "next/image";
import { tierColor, tierGlow } from "@/lib/market/rarityClient";
import type { RarityLookup } from "@/lib/market/rarityClient";

type HeldToken = { tokenId: string; imageUrl: string | null };

type DragState = {
  tokenId: string;
  pointerId: number;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
};

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
  const [hovered, setHovered] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [settling, setSettling] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);

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

  return (
    <div className="flex h-full items-end gap-[3px] overflow-x-auto overflow-y-visible px-3 pb-3 pt-8">
      {held.map((t) => {
        const r = rarity.get(t.tokenId);
        const color = r ? tierColor(r.tier) : "rgba(212,175,90,0.5)";
        const glow = r ? tierGlow(r.tier) : "0 0 8px rgba(212,175,90,0.2)";
        const isHovered = hovered === t.tokenId;
        const isDragging = drag?.tokenId === t.tokenId;
        const isSettling = settling === t.tokenId;
        const transform = isDragging
          ? `translate(${drag!.dx}px, ${drag!.dy}px) rotate(${Math.max(-18, Math.min(18, drag!.dx / 6))}deg) scale(1.08)`
          : undefined;

        return (
          <div
            key={t.tokenId}
            className="group relative shrink-0 touch-none select-none"
            style={{ width: 26, height: "88%" }}
            onPointerEnter={() => setHovered(t.tokenId)}
            onPointerLeave={() => setHovered((h) => (h === t.tokenId ? null : h))}
            onPointerDown={(e) => onPointerDown(e, t.tokenId)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {/* The board itself */}
            <div
              className={`relative h-full w-full cursor-grab overflow-hidden rounded-t-sm border-x border-t border-black/40 bg-wood-900 shadow-[inset_0_0_8px_rgba(0,0,0,0.5)] transition-[box-shadow,transform] duration-150 active:cursor-grabbing ${
                isSettling ? "duration-[450ms] ease-[cubic-bezier(0.34,1.56,0.64,1)]" : ""
              }`}
              style={{
                boxShadow: isHovered || isDragging ? `0 0 16px 3px ${color}, ${glow}` : glow,
                borderColor: isHovered ? color : undefined,
                transform,
                zIndex: isDragging ? 30 : isHovered ? 20 : 1,
              }}
            >
              {t.imageUrl ? (
                <Image src={t.imageUrl} alt={`#${t.tokenId}`} fill sizes="26px" className="object-cover" unoptimized draggable={false} />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-[0.5rem] text-foreground/30">
                  #{t.tokenId}
                </div>
              )}
              {/* Wood-grain seam so it reads as a board, not just a cropped photo */}
              <div className="pointer-events-none absolute inset-y-0 right-0 w-px bg-black/30" />
            </div>

            {/* Stats popover — hover/tap reveals name, tier, rank, percentile */}
            {isHovered && !isDragging && (
              <div
                className="pointer-events-none absolute bottom-full left-1/2 z-40 mb-1.5 w-36 -translate-x-1/2 rounded-lg border bg-wood-950/98 p-2 text-left shadow-lg"
                style={{ borderColor: color }}
              >
                <p className="truncate text-[0.65rem] font-bold" style={{ color }}>
                  {r?.name ?? `#${t.tokenId}`}
                </p>
                <p className="mt-0.5 font-mono text-[0.55rem] text-foreground/50">#{t.tokenId}</p>
                {r ? (
                  <dl className="mt-1 space-y-0.5 text-[0.55rem] text-foreground/70">
                    <div className="flex justify-between gap-2">
                      <dt className="text-foreground/40">Tier</dt>
                      <dd className="font-bold" style={{ color }}>{r.tier}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-foreground/40">Rank</dt>
                      <dd>#{r.rank}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-foreground/40">Depth</dt>
                      <dd>beats {r.percentile.toFixed(0)}%</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="mt-1 text-[0.55rem] text-foreground/40">Not yet scored</p>
                )}
                <div
                  className="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r bg-wood-950"
                  style={{ borderColor: color }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
