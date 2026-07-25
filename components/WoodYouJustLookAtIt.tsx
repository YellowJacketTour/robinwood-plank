"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Reveal from "@/components/Reveal";
import SectionHead from "@/components/SectionHead";
import { shortAddress } from "@/lib/trade";

type BadEntry = {
  address: string;
  firstSeenAt: string;
  lastSeenAt: string;
  reason: string;
  wasGoodWood: boolean;
  sources: string[];
  txHashes: string[];
  ethSpentWei?: string;
  ethSpent?: string;
  ethSpentUsd?: number;
  ethSpentUsdLabel?: string;
  venue?: "death_trap" | "off_site";
  venueLabel?: string;
};

type NiceEntry = {
  address: string;
  label: "plank.love" | "wood_list";
};

type VolumeTick = {
  serverNow: string;
  ethUsd: number;
  ethUsdSource: string;
  totalEthSpent: string;
  totalEthSpentWei: string;
  totalUsd: number;
  totalUsdLabel: string;
  badBoards: number;
  fallen: number;
};

type BoardsPayload = {
  trap: {
    active: boolean;
    phase: string;
    cooldownsEndAt: string;
    walletCooldownMinutes: number;
  };
  counts: {
    goodWood: number;
    badBoards: number;
    widgetVerified: number;
    fallen: number;
  };
  recentBadBoards: BadEntry[];
  niceLedger?: Array<string | NiceEntry>;
  naughtyLedger?: BadEntry[];
  export?: { blacklistCsv?: string; addressesOnly?: string };
  volume?: VolumeTick;
  live?: {
    autoScanEveryMs: number;
    listingActive: boolean;
    lastAutoScan?: { ran: boolean; newBad?: number };
    stream?: string;
  };
  scan?: {
    lastScannedBlock: number;
    notes: string[];
    updatedAt: string;
  };
};

type WalletLookup = {
  address: string;
  side: string;
  widgetVerified: boolean;
  cooldown: { active: boolean; remainingMs: number } | null;
  badEntry?: BadEntry | null;
};

function phaseLabel(phase: string) {
  switch (phase) {
    case "pre_lp":
      return "Pre-LP";
    case "death_trap":
      return "Death trap";
    case "cooldown_window":
      return "Cooldown window";
    case "free":
      return "Free trade";
    default:
      return phase;
  }
}

