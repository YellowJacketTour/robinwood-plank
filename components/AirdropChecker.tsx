"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Reveal from "@/components/Reveal";
import SectionHead from "@/components/SectionHead";
import { shortAddress } from "@/lib/trade";

type CompactRow = {
  a: string;
  s: "wood_list" | "airdrop" | "both";
  w: number;
  pa: number;
  ps: number;
  t: string;
  n?: number;
  f?: number;
  wl?: number;
  p?: number;
};

type Summary = {
  updatedAt: string;
  config: {
    totalSupply: string;
    airdropPercentOfSupply: number;
    airdropPoolTokens: string;
    decimals: number;
    supplySource?: string;
    poolSource?: string;
  };
  counts: {
    approved: number;
    woodList: number;
    airdropOnly: number;
    both: number;
    totalWeight: number;
  };
  equalWeight: boolean;
  equalPctOfAirdrop: number | null;
  equalPctOfSupply: number | null;
  equalExpectedTokens?: string | null;
  woodListCount: number;
  allocationMode?: "equal" | "nft";
  nft?: {
    ready: boolean;
    scannedAt: string | null;
    addresses: number;
    uniqueHolders?: number;
    totalNfts?: number;
  };
};

type LookupResult = {
  found: boolean;
  allocation?: {
    address: string;
    source: string;
    weight: number;
    pctOfAirdrop: number;
    pctOfSupply: number;
    expectedTokens: string;
    nfts?: number;
    freeMinted?: number;
    woodMinted?: number;
    paidMinted?: number;
  } | null;
};

type SortKey = "n" | "f" | "wl" | "p" | "pa" | "ps" | "t" | "a";
type SortDir = "desc" | "asc";

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n === 0) return "0%";
  const abs = Math.abs(n);
  let digits = 2;
  if (abs < 0.0001) digits = 6;
  else if (abs < 0.01) digits = 5;
  else if (abs < 0.1) digits = 4;
  else if (abs < 1) digits = 3;
  const s = n.toFixed(digits).replace(/\.?0+$/, "");
  return `${s}%`;
}

function fmtInt(s: string | number | null | undefined): string {
  if (s == null || s === "") return "—";
  try {
    const n =
      typeof s === "number"
        ? BigInt(Math.floor(s))
        : BigInt(String(s).split(".")[0] || "0");
    return n.toLocaleString("en-US");
  } catch {
    return String(s);
  }
}

function fmtTokens(s: string | number | null | undefined): string {
  if (s == null || s === "") return "—";
  try {
    const n =
      typeof s === "number"
        ? BigInt(Math.floor(s))
        : BigInt(String(s).split(".")[0] || "0");
    if (n < BigInt(0)) return "0";
    // Always show full grouped number for clarity (16,552,233,791)
    // plus compact suffix for huge values in tight columns
    if (n >= BigInt("1000000000000")) {
      // trillions
      const whole = n / BigInt("1000000000000");
      const tenth = Number(((n % BigInt("1000000000000")) * BigInt(10)) / BigInt("1000000000000"));
      return tenth > 0
        ? `${whole.toLocaleString("en-US")}.${tenth}T`
        : `${whole.toLocaleString("en-US")}T`;
    }
    if (n >= BigInt("1000000000")) {
      const whole = n / BigInt("1000000000");
      const tenth = Number(((n % BigInt("1000000000")) * BigInt(10)) / BigInt("1000000000"));
      return tenth > 0
        ? `${whole.toLocaleString("en-US")}.${tenth}B`
        : `${whole.toLocaleString("en-US")}B`;
    }
    return n.toLocaleString("en-US");
  } catch {
    return String(s);
  }
}

function fullTokens(s: string | number | null | undefined): string {
  if (s == null || s === "") return "";
  try {
    const n =
      typeof s === "number"
        ? BigInt(Math.floor(s))
        : BigInt(String(s).split(".")[0] || "0");
    return n.toLocaleString("en-US");
  } catch {
    return String(s);
  }
}

