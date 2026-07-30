"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search, X } from "lucide-react";
import { NATIVE_TOKEN_ADDRESS } from "@/lib/constants";
import TokenIcon from "@/components/trade/TokenIcon";

/** Mirror of SwapWidget's CounterTokenEntry — the list itself always comes
 * from /api/uniswap/tokens, never client-authored. */
export type CounterTokenEntry = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  tokens: CounterTokenEntry[];
  selected: CounterTokenEntry;
  onSelect: (token: CounterTokenEntry) => void;
  title: string;
};

const RECENTS_KEY = "plank:swap:recentCounters";
const MAX_RECENTS = 3;

function readRecents(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function pushRecent(address: string) {
  if (typeof window === "undefined") return;
  try {
    const prev = readRecents().filter((a) => a.toLowerCase() !== address.toLowerCase());
    const next = [address, ...prev].slice(0, MAX_RECENTS);
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* localStorage unavailable (private mode) — recents just won't persist */
  }
}

/**
 * Searchable token picker shared by both the "you pay" and "you receive"
 * sides of the swap widget — it always selects the counter (non-PLANK) side.
 * The token list itself is server-validated (/api/uniswap/tokens); this
 * component only filters and remembers what the user picked.
 */
export default function TokenSelectModal({ open, onClose, tokens, selected, onSelect, title }: Props) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [recents, setRecents] = useState<string[]>([]);
  // Rendered via a portal straight onto <body> — the widget sits inside the
  // homepage's ".reveal" section, which sets a (identity) transform once
  // visible. Any non-"none" transform on an ancestor creates a new
  // containing block, so a plain `position: fixed` child gets trapped
  // inside that box instead of covering the viewport. Portaling escapes it.
  const [mounted, setMounted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlight(0);
    setRecents(readRecents());
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  // ETH pinned first; the rest keep the server's list order.
  const ordered = useMemo(() => {
    const eth = tokens.find((t) => t.address.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase());
    const rest = tokens.filter((t) => t.address.toLowerCase() !== NATIVE_TOKEN_ADDRESS.toLowerCase());
    return eth ? [eth, ...rest] : rest;
  }, [tokens]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter((t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q));
  }, [ordered, query]);

  const recentEntries = useMemo(
    () =>
      recents
        .map((addr) => tokens.find((t) => t.address.toLowerCase() === addr.toLowerCase()))
        .filter((t): t is CounterTokenEntry => Boolean(t)),
    [recents, tokens]
  );

  useEffect(() => {
    const t = filtered[highlight];
    if (t) itemRefs.current.get(t.address)?.scrollIntoView({ block: "nearest" });
  }, [highlight, filtered]);

  if (!open || !mounted) return null;

  const pick = (t: CounterTokenEntry) => {
    pushRecent(t.address);
    onSelect(t);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const t = filtered[highlight];
      if (t) pick(t);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-sm flex-col overflow-hidden rounded-2xl border border-line-strong bg-panel-strong shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 pb-3 pt-4">
          <h2 className="text-sm font-black uppercase tracking-wide text-cream">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-cream-muted hover:text-gold-300"
          >
            <X size={18} />
          </button>
        </div>

        <div className="border-b border-line px-4 py-3">
          <div className="flex items-center gap-2 rounded-lg border border-line bg-panel px-2.5 py-2 focus-within:border-gold-400">
            <Search size={16} className="shrink-0 text-cream-muted" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search name or symbol"
              className="min-w-0 flex-1 bg-transparent text-sm text-cream outline-none placeholder:text-cream-muted/60"
              aria-label="Search tokens"
            />
          </div>
        </div>

        {recentEntries.length > 0 && !query && (
          <div className="flex flex-wrap gap-1.5 border-b border-line px-4 py-3">
            <span className="w-full text-[0.62rem] font-bold uppercase tracking-wide text-cream-muted">
              Recent
            </span>
            {recentEntries.map((t) => (
              <button
                key={t.address}
                type="button"
                onClick={() => pick(t)}
                className="flex items-center gap-1.5 rounded-full border border-line py-1 pl-1 pr-2.5 text-xs font-bold text-gold-300 hover:border-gold-400 hover:bg-gold-500/10"
              >
                <TokenIcon symbol={t.symbol} logoURI={t.logoURI} size={16} />
                {t.symbol}
              </button>
            ))}
          </div>
        )}

        <div
          className="token-modal-scroll flex-1 space-y-1 overflow-y-auto px-2 py-2"
          onKeyDown={onKeyDown}
        >
          {filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-cream-muted">
              No tokens match &ldquo;{query}&rdquo;.
            </p>
          ) : (
            filtered.map((t, i) => {
              const isSelected = t.address.toLowerCase() === selected.address.toLowerCase();
              return (
                <button
                  key={t.address}
                  ref={(el) => {
                    if (el) itemRefs.current.set(t.address, el);
                    else itemRefs.current.delete(t.address);
                  }}
                  type="button"
                  onClick={() => pick(t)}
                  onMouseEnter={() => setHighlight(i)}
                  aria-pressed={isSelected}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-3 text-left transition-colors ${
                    i === highlight
                      ? "border-line-strong bg-gold-500/15"
                      : "border-transparent hover:border-line-strong hover:bg-gold-500/10"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <TokenIcon symbol={t.symbol} logoURI={t.logoURI} size={28} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-bold text-cream">{t.symbol}</span>
                      <span className="block truncate text-[0.7rem] text-cream-muted">{t.name}</span>
                    </span>
                  </span>
                  {isSelected && (
                    <span className="shrink-0 rounded-full bg-gold-500/15 px-2 py-0.5 text-[0.62rem] font-bold text-gold-300">
                      Selected
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
