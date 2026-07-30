"use client";

import { useEffect, useRef } from "react";
import type { MarketTab } from "@/lib/market/types";
import { MARKET_TABS } from "@/lib/market/navigation";

type Props = {
  active: MarketTab;
  onChange: (tab: MarketTab) => void;
  counts?: Partial<Record<MarketTab, number>>;
};

/** Horizontal on desktop, horizontal-scroll strip on mobile — no wrap, no second row. */
export default function MarketNav({ active, onChange, counts }: Props) {
  const activeRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // A tab reached via a direct link (e.g. ?tab=swap) can land off-screen in
  // the scroll strip with nothing visibly selected — pull it into view.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  const moveFocus = (index: number, key: string) => {
    let next = index;
    if (key === "ArrowRight") next = (index + 1) % MARKET_TABS.length;
    else if (key === "ArrowLeft") next = (index - 1 + MARKET_TABS.length) % MARKET_TABS.length;
    else if (key === "Home") next = 0;
    else if (key === "End") next = MARKET_TABS.length - 1;
    else return;
    const tab = MARKET_TABS[next];
    if (!tab) return;
    onChange(tab.id);
    tabRefs.current[next]?.focus();
  };

  return (
    <div
      className="flex min-w-0 flex-1 gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="tablist"
      aria-label="Marketplace sections"
    >
      {MARKET_TABS.map((t, index) => (
        <button
          key={t.id}
          ref={(node) => {
            tabRefs.current[index] = node;
            if (active === t.id) activeRef.current = node;
          }}
          id={`market-tab-${t.id}`}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          aria-controls={`market-panel-${t.id}`}
          tabIndex={active === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(event) => {
            if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              moveFocus(index, event.key);
            }
          }}
          className={`min-h-11 shrink-0 whitespace-nowrap rounded-md px-3.5 text-[0.7rem] font-black uppercase tracking-wide transition-colors sm:text-xs ${
            active === t.id
              ? "bg-gold-500 text-wood-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.24)]"
              : "text-foreground/65 hover:text-gold-300"
          }`}
        >
          {t.label}
          {counts?.[t.id] !== undefined && (
            <span
              className={`ml-2 rounded-full px-1.5 py-0.5 text-[0.58rem] ${
                active === t.id ? "bg-wood-950/15" : "bg-foreground/10"
              }`}
            >
              {counts[t.id]}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
