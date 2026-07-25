import {
  RULES_RELAXED,
  SNIPER_TRAP_MINUTES,
  TRADE_OPENS_AT_ISO,
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

/** True while we still collect Bad Boards / enforce listing window. */
export function isListingWindowActive(nowMs: number = Date.now()): boolean {
  const w = getTrapWindow(nowMs);
  if (w.rulesRelaxed) return false;
  return (
    nowMs >= w.trapStartsAt.getTime() && nowMs < w.cooldownsEndAt.getTime()
  );
}

export function cooldownEndsAt(startedAtMs: number): number {
  return startedAtMs + WALLET_COOLDOWN_MS;
}

export function tradeOpensAtIso(): string {
  return TRADE_OPENS_AT_ISO;
}
