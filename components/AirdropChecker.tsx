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
  } | null;
};

/** Human %: enough digits to read, no runaway zeros */
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

/** Compact for huge meme supply (888T scale): 16.5B, 37.4T */
function fmtTokens(s: string | number | null | undefined): string {
  if (s == null || s === "") return "—";
  try {
    const n =
      typeof s === "number"
        ? BigInt(Math.floor(s))
        : BigInt(String(s).split(".")[0] || "0");
    if (n < BigInt(0)) return "0";
    const units: Array<{ div: bigint; suf: string }> = [
      { div: BigInt("1000000000000000"), suf: "Q" },
      { div: BigInt("1000000000000"), suf: "T" },
      { div: BigInt("1000000000"), suf: "B" },
      { div: BigInt("1000000"), suf: "M" },
      { div: BigInt("1000"), suf: "K" },
    ];
    for (const u of units) {
      if (n >= u.div) {
        const whole = n / u.div;
        const tenth = Number(((n % u.div) * BigInt(10)) / u.div);
        if (whole >= BigInt(100) || tenth === 0) {
          return `${whole.toLocaleString("en-US")}${u.suf}`;
        }
        return `${whole.toLocaleString("en-US")}.${tenth}${u.suf}`;
      }
    }
    return n.toLocaleString("en-US");
  } catch {
    return String(s);
  }
}

function sourceShort(s: string): string {
  if (s === "both") return "both";
  if (s === "airdrop") return "extra";
  return "wood";
}

const PREVIEW_ROWS = 10;
const LIST_PAGE = 250;

