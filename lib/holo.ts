"use client";

import { useEffect } from "react";

/**
 * Always-on, cursor-tracking holo field for tiered NFT cards (see
 * .holo-card in app/globals.css).
 *
 * Rather than each card listening for its own pointer enter/leave (the
 * previous approach — a per-card hover spotlight, dead the moment the
 * cursor left), ONE global listener tracks a single shared cursor/touch
 * position and drives EVERY currently-mounted .holo-card from it. Each
 * card computes its own highlight position and light angle relative to
 * that one shared point, the way a whole spread of physical foil cards
 * catches light from a single lamp differently depending on where each
 * card sits relative to it — closer cards, or cards more "under" the
 * cursor, catch a sharper/brighter sheen; cards further away still shift,
 * just more subtly. The effect never turns off; it just repositions.
 *
 * Mutates CSS custom properties directly on each DOM node (no React state,
 * no re-render) — this runs on every pointermove, batched to one
 * requestAnimationFrame per event burst, which is what keeps it cheap
 * across a grid of a few hundred cards.
 */

let rafId: number | null = null;
let pendingX = 0;
let pendingY = 0;
let initialized = false;

function updateField(clientX: number, clientY: number): void {
  const cards = document.querySelectorAll<HTMLElement>(".holo-card");
  cards.forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // Skip cards nowhere near the viewport — cheap early-out for long lists.
    if (rect.bottom < -400 || rect.top > window.innerHeight + 400) return;

    const x = ((clientX - rect.left) / rect.width) * 100;
    const y = ((clientY - rect.top) / rect.height) * 100;
    el.style.setProperty("--holo-x", `${x}%`);
    el.style.setProperty("--holo-y", `${y}%`);

    // Angle from this card's own center toward the shared cursor point —
    // each card's "view" of the same light source is different depending
    // on where it sits on screen, which is the actual point of a field
    // rather than N independent hover spotlights.
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);
    const distance = Math.hypot(dx, dy);
    // Falls off with distance so cards right under the cursor read
    // brightest and it tapers smoothly across the rest of the field,
    // instead of every card being equally lit regardless of position.
    const falloff = Math.max(0.35, 1 - distance / 1400);

    el.style.setProperty("--holo-angle", `${angle}deg`);
    el.style.setProperty("--holo-falloff", falloff.toFixed(3));
  });
}

function schedule(x: number, y: number): void {
  pendingX = x;
  pendingY = y;
  if (rafId != null) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    updateField(pendingX, pendingY);
  });
}

/** Mount once near the app root (see app/layout.tsx). Renders nothing —
 * pure side effect. Idempotent against double-mount (React StrictMode). */
export default function HoloField(): null {
  useEffect(() => {
    if (initialized) return undefined;
    initialized = true;

    // Pointer Events cover mouse, pen, and touch-drag through one listener.
    const onMove = (e: PointerEvent) => schedule(e.clientX, e.clientY);
    window.addEventListener("pointermove", onMove, { passive: true });

    return () => {
      window.removeEventListener("pointermove", onMove);
      initialized = false;
    };
  }, []);

  return null;
}
