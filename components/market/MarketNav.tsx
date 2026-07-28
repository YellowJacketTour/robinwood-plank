"use client";

import { useEffect, useRef } from "react";
import type { MarketTab } from "@/lib/market/types";

const TABS: { id: MarketTab; label: string }[] = [
  { id: "buy-sell", label: "Buy & Sell" },
  { id: "offers", label: "Offers" },
  { id: "activity", label: "Activity" },
  { id: "swap", label: "Instant Swap" },
  { id: "positions", label: "My Listings" },
];

type Props = {
  active: MarketTab;
  onChange: (tab: MarketTab) => void;
};

/** Horizontal on desktop, horizontal-scroll strip on mobile — no wrap, no second row. */
export default function MarketNav({ active, onChange }: Props) {
  const activeRef = useRef<HTMLButtonElement>(null);

  // A tab reached via a direct link (e.g. ?tab=swap) can land off-screen in
  // the scroll strip with nothing visibly selected — pull it into view.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  return (
    <div
      className="flex gap-1.5 overflow-x-auto rounded-lg border border-gold-500/20 bg-wood-900/50 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="tablist"
      aria-label="Marketplace sections"
    >
      {TABS.map((t) => (
        <button
          key={t.id}
          ref={active === t.id ? activeRef : undefined}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onChange(t.id)}
          className={`min-h-10 shrink-0 whitespace-nowrap rounded-md px-3.5 text-xs font-bold uppercase tracking-wide transition-colors sm:text-sm ${
            active === t.id
              ? "bg-gold-500 text-wood-950"
              : "text-foreground/65 hover:text-gold-300"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
