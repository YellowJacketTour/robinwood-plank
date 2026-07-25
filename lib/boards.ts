import {
  RULES_RELAXED,
  SNIPER_TRAP_MINUTES,
  TRADE_OPENS_AT_ISO,
  TRADE_PAUSED,
} from "@/lib/constants";
import { getTradeOpensAt } from "@/lib/trade";
import type { BoardsPublicView } from "@/lib/boards-types";

/** Re-export for UI/API consumers. */
export { SNIPER_TRAP_MINUTES };

/** Per-wallet on-chain-style cooldown window (ms). */
export const WALLET_COOLDOWN_MINUTES = 30;
export const WALLET_COOLDOWN_MS = WALLET_COOLDOWN_MINUTES * 60 * 1000;

/** LP may be live this long before the community timer (sniper / death trap bait). */
export const DEATH_TRAP_BEFORE_OPEN_MS = SNIPER_TRAP_MINUTES * 60 * 1000;

/** After community open, cooldowns stay on this long so ops can list snipers. */
export const DEATH_TRAP_AFTER_OPEN_MS = WALLET_COOLDOWN_MS;

export function normalizeAddress(addr: string): string {
  return addr.trim().toLowerCase();
}

export function isAddressLike(addr: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(addr.trim());
}

export type TrapWindow = {
  tradeOpensAt: Date;
  trapStartsAt: Date;
  cooldownsEndAt: Date;
  now: Date;
  active: boolean;
  phase: BoardsPublicView["trap"]["phase"];
  rulesRelaxed: boolean;
};

/**
 * Death trap / control window:
 *  [opens − 30m]  LP bait / snipers
 *  [opens]        community widget unlock
 *  [opens + 30m]  per-wallet cooldowns end → free (unless RULES_RELAXED earlier)
 */
export function getTrapWindow(nowMs: number = Date.now()): TrapWindow {
  const tradeOpensAt = getTradeOpensAt();
  const trapStartsAt = new Date(tradeOpensAt.getTime() - DEATH_TRAP_BEFORE_OPEN_MS);
  const cooldownsEndAt = new Date(tradeOpensAt.getTime() + DEATH_TRAP_AFTER_OPEN_MS);
  const now = new Date(nowMs);
  const rulesRelaxed = RULES_RELAXED;

  let phase: TrapWindow["phase"] = "free";
  if (rulesRelaxed || nowMs >= cooldownsEndAt.getTime()) {
    phase = "free";
  } else if (nowMs < trapStartsAt.getTime()) {
    phase = "pre_lp";
  } else if (nowMs < tradeOpensAt.getTime()) {
    phase = "death_trap";
  } else {
    phase = "cooldown_window";
  }

  const active = !rulesRelaxed && phase !== "free" && phase !== "pre_lp";

  return {
    tradeOpensAt,
    trapStartsAt,
    cooldownsEndAt,
    now,
    active: active || phase === "death_trap" || phase === "cooldown_window",
    phase,
    rulesRelaxed,
  };
}

/**
 * True for the full ops window: death trap + post-open cooldown display.
 * Used for cooldowns / Bad Boards *blocking* on quote·swap — not for new chain flags.
 */
export function isListingWindowActive(nowMs: number = Date.now()): boolean {
  const w = getTrapWindow(nowMs);
  if (w.rulesRelaxed) return false;
  return (
    nowMs >= w.trapStartsAt.getTime() && nowMs < w.cooldownsEndAt.getTime()
  );
}

/**
 * True only while the official widget is still locked (LP bait / sniper trap).
 * All PLANK movers in this phase are off-site (widget cannot buy yet).
 */
export function isSniperCaptureActive(nowMs: number = Date.now()): boolean {
  // Stand-by / trade paused: do not auto-blacklist community while trading is offline
  if (TRADE_PAUSED) return false;
  const w = getTrapWindow(nowMs);
  if (w.rulesRelaxed) return false;
  return w.phase === "death_trap";
}

/**
 * True while we still flag off-site / Uniswap-UI buyers:
 *  - death_trap: widget locked → every chain buy is off-site
 *  - cooldown_window: widget open → only wallets WITHOUT a plank.love
 *    quote/swap session are Bad Boards (Uni app / other UIs)
 *
 * Official plank.love widget buyers are never listed (server records sessions).
 * While TRADE_PAUSED, capture is off so stand-by community is not blacklisted.
 */
export function isOffWidgetCaptureActive(nowMs: number = Date.now()): boolean {
  if (TRADE_PAUSED) return false;
  const w = getTrapWindow(nowMs);
  if (w.rulesRelaxed) return false;
  return w.phase === "death_trap" || w.phase === "cooldown_window";
}

/** Community widget unlocked (and not free yet). */
export function isOfficialWidgetOpen(nowMs: number = Date.now()): boolean {
  const w = getTrapWindow(nowMs);
  if (w.rulesRelaxed) return true;
  return nowMs >= w.tradeOpensAt.getTime();
}

export function cooldownEndsAt(startedAtMs: number): number {
  return startedAtMs + WALLET_COOLDOWN_MS;
}

export function tradeOpensAtIso(): string {
  return TRADE_OPENS_AT_ISO;
}
