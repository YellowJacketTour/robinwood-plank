"use client";

import { useEffect, useRef, useState } from "react";
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
  niceLedger?: string[];
  naughtyLedger?: BadEntry[];
  live?: {
    autoScanEveryMs: number;
    listingActive: boolean;
    lastAutoScan?: { ran: boolean; newBad?: number };
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

const POLL_MS_ACTIVE = 8_000;
const POLL_MS_IDLE = 30_000;

export default function WoodYouJustLookAtIt() {
  const [data, setData] = useState<BoardsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [livePulse, setLivePulse] = useState(false);
  const [lookupAddr, setLookupAddr] = useState("");
  const [lookup, setLookup] = useState<WalletLookup | null>(null);
  const [lookupErr, setLookupErr] = useState<string | null>(null);
  const lastBadCount = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let listingActive = false;

    async function tick() {
      if (cancelled) return;
      try {
        const res = await fetch("/api/boards", { cache: "no-store" });
        const json = (await res.json()) as BoardsPayload & { message?: string };
        if (!cancelled && res.ok) {
          const bad = json.counts?.badBoards ?? 0;
          if (bad > lastBadCount.current) setLivePulse(true);
          lastBadCount.current = bad;
          listingActive = Boolean(json.trap?.active || json.live?.listingActive);
          setData(json);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load boards");
      }
      if (cancelled) return;
      timer = window.setTimeout(tick, listingActive ? POLL_MS_ACTIVE : POLL_MS_IDLE);
    }

    tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

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
      if (res.ok) setData((await res.json()) as BoardsPayload);
    } finally {
      setScanning(false);
    }
  }

  async function checkWallet(e: React.FormEvent) {
    e.preventDefault();
    setLookupErr(null);
    setLookup(null);
    try {
      const res = await fetch(`/api/boards/wallet?address=${encodeURIComponent(lookupAddr.trim())}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || "Lookup failed");
      setLookup(json as WalletLookup);
    } catch (err) {
      setLookupErr(err instanceof Error ? err.message : "Lookup failed");
    }
  }

  const trap = data?.trap;
  const counts = data?.counts;
  const goodList = data?.niceLedger ?? [];
  const badList = data?.naughtyLedger ?? data?.recentBadBoards ?? [];
  const listingLive = Boolean(trap?.active || data?.live?.listingActive);

  return (
    <section id="boards" className="section-tight scroll-mt-20 px-3 sm:px-5">
      <div className="site-shell">
        <Reveal>
          <SectionHead
            eyebrow="Wooden ledger · live scan"
            title="Wood You Just Look At It"
            lede="Good Wood held the line. Bad Boards sniped or left the widget. Scanner runs while the trap is live."
            artSrc="/images/collection/plank-redacted.png"
            artAlt="Redacted collection plank"
          />
        </Reveal>

        <Reveal delayMs={40}>
          <div className="wood-ledger mt-3 grid grid-cols-2 gap-px overflow-hidden sm:grid-cols-5">
            {[
              { k: "Good Wood", v: counts?.goodWood },
              { k: "Bad Boards", v: counts?.badBoards },
              { k: "Fallen", v: counts?.fallen },
              { k: "Widget", v: counts?.widgetVerified },
            ].map((c) => (
              <div key={c.k} className="bg-[#2a1a0f]/80 px-2 py-2 text-center">
                <p className="text-[0.55rem] font-bold uppercase tracking-wide text-gold-300/80">{c.k}</p>
                <p
                  className={`font-display text-xl leading-none sm:text-2xl ${
                    c.k === "Bad Boards" && livePulse ? "text-orange-300" : "text-gold-300"
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
          {error && <p className="mt-1 text-xs text-red-300">{error}</p>}
        </Reveal>

        <Reveal delayMs={70}>
          <div className="wood-ledger mt-2.5 overflow-hidden">
            <div className="grid sm:grid-cols-2">
              <div className="min-w-0 border-b border-[#c4922e]/35 sm:border-b-0 sm:border-r sm:border-[#c4922e]/35">
                <header className="flex items-center justify-between border-b border-[#c4922e]/35 bg-forest-900/45 px-2.5 py-1.5">
                  <h3 className="font-display text-sm text-emerald-300 sm:text-base">Good Wood</h3>
                  <span className="text-[0.55rem] font-bold uppercase tracking-wider text-emerald-400/70">
                    mint · airdrop
                  </span>
                </header>
                <div className="wood-ledger-ruled max-h-56 overflow-y-auto px-2 py-0.5 sm:max-h-72">
                  {goodList.length === 0 ? (
                    <p className="wood-ledger-entry text-foreground/40">Loading…</p>
                  ) : (
                    goodList.map((addr, i) => (
                      <div key={addr} className="wood-ledger-entry wood-ledger-good flex gap-1.5">
                        <span className="w-5 shrink-0 text-foreground/35">{i + 1}</span>
                        <code className="min-w-0 flex-1 truncate" title={addr}>
                          {shortAddress(addr, 5)}
                        </code>
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
                  <h3 className="font-display text-sm text-orange-300 sm:text-base">Bad Boards</h3>
                  <span className="text-[0.55rem] font-bold uppercase tracking-wider text-orange-400/70">
                    {listingLive ? "live feed" : "off-widget"}
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
                        className="wood-ledger-entry wood-ledger-bad flex gap-1.5"
                      >
                        <span className="w-5 shrink-0 text-foreground/35">{i + 1}</span>
                        <code className="min-w-0 flex-1 truncate" title={b.address}>
                          {shortAddress(b.address, 5)}
                        </code>
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
              </p>
            )}
          </form>
        </Reveal>
      </div>
    </section>
  );
}
