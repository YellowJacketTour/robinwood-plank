"use client";

import { useCallback, useLayoutEffect, useRef } from "react";
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
  const tabListRef = useRef<HTMLDivElement>(null);

  const keepTabVisible = useCallback((tab: HTMLButtonElement | null) => {
    const tabList = tabListRef.current;
    if (!tabList || !tab) return;

    const clearance = 8;
    const visibleLeft = tabList.scrollLeft + clearance;
    const visibleRight = tabList.scrollLeft + tabList.clientWidth - clearance;
    const tabLeft = tab.offsetLeft;
    const tabRight = tabLeft + tab.offsetWidth;

    if (tabLeft < visibleLeft) {
      tabList.scrollTo({ left: Math.max(0, tabLeft - clearance), behavior: "auto" });
    } else if (tabRight > visibleRight) {
      tabList.scrollTo({
        left: Math.max(0, tabRight - tabList.clientWidth + clearance),
        behavior: "auto",
      });
    }
  }, []);

  // A tab reached via a direct link (e.g. ?tab=swap) can land off-screen in
  // the scroll strip. Scroll only this rail, never the surrounding page.
  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(() => keepTabVisible(activeRef.current));
    return () => window.cancelAnimationFrame(frame);
  }, [active, keepTabVisible]);

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
    const nextTab = tabRefs.current[next];
    nextTab?.focus();
    window.requestAnimationFrame(() => keepTabVisible(nextTab));
  };

  return (
    <div
      ref={tabListRef}
      className="flex w-full min-w-0 gap-1 overflow-x-auto overflow-y-hidden p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
