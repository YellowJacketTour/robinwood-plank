"use client";

import { useEffect, useRef } from "react";

type Props = {
  /** Unique per panel — the user's chosen height persists under this key
   * (localStorage), so "Activity" and "Vault trades" remember their own
   * sizes independently, forever, across visits. */
  storageKey: string;
  defaultHeight?: number;
  minHeight?: number;
  maxHeight?: number;
  className?: string;
  children: React.ReactNode;
};

/**
 * A vertically-resizable, scrollable panel — the standard browser
 * drag-to-resize handle (native `resize: vertical`, bottom-right corner),
 * so long lists (Activity, trade history) never force the whole page into
 * a doom-scroll: the panel scrolls internally at a height the user picks
 * and keeps, not a fixed one baked into the layout.
 */
export default function ScrollBox({
  storageKey,
  defaultHeight = 256,
  minHeight = 140,
  maxHeight = 720,
  className = "",
  children,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let saved: number | null = null;
    try {
      const raw = localStorage.getItem(`plank-scrollbox:${storageKey}`);
      saved = raw ? Number(raw) : null;
    } catch {
      // localStorage unavailable — just use the default height
    }
    const initial = saved && Number.isFinite(saved) ? saved : defaultHeight;
    el.style.height = `${Math.min(maxHeight, Math.max(minHeight, initial))}px`;

    const observer = new ResizeObserver(([entry]) => {
      const height = Math.round(entry.contentRect.height);
      try {
        localStorage.setItem(`plank-scrollbox:${storageKey}`, String(height));
      } catch {
        // nothing to do — the resize still works, it just won't persist
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [storageKey, defaultHeight, maxHeight, minHeight]);

  return (
    <div
      ref={ref}
      className={`resize-y overflow-y-auto ${className}`}
      style={{ minHeight, maxHeight, height: defaultHeight }}
    >
      {children}
    </div>
  );
}
