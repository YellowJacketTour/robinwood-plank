"use client";

import { useCallback, useEffect, useState } from "react";
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
    trapStartsAt: string;
    tradeOpensAt: string;
    cooldownsEndAt: string;
    sniperTrapMinutes: number;
    walletCooldownMinutes: number;
    serverNow: string;
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
  legend: {
    goodWood: string;
    badBoards: string;
    fallen: string;
    cooldown: string;
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
  cooldown: {
    active: boolean;
    remainingMs: number;
    endsAt: string | null;
  } | null;
  badEntry: BadEntry | null;
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
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function sideStamp(side: string) {
  if (side === "good_wood") return { label: "NICE", cls: "text-emerald-300 border-emerald-400/70" };
  if (side === "fallen") return { label: "FALLEN", cls: "text-amber-300 border-amber-400/70" };
  if (side === "bad_boards") return { label: "NAUGHTY", cls: "text-orange-300 border-orange-400/70" };
  return { label: "UNKNOWN", cls: "text-foreground/60 border-foreground/40" };
}

export default function WoodYouJustLookAtIt() {
  const [data, setData] = useState<BoardsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [lookupAddr, setLookupAddr] = useState("");
  const [lookup, setLookup] = useState<WalletLookup | null>(null);
  const [lookupErr, setLookupErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/boards", { cache: "no-store" });
      const json = (await res.json()) as BoardsPayload;
      if (!res.ok) throw new Error((json as { message?: string }).message || "Load failed");
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load boards");
    }
  }, []);

  useEffect(() => {
    load();
    const id = window.setInterval(load, 20_000);
    return () => window.clearInterval(id);
  }, [load]);

  async function runScan() {
    setScanning(true);
    try {
      await fetch("/api/boards/scan", { method: "POST" });
      await load();
    } catch {
      // ignore
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
  const nice = data?.niceLedger ?? [];
  const naughty = data?.naughtyLedger ?? data?.recentBadBoards ?? [];

  return (
    <section id="boards" className="section-tight scroll-mt-20 px-3 sm:px-5">
      <div className="mx-auto max-w-5xl">
        <Reveal>
          <SectionHead
            eyebrow="The wooden ledger · naughty · nice"
            title="Wood You Just Look At It"
            lede="Santa's list, but grainier. Nice = Good Wood. Naughty = Bad Boards. 30m cooldowns while we ink the pages."
            artSrc="/images/collection/plank-redacted.png"
            artAlt="Redacted collection plank"
          />
        </Reveal>

        {/* Compact tally strip */}
        <Reveal delayMs={40}>
          <div className="mt-3 grid grid-cols-4 gap-1.5 sm:gap-2">
            {[
              { label: "Nice", value: counts?.goodWood ?? "—", sub: "Good Wood" },
              { label: "Naughty", value: counts?.badBoards ?? "—", sub: "Bad Boards" },
              { label: "Fallen", value: counts?.fallen ?? "—", sub: "Were nice" },
              { label: "Verified", value: counts?.widgetVerified ?? "—", sub: "Widget" },
            ].map((c) => (
              <div key={c.label} className="wood-ledger px-1.5 py-1.5 text-center sm:px-2 sm:py-2">
                <p className="text-[0.55rem] font-bold uppercase tracking-wider text-gold-300/90">
                  {c.label}
                </p>
                <p className="font-display text-lg leading-none text-gold-300 sm:text-2xl">{c.value}</p>
                <p className="text-[0.55rem] text-foreground/55">{c.sub}</p>
              </div>
            ))}
          </div>
        </Reveal>

        {/* Phase + scan — dense toolbar on the ledger */}
        <Reveal delayMs={60}>
          <div className="wood-ledger mt-2.5 flex flex-col gap-2 p-2.5 sm:flex-row sm:items-center sm:justify-between sm:p-3">
            <div className="min-w-0">
              <p className="text-[0.6rem] font-bold uppercase tracking-wider text-gold-300">
                Ledger phase · {trap ? phaseLabel(trap.phase) : "…"}
                {trap?.active ? " · INKING" : ""}
              </p>
              {trap && (
                <p className="mt-0.5 text-[0.65rem] text-foreground/60">
                  Cooldowns end {new Date(trap.cooldownsEndAt).toLocaleString()} · 30m / wallet
                </p>
              )}
              {error && <p className="mt-1 text-xs text-red-300">{error}</p>}
            </div>
            <button
              type="button"
              onClick={runScan}
              disabled={scanning}
              className="min-h-9 shrink-0 rounded-md bg-gold-500 px-3 py-1.5 text-xs font-bold text-wood-950 hover:bg-gold-400 disabled:opacity-50"
            >
              {scanning ? "Reading chain…" : "Update ledger from chain"}
            </button>
          </div>
        </Reveal>

        {/* THE LEDGER — Naughty | Nice */}
        <Reveal delayMs={80}>
          <div className="wood-ledger mt-3 overflow-hidden">
            {/* Title plate */}
            <div className="border-b-2 border-[#c4922e]/60 px-3 py-2 text-center sm:px-4 sm:py-2.5">
              <p className="font-display text-lg tracking-wide text-gold-300 sm:text-xl">
                Official Wooden Ledger
              </p>
              <p className="text-[0.65rem] font-bold uppercase tracking-[0.2em] text-foreground/60">
                of the Naughty &amp; the Nice
              </p>
            </div>

            <div className="grid sm:grid-cols-[1fr_auto_1fr]">
              {/* NICE — Good Wood */}
              <div className="min-w-0 border-b border-[#c4922e]/40 sm:border-b-0">
                <div className="flex items-center justify-between gap-2 border-b border-[#c4922e]/35 bg-forest-900/50 px-2.5 py-1.5">
                  <div>
                    <p className="font-display text-sm text-emerald-300 sm:text-base">Nice</p>
                    <p className="text-[0.6rem] text-foreground/55">Good Wood · mint · airdrop</p>
                  </div>
                  <span className="wood-ledger-stamp text-[0.55rem] text-emerald-300">
                    Good Wood
                  </span>
                </div>
                <div className="wood-ledger-ruled max-h-64 overflow-y-auto px-2 py-1 sm:max-h-80 sm:px-2.5">
                  {nice.length === 0 && (
                    <p className="wood-ledger-entry py-2 text-foreground/45">
                      (ledger warming — wood list loads from proofs)
                    </p>
                  )}
                  {nice.map((addr, i) => (
                    <div
                      key={addr}
                      className="wood-ledger-entry wood-ledger-entry-nice flex items-baseline justify-between gap-2 border-b border-transparent"
                    >
                      <span className="shrink-0 text-foreground/40">{String(i + 1).padStart(2, "0")}.</span>
                      <code className="min-w-0 flex-1 truncate" title={addr}>
                        {shortAddress(addr, 6)}
                      </code>
                      <span className="shrink-0 text-[0.55rem] uppercase text-emerald-400/80">nice</span>
                    </div>
                  ))}
                  {(counts?.goodWood ?? 0) > nice.length && (
                    <p className="wood-ledger-entry pt-1 text-[0.65rem] text-foreground/45">
                      … +{(counts?.goodWood ?? 0) - nice.length} more Good Wood on file
                    </p>
                  )}
                </div>
              </div>

              {/* Spine */}
              <div
                className="wood-ledger-spine hidden w-2 sm:block"
                aria-hidden="true"
              />

              {/* NAUGHTY — Bad Boards */}
              <div className="min-w-0">
                <div className="flex items-center justify-between gap-2 border-b border-[#c4922e]/35 bg-[#3a1510]/55 px-2.5 py-1.5">
                  <div>
                    <p className="font-display text-sm text-orange-300 sm:text-base">Naughty</p>
                    <p className="text-[0.6rem] text-foreground/55">Bad Boards · off-widget</p>
                  </div>
                  <span className="wood-ledger-stamp text-[0.55rem] text-orange-300">
                    Bad Boards
                  </span>
                </div>
                <div className="wood-ledger-ruled max-h-64 overflow-y-auto px-2 py-1 sm:max-h-80 sm:px-2.5">
                  {naughty.length === 0 && (
                    <p className="wood-ledger-entry py-2 text-foreground/45">
                      (no ink yet — snipers will appear after LP / scan)
                    </p>
                  )}
                  {naughty.map((b, i) => (
                    <div
                      key={b.address + b.lastSeenAt}
                      className="wood-ledger-entry wood-ledger-entry-naughty flex items-baseline justify-between gap-2"
                    >
                      <span className="shrink-0 text-foreground/40">{String(i + 1).padStart(2, "0")}.</span>
                      <code className="min-w-0 flex-1 truncate" title={b.address}>
                        {shortAddress(b.address, 6)}
                      </code>
                      <span className="shrink-0 text-[0.55rem] uppercase text-orange-400/90">
                        {b.wasGoodWood ? "fallen" : "naughty"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="border-t border-[#c4922e]/40 px-2.5 py-1.5 text-center text-[0.6rem] text-foreground/50">
              He sees you when you&apos;re sniping · He knows when you use Uniswap.app
            </div>
          </div>
        </Reveal>

        {/* Lookup stamped onto the ledger */}
        <Reveal delayMs={110}>
          <form onSubmit={checkWallet} className="wood-ledger mt-3 p-2.5 sm:p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-display text-sm text-gold-300 sm:text-base">
                Look up a name in the ledger
              </h3>
              <span className="wood-ledger-stamp text-[0.55rem] text-gold-300">Check twice</span>
            </div>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                value={lookupAddr}
                onChange={(e) => setLookupAddr(e.target.value)}
                placeholder="0x… wallet"
                className="min-h-10 min-w-0 flex-1 rounded-md border border-[#c4922e]/50 bg-[#1b120a]/80 px-2.5 font-mono text-xs text-gold-300 outline-none placeholder:text-foreground/35 focus:border-gold-400 sm:text-sm"
              />
              <button
                type="submit"
                className="min-h-10 rounded-md bg-gold-500 px-4 text-xs font-bold text-wood-950 hover:bg-gold-400 sm:text-sm"
              >
                Consult ledger
              </button>
            </div>
            {lookupErr && <p className="mt-1.5 text-xs text-red-300">{lookupErr}</p>}
            {lookup && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-[#c4922e]/35 bg-[#1b120a]/60 px-2.5 py-2">
                <span className={`wood-ledger-stamp text-[0.6rem] ${sideStamp(lookup.side).cls}`}>
                  {sideStamp(lookup.side).label}
                </span>
                <code className="font-mono text-xs text-gold-300" title={lookup.address}>
                  {shortAddress(lookup.address, 6)}
                </code>
                {lookup.widgetVerified && (
                  <span className="text-[0.65rem] text-emerald-300/90">widget path</span>
                )}
                {lookup.cooldown?.active && (
                  <span className="text-[0.65rem] text-gold-300">
                    cooldown {fmtRemain(lookup.cooldown.remainingMs)}
                  </span>
                )}
              </div>
            )}
          </form>
        </Reveal>
      </div>
    </section>
  );
}
