"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, Clock, Copy, Globe, Search, ShieldCheck, X } from "lucide-react";
import { NATIVE_TOKEN_ADDRESS } from "@/lib/constants";
import { formatDisplayAmount, shortAddress } from "@/lib/trade";
import TokenIcon from "@/components/trade/TokenIcon";

/** Mirror of SwapWidget's CounterTokenEntry — the list itself always comes
 * from /api/uniswap/tokens, never client-authored. */
export type CounterTokenEntry = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  /** True only for a token resolved by pasting an address (import flow) —
   * on-chain ERC20 metadata, never curated. Never set for anything in the
   * server's list. */
  unverified?: boolean;
};

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/** A chain-search hit (Blockscout discovery) before it's been re-resolved
 * on-chain — display only; clicking one re-runs the same on-chain check the
 * paste-an-address flow uses, never trusts these fields for a quote. */
type ChainSearchResult = CounterTokenEntry & { priceTracked?: boolean };

type Props = {
  open: boolean;
  onClose: () => void;
  tokens: CounterTokenEntry[];
  selected: CounterTokenEntry;
  onSelect: (token: CounterTokenEntry) => void;
  title: string;
  /** Connected wallet, if any. Balances only ever appear when this is set —
   * no wallet, no balance column, per the owner's explicit condition. */
  account?: string | null;
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

function clearRecents() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(RECENTS_KEY);
  } catch {
    /* nothing to clear */
  }
}

type BalanceTarget = { address: string; decimals: number; isNative: boolean };

/**
 * Batched balance lookup — same shape as lib/market/inventory.ts's
 * ethCallBatch (one JSON-RPC array POST per 100 calls through the
 * same-origin /api/rpc proxy, falling back to sequential per-call requests
 * if the upstream ever rejects an array batch), generalized to call
 * different token contracts instead of the same one repeatedly, plus a
 * native ETH leg via eth_getBalance. A balance nicety never blocks token
 * selection: every failure here just leaves that row without a balance.
 */
async function fetchBalancesBatch(
  owner: string,
  targets: BalanceTarget[]
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (targets.length === 0) return out;
  const pad = owner.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const CHUNK = 100; // ~20KB per chunk, well under the /api/rpc proxy's body cap

  const callOne = async (t: BalanceTarget): Promise<string | null> => {
    try {
      const res = await fetch("/api/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          t.isNative
            ? { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [owner, "latest"] }
            : {
                jsonrpc: "2.0",
                id: 1,
                method: "eth_call",
                params: [{ to: t.address, data: `0x70a08231${pad}` }, "latest"],
              }
        ),
      });
      const json = (await res.json()) as { result?: string };
      return json.result ?? null;
    } catch {
      return null;
    }
  };

  for (let start = 0; start < targets.length; start += CHUNK) {
    const chunk = targets.slice(start, start + CHUNK);
    let batched = false;
    try {
      const res = await fetch("/api/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          chunk.map((t, i) =>
            t.isNative
              ? { jsonrpc: "2.0", id: start + i, method: "eth_getBalance", params: [owner, "latest"] }
              : {
                  jsonrpc: "2.0",
                  id: start + i,
                  method: "eth_call",
                  params: [{ to: t.address, data: `0x70a08231${pad}` }, "latest"],
                }
          )
        ),
      });
      const json = (await res.json()) as unknown;
      if (Array.isArray(json)) {
        for (const entry of json as Array<{ id?: unknown; result?: unknown }>) {
          const idx = typeof entry?.id === "number" ? entry.id - start : -1;
          if (idx >= 0 && idx < chunk.length && typeof entry.result === "string") {
            try {
              out.set(chunk[idx].address.toLowerCase(), BigInt(entry.result));
            } catch {
              /* malformed hex — leave this row balance-less */
            }
          }
        }
        batched = true;
      }
    } catch {
      /* fall through to per-call */
    }
    if (!batched) {
      const results = await Promise.all(chunk.map(callOne));
      results.forEach((hex, i) => {
        if (!hex) return;
        try {
          out.set(chunk[i].address.toLowerCase(), BigInt(hex));
        } catch {
          /* malformed hex — leave this row balance-less */
        }
      });
    }
  }
  return out;
}

