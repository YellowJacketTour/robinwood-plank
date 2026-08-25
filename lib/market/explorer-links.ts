/**
 * Shared block-explorer link builder. Before this, `components/market/
 * ActivityFeed.tsx` held its own local `EXPLORER_TX` constant duplicating
 * `CHAIN.blockExplorers.default.url` (lib/constants.ts) — fine for one
 * caller, but the KOTH leaderboard/review-queue UI needs the same tx-link
 * and address-link shapes, so this extracts it once rather than
 * re-duplicating the string a third time.
 */
import { CHAIN } from "@/lib/constants";

const EXPLORER_BASE = CHAIN.blockExplorers.default.url;

export function explorerTxUrl(txHash: string): string {
  return `${EXPLORER_BASE}/tx/${txHash}`;
}

export function explorerAddressUrl(address: string): string {
  return `${EXPLORER_BASE}/address/${address}`;
}
