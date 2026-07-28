import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * Cursor/touch-reactive holo sheen for tiered cards (see .holo-card in
 * app/globals.css). Mutates CSS custom properties directly on the DOM node
 * instead of going through React state — this fires on every pointermove,
 * and a state update (plus re-render) per move would be both unnecessary
 * and janky. Pointer Events cover mouse, touch-drag, and pen through one
 * API, so the same handlers work for a cursor and a finger wipe.
 */
export function onHoloPointerMove(e: ReactPointerEvent<HTMLElement>): void {
  const el = e.currentTarget;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const x = ((e.clientX - rect.left) / rect.width) * 100;
  const y = ((e.clientY - rect.top) / rect.height) * 100;
  el.style.setProperty("--holo-x", `${x}%`);
  el.style.setProperty("--holo-y", `${y}%`);
  el.style.setProperty("--holo-active", "1");
}

export function onHoloPointerLeave(e: ReactPointerEvent<HTMLElement>): void {
  e.currentTarget.style.setProperty("--holo-active", "0");
}

/** Spread onto any tiered card element alongside className="holo-card". */
export const holoHandlers = {
  onPointerMove: onHoloPointerMove,
  onPointerLeave: onHoloPointerLeave,
  onPointerCancel: onHoloPointerLeave,
};
