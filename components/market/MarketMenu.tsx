"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { chainDisplayName, FOREIGN_CHAINS } from "@/lib/market/multichain/trading/foreign-chain-registry";
import ChainIcon from "@/components/market/ChainIcon";

const CHAINS = [
  "robinhood",
  ...FOREIGN_CHAINS.map((c) => c.chainSlug),
  "solana-mainnet",
  "bitcoin-mainnet",
];

type Props = {
  className: string;
  active: boolean;
  onNavigate?: () => void;
  /** "rail" = desktop popover; "sheet" = mobile full-width list inside the hamburger. */
  variant?: "rail" | "sheet";
};

/**
 * Click (not hover) MARKET panel: RobinWood, global hub, chain chips with
 * the same inline ChainIcon SVGs the rankings table uses. Keyboard:
 * Escape / click-outside. Touch: 44px rows, no hover-only state.
 */
export default function MarketMenu({ className, active, onNavigate, variant = "rail" }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent | TouchEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("touchstart", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("touchstart", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const go = () => {
    setOpen(false);
    onNavigate?.();
  };

  const panel = (
    <div
      role="dialog"
      aria-label="Market destinations"
      className={
        variant === "sheet"
          ? "mt-1 rounded-lg border border-line bg-wood-900 p-3"
          : "absolute left-0 top-full z-[80] mt-1 w-[min(24rem,calc(100vw-1.5rem))] rounded-lg border border-line-strong bg-wood-950 p-3 shadow-2xl sm:w-[26rem]"
      }
    >
      <p className="mb-2 text-[0.58rem] font-black uppercase tracking-wider text-foreground/45">Marketplank</p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        <Link
          href="/market"
          className="flex min-h-12 items-center gap-2.5 rounded-md border border-line px-3 py-2 text-sm font-bold text-gold-300 hover:border-gold-400"
          onClick={go}
        >
          <ChainIcon chainSlug="robinhood" size={28} className="shrink-0" />
          <span className="leading-tight">
            RobinWood
            <span className="block text-[0.62rem] font-semibold text-foreground/50">Native book</span>
          </span>
        </Link>
        <Link
          href="/market/multichain"
          className="flex min-h-12 items-center gap-2.5 rounded-md border border-line px-3 py-2 text-sm font-bold text-gold-300 hover:border-gold-400"
          onClick={go}
        >
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center text-gold-300"
            aria-hidden
          >
            <svg viewBox="0 0 24 24" width={28} height={28} fill="none" className="block">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
              <ellipse cx="12" cy="12" rx="4" ry="9" stroke="currentColor" strokeWidth="1.6" />
              <path d="M3.5 12h17" stroke="currentColor" strokeWidth="1.6" />
              <path d="M5.2 7.5h13.6M5.2 16.5h13.6" stroke="currentColor" strokeWidth="1.35" />
            </svg>
          </span>
          <span className="leading-tight">
            Global
            <span className="block text-[0.62rem] font-semibold text-foreground/50">Every chain</span>
          </span>
        </Link>
      </div>
      <p className="mb-1.5 mt-3 text-[0.58rem] font-black uppercase tracking-wider text-foreground/45">Chains</p>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {CHAINS.map((slug) => (
          <Link
            key={slug}
            href={slug === "robinhood" ? "/market" : `/market/multichain?chains=${encodeURIComponent(slug)}`}
            className="flex min-h-11 items-center gap-2 rounded-md border border-line px-2 py-1.5 text-left text-[0.7rem] font-bold text-foreground/80 hover:border-gold-400 hover:text-gold-300"
            onClick={go}
          >
            <ChainIcon chainSlug={slug} size={22} className="shrink-0" />
            <span className="min-w-0 truncate">{chainDisplayName(slug)}</span>
          </Link>
        ))}
      </div>
    </div>
  );

  return (
    <li ref={rootRef} className={variant === "sheet" ? "relative w-full" : "relative"}>
      <button
        type="button"
        className={variant === "sheet" ? `${className} w-full justify-between` : className}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-current={active ? "page" : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        Market
        <span className="ml-1 text-[0.65rem] opacity-60" aria-hidden>
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open ? panel : null}
    </li>
  );
}
