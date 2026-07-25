"use client";

import { useCallback, useEffect, useState } from "react";
import Reveal from "@/components/Reveal";
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
      return "Death trap (LP live, widget locked)";
    case "cooldown_window":
      return "Cooldown window (30m per wallet)";
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

  return (
    <section id="boards" className="section-tight scroll-mt-24 px-3 sm:px-5">
      <div className="mx-auto max-w-5xl">
        <Reveal>
          <p className="lede text-center text-[0.65rem] font-extrabold uppercase tracking-[0.28em] text-forest-600 sm:text-xs">
            Live list · death trap · cooldowns
          </p>
          <h2 className="section-title mt-1.5 text-center text-3xl text-gold-300 sm:text-4xl md:text-5xl">
            Wood You Just Look At It
          </h2>
          <p className="lede mx-auto mt-2 max-w-2xl text-center text-sm text-foreground/75 sm:text-base">
            Good Wood held the line. Bad Boards jumped the gun or left the official widget. Cooldowns
            run <strong className="text-gold-300">30 minutes per wallet</strong> so we can list
            snipers before free trade.
          </p>
        </Reveal>

        <Reveal delayMs={60}>
          <div className="mt-5 grid gap-3 sm:mt-6 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                label: "Good Wood",
                value: counts?.goodWood ?? "—",
                hint: "Wood List + airdrop",
                border: "border-forest-600/50",
              },
              {
                label: "Bad Boards",
                value: counts?.badBoards ?? "—",
                hint: "Off-widget / snipers",
                border: "border-red-500/40",
              },
              {
                label: "Fallen",
                value: counts?.fallen ?? "—",
                hint: "Were good, went off-site",
                border: "border-gold-500/40",
              },
              {
                label: "Widget verified",
                value: counts?.widgetVerified ?? "—",
                hint: "Used plank.love",
                border: "border-gold-500/25",
              },
            ].map((c) => (
              <div
                key={c.label}
                className={`rounded-xl border ${c.border} bg-wood-900/85 px-3 py-3 text-center`}
              >
                <p className="text-[0.65rem] font-bold uppercase tracking-wider text-foreground/50">
                  {c.label}
                </p>
                <p className="mt-1 font-display text-2xl text-gold-300 sm:text-3xl">{c.value}</p>
                <p className="mt-0.5 text-[0.7rem] text-foreground/55">{c.hint}</p>
              </div>
            ))}
          </div>
        </Reveal>

        <Reveal delayMs={100}>
          <div className="mt-4 rounded-xl border border-gold-500/25 bg-wood-950/80 p-4 sm:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-[0.65rem] font-bold uppercase tracking-wider text-gold-300">
                  Phase
                </p>
                <p className="mt-0.5 font-display text-lg text-foreground sm:text-xl">
                  {trap ? phaseLabel(trap.phase) : "…"}
                </p>
                {trap && (
                  <p className="mt-1 text-xs text-foreground/60">
                    Trap {new Date(trap.trapStartsAt).toLocaleString()} → cooldowns end{" "}
                    {new Date(trap.cooldownsEndAt).toLocaleString()} · listing{" "}
                    {trap.active ? "ACTIVE" : "idle"}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={runScan}
                disabled={scanning}
                className="min-h-11 shrink-0 rounded-lg bg-gold-500 px-4 py-2 text-sm font-bold text-wood-950 hover:bg-gold-400 disabled:opacity-50"
              >
                {scanning ? "Scanning chain…" : "Scan chain for Bad Boards"}
              </button>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-foreground/65">
              {data?.legend.cooldown}
            </p>
            {data?.scan?.notes?.[0] && (
              <p className="mt-2 font-mono text-[0.65rem] text-foreground/45">{data.scan.notes[0]}</p>
            )}
            {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
          </div>
        </Reveal>

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <Reveal delayMs={120}>
            <div className="rounded-xl border border-forest-600/40 bg-forest-900/50 p-4 sm:p-5">
              <h3 className="font-display text-xl text-gold-300">Good Wood</h3>
              <p className="mt-1 text-xs text-foreground/65 sm:text-sm">{data?.legend.goodWood}</p>
              <p className="mt-3 text-sm text-foreground/80">
                Loaded from the official Wood List (mint proofs) plus{" "}
                <code className="text-gold-300">airdrop.json</code>. Stay on the official widget
                during the trap or you fall.
              </p>
              <ul className="mt-3 space-y-1.5 text-xs text-foreground/70">
                <li>· Mint / Wood List addresses</li>
                <li>· Airdrop wallets (seed file)</li>
                <li>· Widget-verified stays clean if you only trade here</li>
              </ul>
            </div>
          </Reveal>

          <Reveal delayMs={140}>
            <div className="rounded-xl border border-red-500/35 bg-wood-950/90 p-4 sm:p-5">
              <h3 className="font-display text-xl text-gold-300">Bad Boards</h3>
              <p className="mt-1 text-xs text-foreground/65 sm:text-sm">{data?.legend.badBoards}</p>
              <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
                {(data?.recentBadBoards?.length ?? 0) === 0 && (
                  <p className="text-sm text-foreground/50">No Bad Boards yet — keep waiting.</p>
                )}
                {data?.recentBadBoards?.map((b) => (
                  <div
                    key={b.address + b.lastSeenAt}
                    className="rounded-lg border border-gold-500/15 bg-wood-900/80 px-2.5 py-2 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-1">
                      <code className="font-mono text-gold-300" title={b.address}>
                        {shortAddress(b.address, 6)}
                      </code>
                      {b.wasGoodWood && (
                        <span className="rounded-full border border-gold-500/40 px-2 py-0.5 text-[0.6rem] font-bold uppercase text-gold-300">
                          Fallen
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-foreground/55">{b.reason}</p>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
        </div>

        <Reveal delayMs={160}>
          <form
            onSubmit={checkWallet}
            className="mt-5 rounded-xl border border-gold-500/25 bg-wood-900/85 p-4 sm:p-5"
          >
            <h3 className="font-display text-lg text-gold-300">Check a wallet</h3>
            <p className="mt-1 text-xs text-foreground/60">
              See Good Wood / Bad Boards / Fallen status and remaining cooldown.
            </p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                value={lookupAddr}
                onChange={(e) => setLookupAddr(e.target.value)}
                placeholder="0x…"
                className="min-h-11 min-w-0 flex-1 rounded-lg border border-gold-500/30 bg-wood-950 px-3 font-mono text-sm text-foreground outline-none focus:border-gold-400"
              />
              <button
                type="submit"
                className="min-h-11 rounded-lg bg-gold-500 px-5 text-sm font-bold text-wood-950 hover:bg-gold-400"
              >
                Look
              </button>
            </div>
            {lookupErr && <p className="mt-2 text-sm text-red-300">{lookupErr}</p>}
            {lookup && (
              <div className="mt-3 rounded-lg border border-gold-500/20 bg-wood-950/80 px-3 py-3 text-sm">
                <p>
                  <span className="text-foreground/55">Side:</span>{" "}
                  <strong className="text-gold-300">{lookup.side}</strong>
                  {lookup.widgetVerified ? " · widget verified" : ""}
                </p>
                {lookup.cooldown?.active && (
                  <p className="mt-1">
                    Cooldown remaining:{" "}
                    <strong className="text-gold-300">
                      {fmtRemain(lookup.cooldown.remainingMs)}
                    </strong>
                  </p>
                )}
                {lookup.badEntry && (
                  <p className="mt-1 text-xs text-foreground/60">{lookup.badEntry.reason}</p>
                )}
              </div>
            )}
          </form>
        </Reveal>
      </div>
    </section>
  );
}