function fmtRemain(ms: number) {
  if (ms <= 0) return "0:00";
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

function sideLabel(side: string) {
  if (side === "good_wood") return "Good Wood";
  if (side === "fallen") return "Fallen";
  if (side === "bad_boards") return "Bad Boards";
  return "Unknown";
}

function ethLabel(b: BadEntry): string {
  if (b.ethSpent) return b.ethSpent;
  return "0.000";
}

function usdLabel(b: BadEntry, ethUsd: number): string {
  if (b.ethSpentUsdLabel) return b.ethSpentUsdLabel;
  if (b.ethSpentUsd != null && Number.isFinite(b.ethSpentUsd)) {
    return `$${b.ethSpentUsd.toFixed(2)}`;
  }
  // Client recompute if only wei + live price
  if (b.ethSpentWei && ethUsd > 0) {
    try {
      const milli = Number(BigInt(b.ethSpentWei) / BigInt("1000000000000000"));
      return `$${((milli / 1000) * ethUsd).toFixed(2)}`;
    } catch {
      /* fallthrough */
    }
  }
  return "$0.00";
}

const POLL_MS_ACTIVE = 8_000;
const POLL_MS_IDLE = 30_000;

export default function WoodYouJustLookAtIt() {
  const [data, setData] = useState<BoardsPayload | null>(null);
  const [volume, setVolume] = useState<VolumeTick | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [livePulse, setLivePulse] = useState(false);
  const [streamLive, setStreamLive] = useState(false);
  const [lookupAddr, setLookupAddr] = useState("");
  const [lookup, setLookup] = useState<WalletLookup | null>(null);
  const [lookupErr, setLookupErr] = useState<string | null>(null);
  const lastBadCount = useRef(0);
  const lastTotalWei = useRef("0");
  const streamRef = useRef<EventSource | null>(null);

  const applySnapshot = useCallback((json: BoardsPayload) => {
    const bad = json.counts?.badBoards ?? 0;
    const totalWei = json.volume?.totalEthSpentWei ?? "0";
    if (bad > lastBadCount.current || totalWei !== lastTotalWei.current) {
      setLivePulse(true);
    }
    lastBadCount.current = bad;
    lastTotalWei.current = totalWei;
    setData(json);
    if (json.volume) setVolume(json.volume);
    setError(null);
  }, []);

  // SSE live stream (tick-by-tick ETH/USD + ledger)
  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: number | undefined;
    let es: EventSource | null = null;

    function connect() {
      if (cancelled) return;
      try {
        es = new EventSource("/api/boards/stream");
        streamRef.current = es;

        es.addEventListener("snapshot", (ev) => {
          try {
            const json = JSON.parse((ev as MessageEvent).data) as BoardsPayload;
            if (!cancelled) applySnapshot(json);
          } catch {
            // ignore bad frames
          }
        });

        es.addEventListener("tick", (ev) => {
          try {
            const tick = JSON.parse((ev as MessageEvent).data) as VolumeTick;
            if (!cancelled) {
              setVolume(tick);
              setStreamLive(true);
              // Refresh USD labels on ledger rows without full refetch
              setData((prev) => {
                if (!prev?.naughtyLedger && !prev?.recentBadBoards) return prev;
                const list = prev.naughtyLedger ?? prev.recentBadBoards ?? [];
                const ethUsd = tick.ethUsd;
                const nextList = list.map((b) => {
                  if (!b.ethSpentWei || !(ethUsd > 0)) return b;
                  try {
                    const wei = BigInt(b.ethSpentWei);
                    const milli = Number(wei / BigInt("1000000000000000"));
                    const eth = milli / 1000;
                    const usd = eth * ethUsd;
                    const whole = wei / BigInt("1000000000000000000");
                    const frac3 = (wei % BigInt("1000000000000000000")) / BigInt("1000000000000000");
                    return {
                      ...b,
                      ethSpent: `${whole.toString()}.${frac3.toString().padStart(3, "0")}`,
                      ethSpentUsd: usd,
                      ethSpentUsdLabel: `$${usd.toFixed(2)}`,
                    };
                  } catch {
                    return b;
                  }
                });
                return {
                  ...prev,
                  volume: tick,
                  naughtyLedger: nextList,
                  recentBadBoards: nextList,
                  counts: {
                    ...prev.counts,
                    badBoards: tick.badBoards ?? prev.counts.badBoards,
                    fallen: tick.fallen ?? prev.counts.fallen,
                  },
                };
              });
            }
          } catch {
            // ignore
          }
        });

        es.addEventListener("reconnect", () => {
          es?.close();
          if (!cancelled) {
            reconnectTimer = window.setTimeout(connect, 800);
          }
        });

        es.onerror = () => {
          setStreamLive(false);
          es?.close();
          if (!cancelled) {
            reconnectTimer = window.setTimeout(connect, 2_500);
          }
        };

        es.onopen = () => {
          if (!cancelled) setStreamLive(true);
        };
      } catch {
        setStreamLive(false);
        if (!cancelled) {
          reconnectTimer = window.setTimeout(connect, 3_000);
        }
      }
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      es?.close();
      streamRef.current?.close();
      streamRef.current = null;
    };
  }, [applySnapshot]);

  // Poll fallback when SSE is down
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function tick() {
      if (cancelled) return;
      // If stream is healthy, poll slowly as backup; if not, poll faster
      const listingActive = Boolean(
        data?.trap?.active || data?.live?.listingActive
      );
      if (streamLive) {
        timer = window.setTimeout(tick, POLL_MS_IDLE);
        return;
      }
      try {
        const res = await fetch("/api/boards", { cache: "no-store" });
        const json = (await res.json()) as BoardsPayload & { message?: string };
        if (!cancelled && res.ok) applySnapshot(json);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load boards");
      }
      if (cancelled) return;
      timer = window.setTimeout(
        tick,
        listingActive ? POLL_MS_ACTIVE : POLL_MS_IDLE
      );
    }

    // Initial fetch always (SSE may lag on cold start)
    void (async () => {
      try {
        const res = await fetch("/api/boards", { cache: "no-store" });
        const json = (await res.json()) as BoardsPayload;
        if (!cancelled && res.ok) applySnapshot(json);
      } catch {
        // stream may still work
      }
      if (!cancelled) timer = window.setTimeout(tick, POLL_MS_ACTIVE);
    })();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poll driven by streamLive
  }, [streamLive, applySnapshot]);

  useEffect(() => {
    if (!livePulse) return;
    const t = window.setTimeout(() => setLivePulse(false), 2_000);
    return () => window.clearTimeout(t);
  }, [livePulse]);

  async function runScan() {
    setScanning(true);
    try {
      await fetch("/api/boards/scan", { method: "POST" });
      const res = await fetch("/api/boards", { cache: "no-store" });
      if (res.ok) applySnapshot((await res.json()) as BoardsPayload);
    } finally {
      setScanning(false);
    }
  }

  async function checkWallet(e: React.FormEvent) {
    e.preventDefault();
    setLookupErr(null);
    setLookup(null);
    try {
      const res = await fetch(
        `/api/boards/wallet?address=${encodeURIComponent(lookupAddr.trim())}`
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || "Lookup failed");
      setLookup(json as WalletLookup);
    } catch (err) {
      setLookupErr(err instanceof Error ? err.message : "Lookup failed");
    }
  }

  const trap = data?.trap;
  const counts = data?.counts;
  const goodList: NiceEntry[] = (data?.niceLedger ?? []).map((row) =>
    typeof row === "string"
      ? { address: row, label: "wood_list" as const }
      : row
  );
  const badList = data?.naughtyLedger ?? data?.recentBadBoards ?? [];
  const listingLive = Boolean(trap?.active || data?.live?.listingActive);
  const ethUsd = volume?.ethUsd ?? data?.volume?.ethUsd ?? 0;
  const totalEth = volume?.totalEthSpent ?? data?.volume?.totalEthSpent ?? "0.000";
  const totalUsd =
    volume?.totalUsdLabel ?? data?.volume?.totalUsdLabel ?? "$0.00";

  function downloadBlacklist(format: "csv" | "addresses") {
    const path =
      format === "csv"
        ? data?.export?.blacklistCsv || "/api/boards/export?format=csv"
        : data?.export?.addressesOnly || "/api/boards/export?format=addresses";
    // One-click download for 20lab / ops
    window.location.href = path;
  }

  return (
    <section id="boards" className="section-tight scroll-mt-20 px-3 sm:px-5">
      <div className="site-shell">
        <Reveal>
          <SectionHead
            eyebrow="Wooden ledger · live scan"
            title="Wood You Just Look At It"
            lede="plank.love widget vs off-site/Uniswap labeled. Death trap + post-open off-widget snipes → Bad Boards. One-click CSV for 20lab."
            artSrc="/images/collection/plank-redacted.png"
            artAlt="Redacted collection plank"
          />
        </Reveal>

        <Reveal delayMs={40}>
          <div
            className={`wood-ledger mt-3 overflow-hidden px-3 py-2 ${
              livePulse ? "ring-1 ring-orange-400/50" : ""
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-[0.55rem] font-bold uppercase tracking-wider text-orange-300/90">
                  <span
                    className={`inline-block h-1.5 w-1.5 rounded-full ${
                      streamLive
                        ? "animate-pulse bg-emerald-400"
                        : listingLive
                          ? "animate-pulse bg-amber-400"
                          : "bg-foreground/30"
                    }`}
                    aria-hidden
                  />
                  {streamLive ? "WS live" : listingLive ? "Polling" : "Idle"} · Bad Boards volume
                </p>
                <p className="font-display text-lg leading-tight text-gold-300 sm:text-2xl">
                  <span className={livePulse ? "text-orange-300" : ""}>
                    {totalEth}
                  </span>
                  <span className="ml-1 text-sm font-sans font-bold text-foreground/70 sm:text-base">
                    ETH
                  </span>
                  <span className="mx-1.5 text-foreground/35">·</span>
                  <span className="text-emerald-300/95">{totalUsd}</span>
                </p>
                <p className="text-[0.65rem] text-foreground/50">
                  ETH/USD{" "}
                  {ethUsd > 0
                    ? `$${ethUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
                    : "—"}
                  {volume?.ethUsdSource ? ` · ${volume.ethUsdSource}` : ""}
                  {volume?.serverNow
                    ? ` · ${new Date(volume.serverNow).toLocaleTimeString()}`
                    : ""}
                </p>
              </div>
              <div className="text-right text-[0.65rem] text-foreground/55">
                <p>
                  snipers{" "}
                  <strong className="text-orange-300">
                    {volume?.badBoards ?? counts?.badBoards ?? "—"}
                  </strong>
                </p>
                <p>
                  fallen{" "}
                  <strong className="text-amber-300">
                    {volume?.fallen ?? counts?.fallen ?? "—"}
                  </strong>
                </p>
              </div>
            </div>
          </div>

          <div className="wood-ledger mt-2 grid grid-cols-2 gap-px overflow-hidden sm:grid-cols-5">
            {[
              { k: "Good Wood", v: counts?.goodWood },
              { k: "Bad Boards", v: counts?.badBoards },
              { k: "Fallen", v: counts?.fallen },
              { k: "Widget", v: counts?.widgetVerified },
            ].map((c) => (
              <div key={c.k} className="bg-[#2a1a0f]/80 px-2 py-2 text-center">
                <p className="text-[0.55rem] font-bold uppercase tracking-wide text-gold-300/80">
                  {c.k}
                </p>
                <p
                  className={`font-display text-xl leading-none sm:text-2xl ${
                    c.k === "Bad Boards" && livePulse
                      ? "text-orange-300"
                      : "text-gold-300"
                  }`}
                >
                  {c.v ?? "—"}
                </p>
              </div>
            ))}
            <div className="col-span-2 flex items-center justify-between gap-2 bg-[#2a1a0f]/80 px-2.5 py-2 sm:col-span-1 sm:flex-col sm:justify-center">
              <div className="min-w-0 text-left sm:text-center">
                <p className="flex items-center gap-1.5 text-[0.55rem] font-bold uppercase tracking-wide text-gold-300/80">
                  <span
                    className={`inline-block h-1.5 w-1.5 rounded-full ${
                      listingLive ? "animate-pulse bg-emerald-400" : "bg-foreground/30"
                    }`}
                    aria-hidden
                  />
                  {listingLive ? "Live" : "Idle"} · {trap ? phaseLabel(trap.phase) : "…"}
                </p>
                <p className="truncate text-[0.65rem] text-foreground/55">
                  {data?.scan?.lastScannedBlock
                    ? `block ${data.scan.lastScannedBlock}`
                    : "awaiting scan"}
                </p>
              </div>
              <button
                type="button"
                onClick={runScan}
                disabled={scanning}
                className="min-h-8 shrink-0 rounded bg-gold-500 px-2.5 py-1 text-[0.65rem] font-bold text-wood-950 hover:bg-gold-400 disabled:opacity-50"
              >
                {scanning ? "…" : "Scan now"}
              </button>
            </div>
          </div>

          {/* 20lab blacklist export */}
          <div className="wood-ledger mt-2 flex flex-wrap items-center justify-between gap-2 px-2.5 py-2">
            <p className="text-[0.65rem] text-foreground/60">
              <strong className="text-gold-300">Blacklist CSV</strong> for 20lab — one click.
              plank.love widget buyers stay off this list.
            </p>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => downloadBlacklist("csv")}
                className="min-h-8 rounded bg-orange-500/90 px-3 text-[0.65rem] font-bold text-wood-950 hover:bg-orange-400"
              >
                Download CSV
              </button>
              <button
                type="button"
                onClick={() => downloadBlacklist("addresses")}
                className="min-h-8 rounded border border-[#c4922e]/50 px-3 text-[0.65rem] font-bold text-gold-300 hover:bg-gold-500/10"
              >
                Addresses only
              </button>
            </div>
          </div>

          {error && <p className="mt-1 text-xs text-red-300">{error}</p>}
        </Reveal>

        <Reveal delayMs={70}>
          <div className="wood-ledger mt-2.5 overflow-hidden">
            <div className="grid sm:grid-cols-2">
              <div className="min-w-0 border-b border-[#c4922e]/35 sm:border-b-0 sm:border-r sm:border-[#c4922e]/35">
                <header className="flex items-center justify-between border-b border-[#c4922e]/35 bg-forest-900/45 px-2.5 py-1.5">
                  <h3 className="font-display text-sm text-emerald-300 sm:text-base">
                    Good Wood
                  </h3>
                  <span className="text-[0.55rem] font-bold uppercase tracking-wider text-emerald-400/70">
                    plank.love · wood list
                  </span>
                </header>
                <div className="wood-ledger-ruled max-h-56 overflow-y-auto px-2 py-0.5 sm:max-h-72">
                  {goodList.length === 0 ? (
                    <p className="wood-ledger-entry text-foreground/40">Loading…</p>
                  ) : (
                    goodList.map((row, i) => (
                      <div
                        key={row.address}
                        className="wood-ledger-entry wood-ledger-good flex items-baseline gap-1.5"
                      >
                        <span className="w-5 shrink-0 text-foreground/35">{i + 1}</span>
                        <code className="min-w-0 flex-1 truncate" title={row.address}>
                          {shortAddress(row.address, 5)}
                        </code>
                        <span
                          className={`shrink-0 text-[0.55rem] font-bold uppercase ${
                            row.label === "plank.love"
                              ? "text-emerald-300"
                              : "text-foreground/45"
                          }`}
                          title={
                            row.label === "plank.love"
                              ? "Official plank.love Trade widget"
                              : "Wood List / mint allowlist"
                          }
                        >
                          {row.label === "plank.love" ? "plank.love" : "wood list"}
                        </span>
                      </div>
                    ))
                  )}
                  {(counts?.goodWood ?? 0) > goodList.length && (
                    <p className="wood-ledger-entry text-[0.65rem] text-foreground/40">
                      +{(counts?.goodWood ?? 0) - goodList.length} more
                    </p>
                  )}
                </div>
              </div>

              <div className="min-w-0">
                <header className="flex items-center justify-between border-b border-[#c4922e]/35 bg-[#3a1510]/50 px-2.5 py-1.5">
                  <h3 className="font-display text-sm text-orange-300 sm:text-base">
                    Bad Boards
                  </h3>
                  <span className="text-[0.55rem] font-bold uppercase tracking-wider text-orange-400/70">
                    {streamLive ? "off-site · uni" : listingLive ? "scanning" : "off-widget"}
                  </span>
                </header>
                <div className="wood-ledger-ruled max-h-56 overflow-y-auto px-2 py-0.5 sm:max-h-72">
                  {badList.length === 0 ? (
                    <p className="wood-ledger-entry text-foreground/40">
                      {listingLive ? "Watching chain…" : "Empty until death trap / LP."}
                    </p>
                  ) : (
                    badList.map((b, i) => (
                      <div
                        key={b.address + b.lastSeenAt}
                        className="wood-ledger-entry wood-ledger-bad flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5"
                      >
                        <span className="w-5 shrink-0 text-foreground/35">{i + 1}</span>
                        <code className="min-w-0 flex-1 truncate" title={b.address}>
                          {shortAddress(b.address, 5)}
                        </code>
                        <span
                          className="shrink-0 text-[0.5rem] font-bold uppercase tracking-wide text-orange-300/85"
                          title={b.reason || b.venueLabel}
                        >
                          {b.venue === "off_site"
                            ? "off-site"
                            : b.venue === "death_trap"
                              ? "death trap"
                              : "uni/ext"}
                        </span>
                        <span
                          className="shrink-0 tabular-nums text-[0.65rem] font-semibold text-gold-300"
                          title="ETH spent (3 dp) · USD"
                        >
                          {ethLabel(b)}
                          <span className="font-normal text-foreground/45"> Ξ</span>
                          <span className="mx-0.5 text-foreground/30">/</span>
                          <span className="text-emerald-300/90">{usdLabel(b, ethUsd)}</span>
                        </span>
                        {b.wasGoodWood && (
                          <span className="shrink-0 text-[0.55rem] uppercase text-amber-300/90">
                            fallen
                          </span>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </Reveal>

        <Reveal delayMs={90}>
          <form onSubmit={checkWallet} className="wood-ledger mt-2.5 p-2.5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <label className="sr-only" htmlFor="ledger-lookup">
                Wallet
              </label>
              <input
                id="ledger-lookup"
                value={lookupAddr}
                onChange={(e) => setLookupAddr(e.target.value)}
                placeholder="0x… check wallet"
                className="min-h-9 min-w-0 flex-1 rounded border border-[#c4922e]/45 bg-[#1b120a]/85 px-2.5 font-mono text-xs text-gold-300 outline-none placeholder:text-foreground/35 focus:border-gold-400"
              />
              <button
                type="submit"
                className="min-h-9 rounded bg-gold-500 px-4 text-xs font-bold text-wood-950 hover:bg-gold-400"
              >
                Check
              </button>
            </div>
            {lookupErr && <p className="mt-1.5 text-xs text-red-300">{lookupErr}</p>}
            {lookup && (
              <p className="mt-1.5 text-xs text-foreground/80">
                <strong className="text-gold-300">{sideLabel(lookup.side)}</strong>
                {lookup.widgetVerified ? " · widget" : ""}
                {lookup.cooldown?.active
                  ? ` · cooldown ${fmtRemain(lookup.cooldown.remainingMs)}`
                  : ""}
                {lookup.badEntry?.ethSpent
                  ? ` · ${lookup.badEntry.ethSpent} ETH`
                  : ""}
                {lookup.badEntry?.ethSpentUsdLabel
                  ? ` (${lookup.badEntry.ethSpentUsdLabel})`
                  : ""}
              </p>
            )}
          </form>
        </Reveal>
      </div>
    </section>
  );
}
