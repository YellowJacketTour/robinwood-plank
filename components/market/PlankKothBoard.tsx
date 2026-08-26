"use client";

import { useEffect, useMemo, useState } from "react";
import { formatTokenAmount, shortAddress } from "@/lib/trade";
import { formatUsd } from "@/lib/eth-price";
import { usePlankKoth, type PlankKothBuy, type PlankKothLeaderboardRow } from "@/hooks/usePlankKoth";
import { useLiveEthUsd } from "@/hooks/useLiveEthUsd";
import { useTickDirection, type TickDirection } from "@/hooks/useTickDirection";
import { explorerTxUrl, explorerAddressUrl } from "@/lib/market/explorer-links";
import { formatPlankAmount, formatPlankUsdPrice, formatEthFixed } from "@/lib/plank-format";

type Remaining = { days: number; hours: number; minutes: number; seconds: number; complete: boolean };

function getRemaining(target: number): Remaining {
  const distance = Math.max(0, target - Date.now());
  return {
    days: Math.floor(distance / 86_400_000),
    hours: Math.floor((distance / 3_600_000) % 24),
    minutes: Math.floor((distance / 60_000) % 60),
    seconds: Math.floor((distance / 1_000) % 60),
    complete: distance === 0,
  };
}

function pad(n: number | undefined): string {
  return typeof n === "number" ? String(n).padStart(2, "0") : "—";
}

/** Real wall-clock reign length between two real ISO timestamps -- never
 * estimated, computed fresh from becameChampionAt/dethronedAt each render. */