function rowNum(r: CompactRow, key: SortKey): number | string | bigint {
  switch (key) {
    case "n":
      return r.n ?? 0;
    case "f":
      return r.f ?? 0;
    case "wl":
      return r.wl ?? 0;
    case "p":
      return r.p ?? 0;
    case "pa":
      return r.pa;
    case "ps":
      return r.ps;
    case "t":
      try {
        return BigInt(String(r.t).split(".")[0] || "0");
      } catch {
        return BigInt(0);
      }
    case "a":
      return r.a;
  }
}

function sortRows(rows: CompactRow[], key: SortKey, dir: SortDir): CompactRow[] {
  const mul = dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = rowNum(a, key);
    const bv = rowNum(b, key);
    if (typeof av === "string" && typeof bv === "string") {
      return mul * av.localeCompare(bv);
    }
    if (typeof av === "bigint" && typeof bv === "bigint") {
      if (av === bv) return a.a.localeCompare(b.a);
      return mul * (av < bv ? -1 : 1);
    }
    const an = Number(av);
    const bn = Number(bv);
    if (an === bn) return a.a.localeCompare(b.a);
    return mul * (an < bn ? -1 : 1);
  });
}

const PREVIEW_ROWS = 12;
const LIST_PAGE = 300;

export default function AirdropChecker() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rows, setRows] = useState<CompactRow[]>([]);
  const [listTotal, setListTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [streamLive, setStreamLive] = useState(false);
  const [pulse, setPulse] = useState(false);
  const [nftLoading, setNftLoading] = useState(false);
  const [nftReady, setNftReady] = useState(false);
  const [filter, setFilter] = useState("");
  const [checkAddr, setCheckAddr] = useState("");
  const [lookup, setLookup] = useState<LookupResult | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [visible, setVisible] = useState(LIST_PAGE);
  const [expanded, setExpanded] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("n");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const lastFp = useRef("");

  const applySummary = useCallback(
    (s: Summary, nextRows?: CompactRow[], total?: number) => {
      const fp = [
        s.counts.approved,
        s.counts.totalWeight,
        s.config.airdropPoolTokens,
        s.config.airdropPercentOfSupply,
        s.nft?.ready ? "1" : "0",
      ].join("|");
      if (fp !== lastFp.current && lastFp.current) setPulse(true);
      lastFp.current = fp;
      setSummary(s);
      if (nextRows) {
        setRows(nextRows);
        setListTotal(total ?? nextRows.length);
      }
      if (s.nft?.ready) setNftReady(true);
      setError(null);
    },
    []
  );

  // Allocation list (fast) then NFT enrich
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function loadAlloc() {
      try {
        const res = await fetch(`/api/airdrop?list=1&nft=0&limit=5000&offset=0`, {
          cache: "no-store",
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.message || "Failed to load airdrop");
        if (cancelled) return;
        applySummary(json as Summary, json.list?.rows || [], json.list?.total);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Load failed");
      }
    }

    async function loadNft() {
      setNftLoading(true);
      try {
        const res = await fetch(`/api/airdrop?list=1&nft=1&limit=5000&offset=0`, {
          cache: "no-store",
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.message || "NFT scan failed");
        if (cancelled) return;
        applySummary(json as Summary, json.list?.rows || [], json.list?.total);
        setNftReady(Boolean(json.nft?.ready));
      } catch {
        // keep alloc-only rows
      } finally {
        if (!cancelled) setNftLoading(false);
      }
    }

    void loadAlloc().then(() => {
      if (!cancelled) void loadNft();
    });

    function schedule() {
      timer = window.setTimeout(async () => {
        if (cancelled) return;
        if (!streamLive) await loadAlloc();
        if (!cancelled) schedule();
      }, streamLive ? 45_000 : 15_000);
    }
    schedule();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [applySummary, streamLive]);

  // SSE for allocation ticks (not full NFT rescan)
  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let reconnect: number | undefined;

    function connect() {
      if (cancelled) return;
      try {
        es = new EventSource("/api/airdrop/stream");
        es.addEventListener("snapshot", (ev) => {
          try {
            const json = JSON.parse((ev as MessageEvent).data);
            if (cancelled) return;
            // Stream has no NFT fields — merge into existing n/f/wl/p
            setSummary((prev) => {
              const next = { ...(json as Summary), nft: prev?.nft };
              return next;
            });
            if (json.list?.rows) {
              setRows((prev) => {
                const prevMap = new Map(prev.map((r) => [r.a, r]));
                return (json.list.rows as CompactRow[]).map((r) => {
                  const old = prevMap.get(r.a);
                  return old
                    ? { ...r, n: old.n, f: old.f, wl: old.wl, p: old.p }
                    : r;
                });
              });
              setListTotal(json.list.total ?? 0);
            }
            setStreamLive(true);
          } catch {
            /* */
          }
        });
        es.addEventListener("tick", (ev) => {
          try {
            const json = JSON.parse((ev as MessageEvent).data) as Summary;
            if (cancelled) return;
            setSummary((prev) =>
              prev ? { ...prev, ...json, nft: prev.nft } : json
            );
            setStreamLive(true);
          } catch {
            /* */
          }
        });
        es.addEventListener("reconnect", () => {
          es?.close();
          if (!cancelled) reconnect = window.setTimeout(connect, 1000);
        });
        es.onerror = () => {
          setStreamLive(false);
          es?.close();
          if (!cancelled) reconnect = window.setTimeout(connect, 3000);
        };
        es.onopen = () => {
          if (!cancelled) setStreamLive(true);
        };
      } catch {
        setStreamLive(false);
      }
    }

    connect();
    return () => {
      cancelled = true;
      if (reconnect) window.clearTimeout(reconnect);
      es?.close();
    };
  }, []);

  useEffect(() => {
    if (!pulse) return;
    const t = window.setTimeout(() => setPulse(false), 1400);
    return () => window.clearTimeout(t);
  }, [pulse]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.a.includes(q));
  }, [rows, filter]);

  const sorted = useMemo(
    () => sortRows(filtered, sortKey, sortDir),
    [filtered, sortKey, sortDir]
  );

  const shown = useMemo(() => {
    const cap = expanded ? visible : Math.min(PREVIEW_ROWS, visible);
    return sorted.slice(0, cap);
  }, [sorted, expanded, visible]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir(key === "a" ? "asc" : "desc");
    }
  }

  function sortMark(key: SortKey) {
    if (sortKey !== key) return "";
    return sortDir === "desc" ? " ↓" : " ↑";
  }

  async function onCheck(e: React.FormEvent) {
    e.preventDefault();
    setLookupBusy(true);
    setLookup(null);
    try {
      const res = await fetch(
        `/api/airdrop?address=${encodeURIComponent(checkAddr.trim())}&list=0&nft=1`,
        { cache: "no-store" }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || "Check failed");
      setLookup({ found: Boolean(json.found), allocation: json.allocation });
      if (json.found && json.allocation?.address) {
        setFilter(json.allocation.address);
        setExpanded(true);
      }
    } catch (err) {
      setLookup({ found: false });
      setError(err instanceof Error ? err.message : "Check failed");
    } finally {
      setLookupBusy(false);
    }
  }

  async function refreshNft() {
    setNftLoading(true);
    try {
      const res = await fetch(`/api/airdrop?list=1&nft=1&limit=5000&offset=0`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (res.ok) {
        applySummary(json as Summary, json.list?.rows || [], json.list?.total);
        setNftReady(Boolean(json.nft?.ready));
      }
    } finally {
      setNftLoading(false);
    }
  }

  const cfg = summary?.config;
  const counts = summary?.counts;
  const totalShown = listTotal || rows.length;

  return (
    <section id="airdrop" className="section-tight scroll-mt-20 px-3 sm:px-5">
      <div className="site-shell">
        <Reveal>
          <SectionHead
            eyebrow="Allocation · live"
            title="Airdrop"
            lede="4.2069% of supply split by NFTs held — paste any wallet to check its allocation."
            center
            className="mx-auto max-w-2xl"
          />
        </Reveal>

        <Reveal delayMs={35}>
          <div
            className={`airdrop-panel wood-ledger mt-2 overflow-hidden ${
              pulse ? "ring-1 ring-emerald-400/45" : ""
            }`}
          >
            <div className="grid grid-cols-2 gap-px border-b border-[#c4922e]/40 sm:grid-cols-4">
              <div className="bg-[#2a1a0f]/85 px-2 py-1.5 sm:px-2.5">
                <div className="airdrop-label flex items-center gap-1">
                  <span
                    className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                      streamLive ? "animate-pulse bg-emerald-400" : "bg-foreground/35"
                    }`}
                    aria-hidden
                  />
                  {streamLive ? "Live" : "Sync"} · wallets
                </div>
                <div className={`airdrop-stat airdrop-num ${pulse ? "text-emerald-300" : ""}`}>
                  {counts?.approved != null ? fmtInt(counts.approved) : "—"}
                </div>
              </div>
              <div className="bg-[#2a1a0f]/85 px-2 py-1.5 sm:px-2.5">
                <div className="airdrop-label">Holder pool</div>
                <div className="airdrop-stat airdrop-num">
                  {cfg
                    ? `${Number(cfg.airdropPercentOfSupply).toLocaleString("en-US", {
                        maximumFractionDigits: 4,
                      })}%`
                    : "—"}
                </div>
                <div className="airdrop-meta airdrop-num" title={cfg?.airdropPoolTokens}>
                  {cfg ? fmtTokens(cfg.airdropPoolTokens) : "—"} PLANK
                </div>
              </div>
              <div className="bg-[#2a1a0f]/85 px-2 py-1.5 sm:px-2.5">
                <div className="airdrop-label">
                  Total supply
                  {cfg?.supplySource === "chain" ? " · chain" : ""}
                </div>
                <div className="airdrop-stat airdrop-stat-sm airdrop-num" title={cfg?.totalSupply}>
                  {cfg ? fmtTokens(cfg.totalSupply) : "—"}
                </div>
                <div className="airdrop-meta airdrop-num opacity-70">
                  {cfg ? fmtInt(cfg.totalSupply) : ""}
                </div>
              </div>
              <div className="bg-[#2a1a0f]/85 px-2 py-1.5 sm:px-2.5">
                <div className="airdrop-label">
                  {summary?.allocationMode === "nft" || nftReady
                    ? "Per NFT"
                    : "Mode"}
                </div>
                {summary?.allocationMode === "nft" &&
                summary.nft?.totalNfts &&
                cfg ? (
                  <>
                    <div
                      className="airdrop-stat airdrop-stat-sm airdrop-num text-emerald-300/95"
                      title={fullTokens(
                        (
                          BigInt(cfg.airdropPoolTokens) /
                          BigInt(summary.nft.totalNfts)
                        ).toString()
                      )}
                    >
                      {fmtTokens(
                        (
                          BigInt(cfg.airdropPoolTokens) /
                          BigInt(summary.nft.totalNfts)
                        ).toString()
                      )}
                    </div>
                    <div className="airdrop-meta airdrop-num">
                      ×{summary.nft.totalNfts} NFTs ·{" "}
                      {summary.nft.uniqueHolders ?? "—"} holders
                    </div>
                  </>
                ) : summary?.equalExpectedTokens != null ? (
                  <>
                    <div className="airdrop-stat airdrop-stat-sm airdrop-num text-emerald-300/95">
                      {fmtTokens(summary.equalExpectedTokens)}
                    </div>
                    <div className="airdrop-meta">equal (pre-scan)</div>
                  </>
                ) : (
                  <div className="airdrop-meta">
                    {nftLoading ? "Scanning holdings…" : "Awaiting NFT scan"}
                  </div>
                )}
              </div>
            </div>

            <form
              onSubmit={onCheck}
              className="border-b border-[#c4922e]/35 px-2 py-1.5 sm:px-2.5"
            >
              <div className="flex gap-1.5">
                <label className="sr-only" htmlFor="airdrop-check">
                  Wallet address
                </label>
                <input
                  id="airdrop-check"
                  value={checkAddr}
                  onChange={(e) => {
                    setCheckAddr(e.target.value);
                    setLookup(null);
                  }}
                  placeholder="0x… paste wallet"
                  className="airdrop-input min-w-0 flex-1"
                  spellCheck={false}
                  autoComplete="off"
                />
                <button type="submit" disabled={lookupBusy} className="airdrop-btn">
                  {lookupBusy ? "…" : "Check"}
                </button>
              </div>

              {lookup && (
                <div className="airdrop-result !grid-cols-2 sm:!grid-cols-3 lg:!grid-cols-6">
                  {lookup.found && lookup.allocation ? (
                    <>
                      <div>
                        <div className="airdrop-result-k">Status</div>
                        <div className="airdrop-result-v ok">Approved</div>
                      </div>
                      <div className="min-w-0">
                        <div className="airdrop-result-k">Wallet</div>
                        <div
                          className="airdrop-result-v truncate font-mono !text-[0.72rem]"
                          title={lookup.allocation.address}
                        >
                          {shortAddress(lookup.allocation.address, 6)}
                        </div>
                      </div>
                      <div>
                        <div className="airdrop-result-k">NFTs</div>
                        <div className="airdrop-result-v airdrop-num">
                          {lookup.allocation.nfts ?? "—"}
                        </div>
                      </div>
                      <div>
                        <div className="airdrop-result-k">Free · Wood · Paid</div>
                        <div className="airdrop-result-v airdrop-num">
                          {lookup.allocation.freeMinted ?? 0}
                          <span className="opacity-40"> · </span>
                          {lookup.allocation.woodMinted ?? 0}
                          <span className="opacity-40"> · </span>
                          {lookup.allocation.paidMinted ?? 0}
                        </div>
                      </div>
                      <div>
                        <div className="airdrop-result-k">Of airdrop</div>
                        <div className="airdrop-result-v airdrop-num">
                          {fmtPct(lookup.allocation.pctOfAirdrop)}
                        </div>
                      </div>
                      <div>
                        <div className="airdrop-result-k">Expected</div>
                        <div
                          className="airdrop-result-v airdrop-num"
                          title={fullTokens(lookup.allocation.expectedTokens)}
                        >
                          {fmtTokens(lookup.allocation.expectedTokens)}
                          <span className="airdrop-meta ml-0.5">PLANK</span>
                        </div>
                        <div className="airdrop-meta col-span-full airdrop-num opacity-80">
                          {fullTokens(lookup.allocation.expectedTokens)} PLANK exact
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="col-span-full">
                      <div className="airdrop-result-v bad">
                        Not on the approved airdrop set
                      </div>
                    </div>
                  )}
                </div>
              )}
            </form>

          </div>
          {error && shown.length > 0 && (
            <div className="mt-1 text-[0.7rem] font-semibold text-red-300">{error}</div>
          )}
        </Reveal>
      </div>
    </section>
  );
}

function SortBtn({
  label,
  mark,
  onClick,
  align = "left",
  className = "",
}: {
  label: string;
  mark: string;
  onClick: () => void;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`airdrop-sort ${align === "right" ? "text-right" : "text-left"} ${className}`}
      title={`Sort by ${label}`}
    >
      {label}
      {mark}
    </button>
  );
}