/** The handful of tokens people reach for without typing — one tap, no
 * scrolling. Fixed order regardless of the server list's own ordering. */
const QUICK_PICK_SYMBOLS = ["ETH", "USDG", "WETH"];

/** Small uppercase label shared by every section — matches DESIGN.md's
 * `label` typography (Nunito Sans, 900 weight, wide tracking). */
function SectionLabel({
  icon,
  children,
  action,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-2 pb-1.5 pt-3 first:pt-1">
      <span className="flex items-center gap-1.5 text-[0.6875rem] font-black uppercase tracking-[0.1em] text-cream-muted">
        {icon}
        {children}
      </span>
      {action}
    </div>
  );
}

/**
 * Searchable token picker shared by both the "you pay" and "you receive"
 * sides of the swap widget — it always selects the counter (non-PLANK) side.
 * The token list itself is server-validated (/api/uniswap/tokens); this
 * component only filters and remembers what the user picked.
 */
export default function TokenSelectModal({
  open,
  onClose,
  tokens,
  selected,
  onSelect,
  title,
  account,
}: Props) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [recents, setRecents] = useState<string[]>([]);
  const [importResult, setImportResult] = useState<CounterTokenEntry | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [chainResults, setChainResults] = useState<ChainSearchResult[]>([]);
  const [chainSearchLoading, setChainSearchLoading] = useState(false);
  // address (lowercase) -> raw base-unit balance. Only populated when a
  // wallet is connected; a missing entry just means "no balance shown",
  // never an error surfaced to the user.
  const [balances, setBalances] = useState<Map<string, bigint>>(new Map());
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  // Rendered via a portal straight onto <body> — the widget sits inside the
  // homepage's ".reveal" section, which sets a (identity) transform once
  // visible. Any non-"none" transform on an ancestor creates a new
  // containing block, so a plain `position: fixed` child gets trapped
  // inside that box instead of covering the viewport. Portaling escapes it.
  const [mounted, setMounted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlight(0);
    setRecents(readRecents());
    setImportResult(null);
    setImportError(null);
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  const looksLikeAddress = ADDRESS_RE.test(query.trim());

  // "Import by address" — a pasted 0x address that isn't in the curated
  // list gets validated LIVE on-chain (symbol/name/decimals straight off the
  // contract via /api/uniswap/import-token), never against an off-chain
  // registry. Debounced the same way SwapPanel's token-preview lookup is.
  useEffect(() => {
    const addr = query.trim();
    if (!ADDRESS_RE.test(addr)) {
      setImportResult(null);
      setImportError(null);
      return;
    }
    let cancelled = false;
    setImportLoading(true);
    setImportError(null);
    setImportResult(null);
    const timer = window.setTimeout(() => {
      fetch("/api/uniswap/import-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: addr }),
      })
        .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
        .then(({ ok, d }) => {
          if (cancelled) return;
          const data = d as { token?: CounterTokenEntry; message?: string };
          if (ok && data.token) {
            setImportResult(data.token);
          } else {
            setImportError(data.message || "Could not import this token.");
          }
        })
        .catch(() => {
          if (!cancelled) setImportError("Could not import this token.");
        })
        .finally(() => {
          if (!cancelled) setImportLoading(false);
        });
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  // Chain-wide search beyond the curated list — discovery + icons only, via
  // /api/uniswap/token-search (Blockscout's public explorer API; Uniswap's
  // own search backend was confirmed gated, 401 without a session/API key).
  // Results here are never selectable directly: clicking one re-runs the
  // same on-chain validation the paste-an-address flow uses (by setting the
  // query to that address), so decimals/symbol/name always come from the
  // contract, never from the indexer.
  useEffect(() => {
    const q = query.trim();
    if (looksLikeAddress || q.length < 2) {
      setChainResults([]);
      return;
    }
    let cancelled = false;
    setChainSearchLoading(true);
    const timer = window.setTimeout(() => {
      fetch(`/api/uniswap/token-search?q=${encodeURIComponent(q)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { results?: ChainSearchResult[] } | null) => {
          if (cancelled) return;
          const curatedAddrs = new Set(tokens.map((t) => t.address.toLowerCase()));
          const results = (d?.results ?? []).filter(
            (r) => !curatedAddrs.has(r.address.toLowerCase())
          );
          setChainResults(results);
        })
        .catch(() => {
          if (!cancelled) setChainResults([]);
        })
        .finally(() => {
          if (!cancelled) setChainSearchLoading(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, looksLikeAddress, tokens]);

  // ETH pinned first; the rest keep the server's list order.
  const ordered = useMemo(() => {
    const eth = tokens.find((t) => t.address.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase());
    const rest = tokens.filter((t) => t.address.toLowerCase() !== NATIVE_TOKEN_ADDRESS.toLowerCase());
    return eth ? [eth, ...rest] : rest;
  }, [tokens]);

  const quickPicks = useMemo(
    () =>
      QUICK_PICK_SYMBOLS.map((sym) => tokens.find((t) => t.symbol === sym)).filter(
        (t): t is CounterTokenEntry => Boolean(t)
      ),
    [tokens]
  );

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

  // Balances only for rows actually rendered right now — the curated/verified
  // list, quick picks, recents, and whatever chain-search results are on
  // screen — never the whole chain-search universe. Deduped by address so a
  // token appearing in more than one section (e.g. a quick pick that's also
  // in the verified list) costs one RPC call, not several.
  const balanceKey = useMemo(() => {
    const addrs = new Set<string>();
    for (const t of [...filtered, ...quickPicks, ...recentEntries, ...chainResults]) {
      addrs.add(t.address.toLowerCase());
    }
    return Array.from(addrs).sort().join(",");
  }, [filtered, quickPicks, recentEntries, chainResults]);

  useEffect(() => {
    if (!account || !balanceKey) {
      setBalances(new Map());
      return;
    }
    const allByAddress = new Map<string, CounterTokenEntry>();
    for (const t of [...filtered, ...quickPicks, ...recentEntries, ...chainResults]) {
      allByAddress.set(t.address.toLowerCase(), t);
    }
    const targets: BalanceTarget[] = balanceKey.split(",").map((addr) => {
      const entry = allByAddress.get(addr);
      return {
        address: addr,
        decimals: entry?.decimals ?? 18,
        isNative: addr === NATIVE_TOKEN_ADDRESS.toLowerCase(),
      };
    });
    let cancelled = false;
    // Fire-and-forget: rows already rendered with whatever `balances` holds
    // (nothing, on first pass) — this only ever fills the slot in later,
    // never blocks or delays showing/selecting a token.
    void fetchBalancesBatch(account, targets).then((result) => {
      if (!cancelled) setBalances(result);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- balanceKey is the real dependency; filtered/quickPicks/etc feed only into targets built from it
  }, [account, balanceKey]);

  // Held tokens float to the top of the verified section when a wallet is
  // connected — but only within that section. The unverified discovery
  // section never gets reordered by balance, and never moves above verified.
  const displayed = useMemo(() => {
    if (!account) return filtered;
    const nativeAddr = NATIVE_TOKEN_ADDRESS.toLowerCase();
    const nativeEntry = filtered.find((t) => t.address.toLowerCase() === nativeAddr);
    const rest = filtered.filter((t) => t.address.toLowerCase() !== nativeAddr);
    const held = rest.filter((t) => (balances.get(t.address.toLowerCase()) ?? BigInt(0)) > BigInt(0));
    const heldSet = new Set(held.map((t) => t.address.toLowerCase()));
    const unheld = rest.filter((t) => !heldSet.has(t.address.toLowerCase()));
    return nativeEntry ? [nativeEntry, ...held, ...unheld] : [...held, ...unheld];
  }, [filtered, account, balances]);

  useEffect(() => {
    const t = displayed[highlight];
    if (t) itemRefs.current.get(t.address)?.scrollIntoView({ block: "nearest" });
  }, [highlight, displayed]);

  if (!open || !mounted) return null;

  const pick = (t: CounterTokenEntry) => {
    pushRecent(t.address);
    onSelect(t);
    onClose();
  };

  const copyAddress = (address: string) => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(address).then(() => {
      setCopiedAddress(address);
      window.setTimeout(() => setCopiedAddress((cur) => (cur === address ? null : cur)), 1500);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, displayed.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const t = displayed[highlight];
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
              placeholder="Search name, symbol, or paste an address"
              className="min-w-0 flex-1 bg-transparent text-sm text-cream outline-none placeholder:text-cream-muted/60"
              aria-label="Search tokens"
            />
          </div>
        </div>

        {!query && (quickPicks.length > 0 || recentEntries.length > 0) && (
          <div className="space-y-2.5 border-b border-line px-4 py-3">
            {quickPicks.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {quickPicks.map((t) => (
                  <button
                    key={t.address}
                    type="button"
                    onClick={() => pick(t)}
                    className="flex items-center gap-1.5 rounded-full border border-line py-1 pl-1 pr-2.5 text-xs font-bold text-gold-300 hover:border-gold-400 hover:bg-gold-500/10"
                  >
                    <TokenIcon symbol={t.symbol} logoURI={t.logoURI} size={18} />
                    {t.symbol}
                  </button>
                ))}
              </div>
            )}
            {recentEntries.length > 0 && (
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[0.62rem] font-black uppercase tracking-[0.1em] text-cream-muted">
                    <Clock size={12} />
                    Recent
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      clearRecents();
                      setRecents([]);
                    }}
                    className="text-[0.62rem] font-bold uppercase tracking-wide text-cream-muted underline decoration-dotted hover:text-gold-300"
                  >
                    Clear
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
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
              </div>
            )}
          </div>
        )}

        <div
          className="token-modal-scroll flex-1 space-y-1 overflow-y-auto px-2 py-2"
          onKeyDown={onKeyDown}
        >
          {looksLikeAddress ? (
            <div className="space-y-2 px-1 py-2">
              {importLoading && (
                <p className="px-1 text-center text-xs text-cream-muted">
                  Checking this address on-chain…
                </p>
              )}
              {importError && (
                <p className="rounded-lg border border-red-500/30 bg-red-950/20 px-3 py-2 text-center text-xs text-red-300">
                  {importError}
                </p>
              )}
              {importResult && (
                <div className="space-y-2.5 rounded-lg border border-amber-500/40 bg-amber-950/20 px-3 py-3">
                  <div className="flex items-center gap-2.5">
                    <TokenIcon symbol={importResult.symbol} logoURI={importResult.logoURI} size={28} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-cream">{importResult.name}</p>
                      <p className="flex items-center gap-1.5 truncate text-[0.7rem] text-cream-muted">
                        <span className="font-bold">{importResult.symbol}</span>
                        <button
                          type="button"
                          onClick={() => copyAddress(importResult.address)}
                          title="Copy contract address"
                          className="flex shrink-0 items-center gap-1 truncate hover:text-gold-300"
                        >
                          {shortAddress(importResult.address)}
                          {copiedAddress === importResult.address ? (
                            <Check size={11} className="shrink-0 text-gold-300" />
                          ) : (
                            <Copy size={11} className="shrink-0" />
                          )}
                        </button>
                      </p>
                    </div>
                  </div>
                  <p className="flex items-start gap-1.5 text-[0.68rem] leading-snug text-amber-200/90">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300" />
                    <span>
                      <strong className="text-amber-100">Unverified token.</strong> Not on the
                      curated list — anyone can deploy a contract with any symbol or name.
                      Verify the address yourself before trading. Trade at your own risk.
                    </span>
                  </p>
                  <button
                    type="button"
                    onClick={() => pick(importResult)}
                    className="w-full rounded-lg bg-amber-500/90 py-2 text-xs font-bold text-wood-950 transition-colors hover:bg-amber-400"
                  >
                    Import anyway
                  </button>
                </div>
              )}
            </div>
          ) : (
            <>
              {displayed.length === 0 && chainResults.length === 0 && !chainSearchLoading && (
                <p className="px-2 py-6 text-center text-xs text-cream-muted">
                  No tokens match &ldquo;{query}&rdquo; anywhere on chain.
                </p>
              )}

              {displayed.length > 0 && (
                <SectionLabel icon={<ShieldCheck size={12} />}>Verified tokens</SectionLabel>
              )}
              {displayed.map((t, i) => {
                const isSelected = t.address.toLowerCase() === selected.address.toLowerCase();
                const isNative = t.address.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase();
                const bal = balances.get(t.address.toLowerCase());
                return (
                  <div
                    key={t.address}
                    ref={(el) => {
                      if (el) itemRefs.current.set(t.address, el);
                      else itemRefs.current.delete(t.address);
                    }}
                    role="button"
                    tabIndex={0}
                    onClick={() => pick(t)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        pick(t);
                      }
                    }}
                    onMouseEnter={() => setHighlight(i)}
                    aria-pressed={isSelected}
                    className={`flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-3 text-left transition-colors ${
                      i === highlight
                        ? "border-line-strong bg-gold-500/15"
                        : "border-transparent hover:border-line-strong hover:bg-gold-500/10"
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <TokenIcon symbol={t.symbol} logoURI={t.logoURI} size={34} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-bold text-cream">{t.name}</span>
                        <span className="flex items-center gap-1.5 truncate text-[0.7rem] text-cream-muted">
                          <span className="font-bold">{t.symbol}</span>
                          {!isNative && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                copyAddress(t.address);
                              }}
                              title="Copy contract address"
                              className="flex shrink-0 items-center gap-1 truncate hover:text-gold-300"
                            >
                              {shortAddress(t.address)}
                              {copiedAddress === t.address ? (
                                <Check size={11} className="shrink-0 text-gold-300" />
                              ) : (
                                <Copy size={11} className="shrink-0" />
                              )}
                            </button>
                          )}
                        </span>
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {bal != null && bal > BigInt(0) && (
                        <span className="text-xs font-bold text-cream">
                          {formatDisplayAmount(bal, t.decimals)}
                        </span>
                      )}
                      {isSelected && <Check size={18} className="text-gold-300" aria-label="Selected" />}
                    </span>
                  </div>
                );
              })}

              {query.trim().length >= 2 && (chainSearchLoading || chainResults.length > 0) && (
                <div>
                  <SectionLabel icon={<Globe size={12} />}>More on-chain — unverified</SectionLabel>
                  {chainSearchLoading && chainResults.length === 0 && (
                    <p className="px-2 py-3 text-center text-xs text-cream-muted">
                      Searching Robinhood Chain…
                    </p>
                  )}
                  {chainResults.map((t) => {
                    const bal = balances.get(t.address.toLowerCase());
                    return (
                      <div
                        key={t.address}
                        role="button"
                        tabIndex={0}
                        // Clicking a discovery result re-runs the SAME on-chain
                        // check the paste-an-address flow uses (by handing it
                        // the address) — never trusts this row's fields for a
                        // quote, and still requires the explicit confirm step.
                        onClick={() => setQuery(t.address)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setQuery(t.address);
                          }
                        }}
                        className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors hover:border-amber-500/40 hover:bg-amber-950/20"
                      >
                        <TokenIcon symbol={t.symbol} logoURI={t.logoURI} size={30} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-bold text-cream">{t.name}</span>
                          <span className="flex items-center gap-1.5 truncate text-[0.7rem] text-cream-muted">
                            <span className="font-bold">{t.symbol}</span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                copyAddress(t.address);
                              }}
                              title="Copy contract address"
                              className="flex shrink-0 items-center gap-1 truncate hover:text-gold-300"
                            >
                              {shortAddress(t.address)}
                              {copiedAddress === t.address ? (
                                <Check size={11} className="shrink-0 text-gold-300" />
                              ) : (
                                <Copy size={11} className="shrink-0" />
                              )}
                            </button>
                          </span>
                        </span>
                        {bal != null && bal > BigInt(0) && (
                          <span className="shrink-0 text-xs font-bold text-cream">
                            {formatDisplayAmount(bal, t.decimals)}
                          </span>
                        )}
                        <AlertTriangle size={14} className="shrink-0 text-amber-300" aria-hidden="true" />
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