export default function AirdropChecker() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rows, setRows] = useState<CompactRow[]>([]);
  const [listTotal, setListTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [streamLive, setStreamLive] = useState(false);
  const [pulse, setPulse] = useState(false);
  const [filter, setFilter] = useState("");
  const [checkAddr, setCheckAddr] = useState("");
  const [lookup, setLookup] = useState<LookupResult | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [visible, setVisible] = useState(LIST_PAGE);
  const [expanded, setExpanded] = useState(false);
  const lastFp = useRef("");

  const applySummary = useCallback(
    (s: Summary, nextRows?: CompactRow[], total?: number) => {
      const fp = [
        s.counts.approved,
        s.counts.totalWeight,
        s.config.airdropPoolTokens,
        s.config.airdropPercentOfSupply,
      ].join("|");
      if (fp !== lastFp.current && lastFp.current) setPulse(true);
      lastFp.current = fp;
      setSummary(s);
      if (nextRows) {
        setRows(nextRows);
        setListTotal(total ?? nextRows.length);
      }
      setError(null);
    },
    []
  );

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function load(full: boolean) {
      try {
        const lim = full ? 5000 : 500;
        const res = await fetch(`/api/airdrop?list=1&limit=${lim}&offset=0`, {
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

    void load(true);

    function schedule() {
      timer = window.setTimeout(async () => {
        if (cancelled) return;
        if (!streamLive) await load(false);
        if (!cancelled) schedule();
      }, streamLive ? 30_000 : 12_000);
    }
    schedule();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [applySummary, streamLive]);

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
            applySummary(
              json as Summary,
              json.list?.rows || undefined,
              json.list?.total
            );
            setStreamLive(true);
          } catch {
            /* */
          }
        });
        es.addEventListener("tick", (ev) => {
          try {
            const json = JSON.parse((ev as MessageEvent).data) as Summary;
            if (cancelled) return;
            setSummary((prev) => (prev ? { ...prev, ...json } : json));
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
  }, [applySummary]);

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

  const shown = useMemo(() => {
    const cap = expanded ? visible : Math.min(PREVIEW_ROWS, visible);
    return filtered.slice(0, cap);
  }, [filtered, expanded, visible]);

  async function onCheck(e: React.FormEvent) {
    e.preventDefault();
    setLookupBusy(true);
    setLookup(null);
    try {
      const res = await fetch(
        `/api/airdrop?address=${encodeURIComponent(checkAddr.trim())}&list=0`,
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
            lede="Holder airdrop = 4.2069% of total supply. On-chain supply ~888.42T. Check your share — live."
            artSrc="/images/collection/plank-bobawood.png"
            artAlt="Boba wood plank"
          />
        </Reveal>

        <Reveal delayMs={35}>
          <div
            className={`airdrop-panel wood-ledger mt-2 overflow-hidden ${
              pulse ? "ring-1 ring-emerald-400/45" : ""
            }`}
          >
            {/* Stats strip — 4 cells, no empty chrome */}
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
                <div
                  className="airdrop-stat airdrop-stat-sm airdrop-num"
                  title={cfg?.totalSupply}
                >
                  {cfg ? fmtTokens(cfg.totalSupply) : "—"}
                </div>
                <div className="airdrop-meta airdrop-num opacity-70">
                  {cfg ? fmtInt(cfg.totalSupply) : ""}
                </div>
              </div>
              <div className="bg-[#2a1a0f]/85 px-2 py-1.5 sm:px-2.5">
                <div className="airdrop-label">
                  {summary?.equalWeight ? "Each (equal)" : "Weighted"}
                </div>
                {summary?.equalWeight && summary.equalExpectedTokens != null ? (
                  <>
                    <div className="airdrop-stat airdrop-stat-sm airdrop-num text-emerald-300/95">
                      {fmtTokens(summary.equalExpectedTokens)}
                    </div>
                    <div className="airdrop-meta airdrop-num">
                      {fmtPct(summary.equalPctOfSupply)} supply ·{" "}
                      {fmtPct(summary.equalPctOfAirdrop)} drop
                    </div>
                  </>
                ) : summary?.equalWeight && summary.equalPctOfAirdrop != null ? (
                  <>
                    <div className="airdrop-stat airdrop-stat-sm airdrop-num text-emerald-300/95">
                      {fmtPct(summary.equalPctOfAirdrop)}
                      <span className="airdrop-meta ml-1 font-sans !text-[0.62rem]">
                        drop
                      </span>
                    </div>
                    <div className="airdrop-meta airdrop-num">
                      {fmtPct(summary.equalPctOfSupply)} of supply
                    </div>
                  </>
                ) : (
                  <div className="airdrop-stat airdrop-stat-sm airdrop-num">
                    {counts?.totalWeight != null ? fmtInt(counts.totalWeight) : "—"}
                    <span className="airdrop-meta ml-1 font-sans !text-[0.62rem]">
                      weight
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Checker row */}
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
                  inputMode="text"
                />
                <button type="submit" disabled={lookupBusy} className="airdrop-btn">
                  {lookupBusy ? "…" : "Check"}
                </button>
              </div>

              {lookup && (
                <div className="airdrop-result">
                  {lookup.found && lookup.allocation ? (
                    <>
                      <div>
                        <div className="airdrop-result-k">Status</div>
                        <div className="airdrop-result-v ok">Approved</div>
                      </div>
                      <div className="min-w-0 sm:col-span-1">
                        <div className="airdrop-result-k">Wallet</div>
                        <div
                          className="airdrop-result-v truncate font-mono !text-[0.72rem]"
                          title={lookup.allocation.address}
                        >
                          {shortAddress(lookup.allocation.address, 6)}
                        </div>
                      </div>
                      <div>
                        <div className="airdrop-result-k">Of airdrop</div>
                        <div className="airdrop-result-v airdrop-num">
                          {fmtPct(lookup.allocation.pctOfAirdrop)}
                        </div>
                      </div>
                      <div>
                        <div className="airdrop-result-k">Of supply</div>
                        <div className="airdrop-result-v airdrop-num !text-emerald-300">
                          {fmtPct(lookup.allocation.pctOfSupply)}
                        </div>
                      </div>
                      <div>
                        <div className="airdrop-result-k">Expected</div>
                        <div className="airdrop-result-v airdrop-num">
                          {fmtTokens(lookup.allocation.expectedTokens)}
                          <span className="airdrop-meta ml-0.5">PLANK</span>
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

            {/* List toolbar */}
            <div className="flex items-center gap-1.5 border-b border-[#c4922e]/35 bg-[#24160d]/70 px-2 py-1 sm:px-2.5">
              <span className="airdrop-label shrink-0 !tracking-[0.06em]">
                Approved · {fmtInt(totalShown)}
              </span>
              <input
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setVisible(LIST_PAGE);
                }}
                placeholder="Filter…"
                className="airdrop-input ml-auto w-[7.5rem] sm:w-40"
                spellCheck={false}
                aria-label="Filter wallets"
              />
              <button
                type="button"
                className="airdrop-btn airdrop-btn-ghost"
                onClick={() => {
                  setExpanded((v) => !v);
                  if (!expanded) setVisible(LIST_PAGE);
                }}
              >
                {expanded ? "Less" : "All"}
              </button>
            </div>

            {/* Column headers */}
            <div className="airdrop-row airdrop-row-head border-b border-[#c4922e]/25 px-2 sm:px-2.5">
              <span>#</span>
              <span>Wallet</span>
              <span className="text-right">Drop %</span>
              <span className="text-right">Supply %</span>
              <span className="text-right">PLANK</span>
              <span className="hidden text-right sm:inline">Src</span>
            </div>

            <div
              className={`wood-ledger-ruled overflow-y-auto px-2 sm:px-2.5 ${
                expanded ? "max-h-[22rem]" : "max-h-[14.5rem]"
              }`}
            >
              {shown.length === 0 ? (
                <div className="airdrop-meta py-2">
                  {error || "Loading approved wallets…"}
                </div>
              ) : (
                shown.map((r, i) => (
                  <div key={r.a} className="airdrop-row">
                    <span className="text-foreground/40 airdrop-num">{i + 1}</span>
                    <code className="min-w-0 truncate font-mono" title={r.a}>
                      {shortAddress(r.a, 5)}
                    </code>
                    <span className="airdrop-num text-right font-semibold text-gold-300">
                      {fmtPct(r.pa)}
                    </span>
                    <span className="airdrop-num text-right text-emerald-300/90">
                      {fmtPct(r.ps)}
                    </span>
                    <span className="airdrop-num text-right text-[#f3e0b0]">
                      {fmtTokens(r.t)}
                    </span>
                    <span className="airdrop-meta hidden text-right !text-[0.58rem] uppercase opacity-60 sm:inline">
                      {sourceShort(r.s)}
                      {r.w !== 1 ? `×${r.w}` : ""}
                    </span>
                  </div>
                ))
              )}

              {expanded && visible < filtered.length && (
                <button
                  type="button"
                  onClick={() => setVisible((v) => v + LIST_PAGE)}
                  className="airdrop-meta w-full py-1 text-left font-bold text-gold-300/90 hover:text-gold-300"
                >
                  +{fmtInt(filtered.length - visible)} more
                </button>
              )}
              {!expanded && filtered.length > PREVIEW_ROWS && (
                <button
                  type="button"
                  onClick={() => {
                    setExpanded(true);
                    setVisible(LIST_PAGE);
                  }}
                  className="airdrop-meta w-full py-1 text-left font-bold text-gold-300/80 hover:text-gold-300"
                >
                  +{fmtInt(filtered.length - PREVIEW_ROWS)} more — show all
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 border-t border-[#c4922e]/3 bg-[#1b120a]/55 px-2 py-1 sm:px-2.5">
              <span className="airdrop-meta">
                Wood {fmtInt(counts?.woodList ?? 0)}
                {(counts?.airdropOnly ?? 0) > 0
                  ? ` · extra ${fmtInt(counts?.airdropOnly)}`
                  : ""}
                {(counts?.both ?? 0) > 0 ? ` · both ${fmtInt(counts?.both)}` : ""}
              </span>
              <span className="airdrop-meta opacity-70">
                Estimates · live as list changes
              </span>
            </div>
          </div>
          {error && shown.length > 0 && (
            <div className="mt-1 text-[0.7rem] font-semibold text-red-300">{error}</div>
          )}
        </Reveal>
      </div>
    </section>
  );
}
