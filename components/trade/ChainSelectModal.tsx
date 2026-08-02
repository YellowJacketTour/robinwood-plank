"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search, X } from "lucide-react";
import TokenIcon from "@/components/trade/TokenIcon";

export type SourceChainOption = { chainId: number; name: string };

type Props = {
  open: boolean;
  onClose: () => void;
  chains: SourceChainOption[];
  selected: SourceChainOption | null;
  onSelect: (chain: SourceChainOption) => void;
};

/**
 * Chain picker for the cross-chain buy panel — same modal/selector anatomy as
 * TokenSelectModal.tsx (portal to <body>, backdrop, keyboard nav, TokenIcon
 * letter-avatar rows) so the two selectors read as one product instead of a
 * polished picker next to a native <select>. Deliberately no
 * search-debounce/import-by-address flow: unlike the token list, the source
 * chain list is small and server-fixed (/api/zerox/status), not something a
 * user pastes an address into.
 */
export default function ChainSelectModal({ open, onClose, chains, selected, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [mounted, setMounted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlight(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chains;
    return chains.filter((c) => c.name.toLowerCase().includes(q));
  }, [chains, query]);

  useEffect(() => {
    const c = filtered[highlight];
    if (c) itemRefs.current.get(c.chainId)?.scrollIntoView({ block: "nearest" });
  }, [highlight, filtered]);

  if (!open || !mounted) return null;

  const pick = (c: SourceChainOption) => {
    onSelect(c);
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
      const c = filtered[highlight];
      if (c) pick(c);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Select source chain"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-full max-w-sm flex-col overflow-hidden rounded-2xl border border-line-strong bg-panel-strong shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 pb-3 pt-4">
          <h2 className="text-sm font-black uppercase tracking-wide text-cream">Pay from which chain?</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-cream-muted hover:text-gold-300"
          >
            <X size={18} />
          </button>
        </div>

        {chains.length > 5 && (
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
                placeholder="Search chains"
                className="min-w-0 flex-1 bg-transparent text-sm text-cream outline-none placeholder:text-cream-muted/60"
                aria-label="Search chains"
              />
            </div>
          </div>
        )}

        <div className="flex-1 space-y-1 overflow-y-auto px-2 py-2" onKeyDown={onKeyDown}>
          {filtered.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-cream-muted">
              No chains match &ldquo;{query}&rdquo;.
            </p>
          )}
          {filtered.map((c, i) => {
            const isSelected = c.chainId === selected?.chainId;
            return (
              <button
                key={c.chainId}
                ref={(el) => {
                  if (el) itemRefs.current.set(c.chainId, el);
                  else itemRefs.current.delete(c.chainId);
                }}
                type="button"
                onClick={() => pick(c)}
                onMouseEnter={() => setHighlight(i)}
                aria-pressed={isSelected}
                className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-3 text-left transition-colors ${
                  i === highlight
                    ? "border-line-strong bg-gold-500/15"
                    : "border-transparent hover:border-line-strong hover:bg-gold-500/10"
                }`}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <TokenIcon symbol={c.name} size={28} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-bold text-cream">{c.name}</span>
                  </span>
                </span>
                {isSelected && (
                  <span className="shrink-0 rounded-full bg-gold-500/15 px-2 py-0.5 text-[0.62rem] font-bold text-gold-300">
                    Selected
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>,
    document.body
  );
}