function formatReignDuration(becameChampionAtIso: string, dethronedAtIso: string): string {
  const ms = Date.parse(dethronedAtIso) - Date.parse(becameChampionAtIso);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

const TICK_CLASS: Record<TickDirection, string> = {
  up: "text-emerald-400",
  down: "text-red-400",
  flat: "text-foreground",
};

/** Small "$X.XX" span that genuinely flashes green/red on a real change and
 * settles back to the theme-neutral color when flat -- see
 * hooks/useTickDirection.ts's own header on the honesty constraint.
 *
 * `direction` is optional: when the caller passes one in (see the prize's
 * own usage below), this uses that SHARED signal instead of computing its
 * own from `value` alone. Real reason: the prize's USD figure = its real
 * ETH amount (nearly constant, thinly-traded pool) times the live ETH/USD
 * rate (the actual thing moving) -- ticking USD off its own value and ETH
 * off its own value independently made them flash out of sync (USD moved
 * constantly, ETH almost never), which read as broken/contradictory even
 * though each was individually honest. Since ETH/USD movement is the one
 * real cause driving BOTH figures' dollar-denominated meaning, both use
 * that same direction so "the prize's value just rose/fell" reads as one
 * coherent signal instead of two independent, desynced ones. */
function LiveUsd({
  value,
  label,
  scientific,
  direction: directionOverride,
}: {
  value: number | null;
  label: string;
  scientific?: boolean;
  direction?: TickDirection;
}) {
  const ownDirection = useTickDirection(value);
  const direction = directionOverride ?? ownDirection;
  if (value == null) return <span className="text-foreground/40">{"—"}</span>;
  return (
    <span className={`font-mono tabular-nums transition-colors duration-300 ${TICK_CLASS[direction]}`} title={label}>
      {scientific ? formatPlankUsdPrice(value) : formatUsd(value)}
    </span>
  );
}

/** Real ETH-equivalent value -- see LiveUsd's own header on why this
 * shares one direction signal with the USD figure beside it rather than
 * ticking off its own (nearly-constant) value independently. */
function LiveEth({
  value,
  label,
  direction: directionOverride,
}: {
  value: number | null;
  label: string;
  direction?: TickDirection;
}) {
  const ownDirection = useTickDirection(value);
  const direction = directionOverride ?? ownDirection;
  if (value == null) return <span className="text-foreground/40">{"—"}</span>;
  return (
    <span className={`font-mono tabular-nums transition-colors duration-300 ${TICK_CLASS[direction]}`} title={label}>
      ≈ {formatEthFixed(value, 3)} ETH
    </span>
  );
}

/** PLANK amounts on this dashboard range from a few tokens to trillions
 * (the prize alone is ~6.17T) -- always show the abbreviated K/M/B/T form
 * as the headline, with the real comma-grouped full number as a hover
 * tooltip so precision is never actually lost, just not force-fit into the
 * main line. */
function PlankAmount({ raw, className }: { raw: string; className?: string }) {
  const { abbreviated, full } = formatPlankAmount(raw);
  return (
    <span className={className} title={`${full} PLANK`}>
      {abbreviated}
    </span>
  );
}

function BuyTxLink({ buy }: { buy: PlankKothBuy }) {
  return (
    <a
      href={explorerTxUrl(buy.txHash)}
      target="_blank"
      rel="noreferrer noopener"
      className="font-mono text-[0.68rem] text-gold-300 underline decoration-dotted underline-offset-2 hover:text-gold-200"
      title="Inspect this transaction on the block explorer"
    >
      {shortAddress(buy.txHash)}
    </a>
  );
}

function WalletLink({ wallet }: { wallet: string | null }) {
  if (!wallet) return <span className="text-foreground/40">{"—"}</span>;
  return (
    <a
      href={explorerAddressUrl(wallet)}
      target="_blank"
      rel="noreferrer noopener"
      className="font-mono text-[0.7rem] text-foreground/75 underline decoration-dotted underline-offset-2 hover:text-foreground"
    >
      {shortAddress(wallet)}
    </a>
  );
}

/**
 * Season 2 $PLANK King of the Hill — live competition dashboard.
 *
 * Real, server-authoritative state from /api/market/plank-koth (lib/market/
 * plank-koth.ts, reusing king-of-the-hill-rules.ts's unmodified extend-on-
 * new-record engine) laid out per the operator's own spec: the current
 * leading buy (ETH amount + USD value), the prize (PLANK amount + live USD
 * value), a live ETH/USD + PLANK/USD tick strip with green/red/flat
 * coloring (see useLiveEthUsd.ts + useTickDirection.ts for the real,
 * honest data sources behind that), the "tower of top buys" leaderboard,
 * and a direct block-explorer link on every transaction.
 */
export default function PlankKothBoard() {
  const state = usePlankKoth();
  const { price: ethUsd, live: ethLive } = useLiveEthUsd();
  // Shared tick direction for the prize's USD + ETH figures -- see
  // LiveUsd's own header on why both must move together off the one real
  // cause (the ETH/USD rate) rather than each ticking independently.
  const prizeValueDirection = useTickDirection(ethUsd || null);
  const plankUsd = state?.plankUsd ?? null;
  const [remaining, setRemaining] = useState<Remaining | null>(null);
  const [localLaunched, setLocalLaunched] = useState(false);

  const launchAt = state?.launchAt ? Date.parse(state.launchAt) : null;
  const deadline = state?.deadline ? Date.parse(state.deadline) : null;
  const launched = (state?.launched ?? false) || localLaunched;
  const target = launched ? deadline : launchAt;

  useEffect(() => {
    if (target == null) return;
    const update = () => {
      const r = getRemaining(target);
      setRemaining(r);
      if (!launched && r.complete) setLocalLaunched(true);
    };
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [target, launched]);

  const displayLeader = state?.finalized ? state.winner : state?.leadingBuy;
  const leaderboard: PlankKothLeaderboardRow[] = useMemo(() => state?.leaderboard ?? [], [state?.leaderboard]);
  const fallenChampions = useMemo(() => state?.fallenChampions ?? [], [state?.fallenChampions]);
  // Real ETH-equivalent of the live prize -- derived from the same real
  // USD value the server already computed (prize.usdValue) divided by the
  // live ETH/USD tick, not a second independent source, so it can never
  // disagree with the USD figure shown right next to it.
  // Real, stable ETH amount from the pool's own ETH-denominated price
  // ratio (server-computed, see the API route's own comment) -- and the
  // USD figure DERIVED from that real ETH amount times the live WebSocket
  // ETH/USD tick, not the other way around. GeckoTerminal's own USD price
  // for a token whose only real market is an ETH-paired pool is itself
  // built from priceEth * ethUsd, so this is the true anchor, and it makes
  // both figures genuinely move together with the same live feed instead
  // of the USD number sitting frozen at the last ~60s-cached poll.
  const prizeEth = state?.prize?.plankEth ?? null;
  const prizeUsdLive = prizeEth != null && ethUsd > 0 ? prizeEth * ethUsd : (state?.prize?.usdValue ?? null);

  if (!state?.available || target == null) return null;

  const isLive = launched && !state.finalized;
  const inFinalStretch = isLive && remaining != null && remaining.days === 0 && remaining.hours < 2;

  return (
    <div
      className={[
        "flex flex-col gap-4 overflow-hidden rounded-2xl border p-4 sm:p-6 lg:gap-5 lg:p-8",
        inFinalStretch
          ? "border-red-500/60 bg-[linear-gradient(160deg,rgba(127,29,29,0.25),theme(colors.panel))] shadow-[0_0_40px_-12px_rgba(248,113,113,0.4)]"
          : "border-gold-500/40 bg-[linear-gradient(160deg,rgba(180,140,40,0.14),theme(colors.panel))]",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-gold-300">
            {isLive && (
              <span className="relative flex h-2 w-2" aria-hidden>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
            )}
            Season 2 {isLive && <span className="text-emerald-400">· LIVE</span>}
          </p>
          <h2 className="mt-1 font-display text-2xl font-bold text-foreground sm:text-3xl">
            Biggest Buyer Board
          </h2>
        </div>
        <div className="text-right leading-tight" role="timer" aria-live="off">
          <p className="text-[0.62rem] font-bold uppercase tracking-wider text-foreground/45">
            {state.finalized ? "Winner locked in" : launched ? "Competition closes in" : "Launches in"}
          </p>
          <p
            className={[
              "font-mono text-2xl font-bold tabular-nums sm:text-3xl",
              inFinalStretch ? "text-red-400" : "text-foreground",
            ].join(" ")}
          >
            {pad(remaining?.days)}d {pad(remaining?.hours)}h {pad(remaining?.minutes)}m {pad(remaining?.seconds)}s
          </p>
          {inFinalStretch && (
            <p className="mt-0.5 text-[0.65rem] font-bold text-red-400">
              ⚠ Final stretch — any new record buy extends the clock 4h
            </p>
          )}
          {/* Pre-season reference only -- see migration 079's own header.
              Never shown once the real competition is live; a pre-launch
              buy was never a real contest entry, this is purely "here's
              proof the methodology holds up against real history." */}
          {!launched && state?.preSeasonRecord && (
            <p className="mt-1 text-[0.62rem] text-foreground/40">
              Pre-season record:{" "}
              <PlankAmount raw={state.preSeasonRecord.plankAmount} className="text-foreground/55" /> PLANK
              {state.preSeasonRecord.usdValueAtBuy != null && ` (${formatUsd(state.preSeasonRecord.usdValueAtBuy)})`}
            </p>
          )}
        </div>
      </div>

      {/* Live price tick strip */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-line-strong bg-wood-900/50 px-4 py-2.5 text-sm">
        <span className="flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${ethLive ? "bg-emerald-400 shadow-[0_0_8px_2px_rgba(52,211,153,0.6)]" : "bg-foreground/30"}`} aria-hidden />
          <span className="text-foreground/55">ETH/USD</span>
          <LiveUsd value={ethUsd || null} label="Live ETH/USD, Coinbase ticker feed" />
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-gold-400/70" aria-hidden />
          <span className="text-foreground/55">$PLANK/USD</span>
          <LiveUsd value={plankUsd} label="Live $PLANK/USD from the canonical pool" scientific />
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:gap-5">
        {/* Current leading buy — the hero element */}
        <div className="relative overflow-hidden rounded-xl border border-gold-500/50 bg-[linear-gradient(150deg,rgba(180,140,40,0.18),rgba(0,0,0,0.15))] p-4 lg:p-6">
          <p className="flex items-center gap-1.5 text-[0.68rem] font-bold uppercase tracking-wider text-gold-300">
            <span aria-hidden>👑</span> {state.finalized ? "Winning buy" : "Current leading buy"}
          </p>
          {displayLeader ? (
            <div className="mt-2 flex flex-col gap-1">
              <p className="font-display text-2xl font-bold text-gold-300">
                <PlankAmount raw={displayLeader.plankAmount} /> PLANK
              </p>
              <p className="text-base text-foreground/85">
                {Number(displayLeader.ethPaidWei) > 0 ? (
                  <>
                    {formatTokenAmount(displayLeader.ethPaidWei, 18, 4)} ETH
                    {displayLeader.usdValueAtBuy != null && (
                      <span className="ml-1.5 text-foreground/55">{formatUsd(displayLeader.usdValueAtBuy)}</span>
                    )}
                  </>
                ) : (
                  displayLeader.usdValueAtBuy != null && (
                    <span>Paid in USDG · {formatUsd(displayLeader.usdValueAtBuy)}</span>
                  )
                )}
              </p>
              <p className="flex items-center gap-2 text-[0.7rem] text-foreground/60">
                <WalletLink wallet={displayLeader.wallet} />
                <BuyTxLink buy={displayLeader} />
              </p>
            </div>
          ) : (
            <p className="mt-2 text-sm text-foreground/50">
              {launched
                ? "No qualifying buy yet — be the first."
                : "Buys don't count until the event goes live — the timer above shows launch."}
            </p>
          )}
        </div>

        {/* Prize */}
        <div className="rounded-xl border border-line-strong bg-wood-900/30 p-4 lg:p-6">
          <p className="flex items-center gap-1.5 text-[0.68rem] font-bold uppercase tracking-wider text-foreground/45">
            <span aria-hidden>🏆</span> Prize ·{" "}
            {state.prize ? `${(state.prize.supplyFraction * 100).toFixed(5)}%` : ""} of total supply
          </p>
          {state.prize?.plankAmount ? (
            <div className="mt-2 flex flex-col gap-1">
              <p className="font-display text-2xl font-bold text-gold-300">
                <PlankAmount raw={state.prize.plankAmount} /> PLANK
              </p>
              <p className="flex flex-wrap items-baseline gap-x-1.5 text-base">
                <LiveUsd
                  value={prizeUsdLive}
                  label="Live prize USD value, tracks the ETH/USD ticker"
                  direction={prizeValueDirection}
                />
                <LiveEth
                  value={prizeEth}
                  label="Real ETH-equivalent value of the prize"
                  direction={prizeValueDirection}
                />
              </p>
            </div>
          ) : (
            <p className="mt-2 text-sm text-foreground/50">Prize value unavailable right now.</p>
          )}
        </div>
      </div>

      {/* Board of biggest buys */}
      <div>
        <p className="mb-1.5 flex items-center gap-1.5 text-[0.68rem] font-bold uppercase tracking-wider text-foreground/45">
          <span aria-hidden>🗼</span> Board of biggest buys
        </p>
        {leaderboard.length === 0 ? (
          <p className="rounded-lg border border-line-strong bg-wood-900/20 p-4 text-center text-sm text-foreground/50">
            {launched ? "No confirmed buys yet." : "Buys don't count until the event goes live."}
          </p>
        ) : (
          // Real fix, 2026-08-26 ("space optimal... always see the full
          // information of all modules at a glance"): an unbounded row
          // count used to grow this table (and the whole page) taller as
          // more real buys confirmed, eventually pushing "fallen
          // champions" and other modules below the fold entirely. A fixed
          // max-height with its OWN scroll (not the page's) keeps every
          // module visible together on both desktop and mobile; the
          // sticky header keeps column labels visible while scrolling
          // through a long list instead of scrolling them out of view.
          <div className="max-h-[22rem] overflow-y-auto overflow-x-auto rounded-lg border border-line-strong sm:max-h-[26rem]">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 z-10 bg-wood-900 text-[0.62rem] uppercase tracking-wider text-foreground/45 shadow-[0_1px_0_0_theme(colors.line.strong)]">
                <tr>
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">Buyer</th>
                  <th className="px-3 py-2">$PLANK</th>
                  <th className="px-3 py-2">Value</th>
                  <th className="px-3 py-2">Tx</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((row, i) => {
                  const rankStyle =
                    i === 0
                      ? "border-t border-gold-500/50 bg-gold-500/10"
                      : i === 1
                        ? "border-t border-line/60 bg-foreground/[0.04]"
                        : i === 2
                          ? "border-t border-line/60 bg-orange-900/10"
                          : "border-t border-line/60";
                  const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : null;
                  return (
                    <tr key={row.txHash} className={rankStyle}>
                      <td className="px-3 py-2 font-mono text-foreground/70">{medal ?? i + 1}</td>
                      <td className="px-3 py-2">
                        <WalletLink wallet={row.wallet} />
                      </td>
                      <td className={`px-3 py-2 font-mono tabular-nums ${i === 0 ? "font-bold text-gold-300" : "text-foreground/85"}`}>
                        <PlankAmount raw={row.plankAmount} />
                      </td>
                      <td className={`px-3 py-2 font-mono tabular-nums ${i === 0 ? "font-bold text-gold-300" : "text-gold-300/85"}`}>
                        {row.usdValueAtBuy != null ? formatUsd(row.usdValueAtBuy) : "—"}
                      </td>
                      <td className="px-3 py-2">
                        <BuyTxLink buy={row} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Fallen champions -- every wallet that WAS #1 before being
          dethroned by a bigger real buy (plank_koth_champion_history,
          migration 078). Reign duration is real wall-clock time between
          became_champion_at and dethroned_at, never estimated. */}
      {fallenChampions.length > 0 && (
        <div>
          <p className="mb-1.5 flex items-center gap-1.5 text-[0.68rem] font-bold uppercase tracking-wider text-foreground/45">
            <span aria-hidden>⚔️</span> Fallen champions
          </p>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {fallenChampions.map((c) => (
              <div
                key={c.txHash}
                className="flex w-48 shrink-0 flex-col gap-1 rounded-lg border border-line-strong bg-wood-900/30 p-3 opacity-80 grayscale-[0.3] transition-opacity hover:opacity-100 hover:grayscale-0"
              >
                <p className="text-[0.6rem] font-bold uppercase tracking-wider text-foreground/40">
                  Reigned {formatReignDuration(c.becameChampionAt, c.dethronedAt)}
                </p>
                <p className="font-mono text-sm font-bold text-foreground/70 line-through decoration-red-500/60">
                  <PlankAmount raw={c.plankAmount} /> PLANK
                </p>
                <p className="text-[0.68rem] text-foreground/50">
                  {c.usdValueAtBuy != null ? formatUsd(c.usdValueAtBuy) : "—"}
                </p>
                <WalletLink wallet={c.wallet} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
