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
    <section id="boards" className="section-tight scroll-mt-20 px-3 sm:px-5">
      <div className="mx-auto max-w-5xl">
        <Reveal>
          <SectionHead
            eyebrow="Live list · death trap · cooldowns"
            title="Wood You Just Look At It"
            lede="Good Wood held the line. Bad Boards sniped or left the widget. 30m per-wallet cooldowns while we list them."
            artSrc="/images/collection/plank-redacted.png"
            artAlt="Redacted collection plank"
          />
        </Reveal>

        <Reveal delayMs={40}>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "Good Wood", value: counts?.goodWood ?? "—", hint: "Mint + airdrop", border: "border-forest-600/50" },
              { label: "Bad Boards", value: counts?.badBoards ?? "—", hint: "Off-widget", border: "border-red-500/40" },
              { label: "Fallen", value: counts?.fallen ?? "—", hint: "Good → bad", border: "border-gold-500/40" },
              { label: "Widget OK", value: counts?.widgetVerified ?? "—", hint: "plank.love", border: "border-gold-500/25" },
            ].map((c) => (
              <div key={c.label} className={`dense-card border ${c.border} px-2 py-2 text-center sm:px-3`}>
                <p className="text-[0.55rem] font-bold uppercase tracking-wider text-foreground/50 sm:text-[0.6rem]">
                  {c.label}
                </p>
                <p className="font-display text-xl leading-tight text-gold-300 sm:text-2xl">{c.value}</p>
                <p className="text-[0.6rem] text-foreground/50">{c.hint}</p>
              </div>
            ))}
          </div>
        </Reveal>

        <Reveal delayMs={70}>
          <div className="dense-card mt-3 flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-3.5">
            <div className="min-w-0">
              <p className="text-[0.6rem] font-bold uppercase tracking-wider text-gold-300">Phase</p>
              <p className="font-display text-base text-foreground sm:text-lg">
                {trap ? phaseLabel(trap.phase) : "…"}
                {trap && (
                  <span className="ml-2 text-xs font-sans font-bold text-foreground/55">
                    {trap.active ? "LISTING" : "idle"}
                  </span>
                )}
              </p>
              {trap && (
                <p className="mt-0.5 text-[0.65rem] text-foreground/55">
                  Ends {new Date(trap.cooldownsEndAt).toLocaleString()} · {data?.legend.cooldown}
                </p>
              )}
              {data?.scan?.notes?.[0] && (
                <p className="mt-1 truncate font-mono text-[0.6rem] text-foreground/40">{data.scan.notes[0]}</p>
              )}
              {error && <p className="mt-1 text-xs text-red-300">{error}</p>}
            </div>
            <button
              type="button"
              onClick={runScan}
              disabled={scanning}
              className="min-h-10 shrink-0 rounded-lg bg-gold-500 px-3 py-2 text-xs font-bold text-wood-950 hover:bg-gold-400 disabled:opacity-50 sm:text-sm"
            >
              {scanning ? "Scanning…" : "Scan chain"}
            </button>
          </div>
        </Reveal>

        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <Reveal delayMs={90}>
            <div className="dense-card border-forest-600/40 p-3 sm:p-3.5">
              <h3 className="font-display text-base text-gold-300">Good Wood</h3>
              <p className="mt-0.5 text-[0.7rem] text-foreground/65">{data?.legend.goodWood}</p>
              <ul className="mt-2 space-y-0.5 text-[0.7rem] text-foreground/70">
                <li>· Wood List (mint proofs)</li>
                <li>· Airdrop wallets</li>
                <li>· Official widget only in the trap</li>
              </ul>
            </div>
          </Reveal>

          <Reveal delayMs={100}>
            <div className="dense-card border-red-500/35 p-3 sm:p-3.5">
              <h3 className="font-display text-base text-gold-300">Bad Boards</h3>
              <p className="mt-0.5 text-[0.7rem] text-foreground/65">{data?.legend.badBoards}</p>
              <div className="mt-2 max-h-52 space-y-1.5 overflow-y-auto pr-0.5">
                {(data?.recentBadBoards?.length ?? 0) === 0 && (
                  <p className="text-xs text-foreground/50">Empty — keep waiting.</p>
                )}
                {data?.recentBadBoards?.map((b) => (
                  <div
                    key={b.address + b.lastSeenAt}
                    className="rounded-md border border-gold-500/15 bg-wood-950/80 px-2 py-1.5 text-[0.7rem]"
                  >
                    <div className="flex items-center justify-between gap-1">
                      <code className="font-mono text-gold-300" title={b.address}>
                        {shortAddress(b.address, 5)}
                      </code>
                      {b.wasGoodWood && (
                        <span className="text-[0.55rem] font-bold uppercase text-gold-300">Fallen</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
        </div>

        <Reveal delayMs={120}>
          <form onSubmit={checkWallet} className="dense-card mt-3 p-3 sm:p-3.5">
            <h3 className="font-display text-base text-gold-300">Check a wallet</h3>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                value={lookupAddr}
                onChange={(e) => setLookupAddr(e.target.value)}
                placeholder="0x…"
                className="min-h-10 min-w-0 flex-1 rounded-lg border border-gold-500/30 bg-wood-950 px-2.5 font-mono text-xs text-foreground outline-none focus:border-gold-400 sm:text-sm"
              />
              <button
                type="submit"
                className="min-h-10 rounded-lg bg-gold-500 px-4 text-xs font-bold text-wood-950 hover:bg-gold-400 sm:text-sm"
              >
                Look
              </button>
            </div>
            {lookupErr && <p className="mt-1.5 text-xs text-red-300">{lookupErr}</p>}
            {lookup && (
              <div className="mt-2 rounded-md border border-gold-500/20 bg-wood-950/80 px-2.5 py-2 text-xs">
                <strong className="text-gold-300">{lookup.side}</strong>
                {lookup.widgetVerified ? " · widget OK" : ""}
                {lookup.cooldown?.active && (
                  <span className="ml-2">cooldown {fmtRemain(lookup.cooldown.remainingMs)}</span>
                )}
              </div>
            )}
          </form>
        </Reveal>
      </div>
    </section>
  );
}
