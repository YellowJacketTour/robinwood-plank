/**
 * Historical NAV-per-share lookup for deposit/redeem valuation, plus the
 * cron-side snapshot writer that feeds it. See
 * lib/market/portfolio-flow-mapper.ts's "Historical NAV" doc comment for the
 * full tradeoff writeup — this file is the concrete fallback chain it
 * describes:
 *   1. Exact historical eth_call at the event's block (best case).
 *   2. Nearest stored snapshot at or before the event's block.
 *   3. Current NAV (last resort).
 */

import { navPerShareWei } from "@/lib/market/portfolio-pnl";
import { postgresQuery, hasPostgresConfig } from "@/lib/postgres";
import { rpcCall } from "@/lib/market/fetch-rpc";
import { SERVER_DISPLAY_RPC_URLS } from "@/lib/server/rpc-urls";
import vaultAbi from "@/lib/market/vault-abi.json";
import { Interface } from "ethers";

const IFACE = new Interface(vaultAbi);
const ZERO = BigInt(0);

/**
 * Direct eth_call for ethReserve()/totalSupply() at a given blockTag,
 * deliberately NOT going through lib/market/vault.ts's getVaultOnChainSnapshot
 * — that reader resolves READ_RPC_URL ("/api/rpc", a same-origin Next.js
 * proxy path) against `window.location.origin` in the browser, or
 * "http://localhost:3000" as a server-side guess when no window exists.
 * The latter is wrong for this module's real callers (the standalone
 * `tsx scripts/refresh-market-data.ts` cron process, no Next server
 * necessarily running on that host/port) — so, like the rest of this file's
 * neighbors (vault-activity.ts, sales-catalog.ts), this goes straight to
 * lib/market/fetch-rpc.ts's rpcCall against the real chain RPC URLs.
 */
async function navAtBlockTag(vaultAddress: string, blockTag: string): Promise<bigint | null> {
  try {
    const [ethReserveHex, totalSupplyHex] = await Promise.all([
      rpcCall<string>(
        "eth_call",
        [{ to: vaultAddress, data: IFACE.encodeFunctionData("ethReserve") }, blockTag],
        { urls: SERVER_DISPLAY_RPC_URLS, timeoutMs: 6_000 }
      ),
      rpcCall<string>(
        "eth_call",
        [{ to: vaultAddress, data: IFACE.encodeFunctionData("totalSupply") }, blockTag],
        { urls: SERVER_DISPLAY_RPC_URLS, timeoutMs: 6_000 }
      ),
    ]);
    if (!ethReserveHex || ethReserveHex === "0x" || !totalSupplyHex || totalSupplyHex === "0x") {
      return null;
    }
    const ethReserve = BigInt(ethReserveHex);
    const totalSupply = BigInt(totalSupplyHex);
    if (totalSupply <= ZERO) return null;
    return navPerShareWei(ethReserve, totalSupply);
  } catch {
    return null;
  }
}

/** Best-effort historical eth_call at the event's exact block. Returns null
 * on any failure (pruned node, RPC error, etc.) rather than throwing —
 * callers fall through to the next tier. */
async function historicalNavAtBlock(
  vaultAddress: string,
  blockNumber: number
): Promise<bigint | null> {
  return navAtBlockTag(vaultAddress, "0x" + blockNumber.toString(16));
}

/** Nearest stored snapshot at or before `blockNumber` for this vault, or
 * null when Postgres is unconfigured or nothing has been recorded yet. */
async function nearestStoredSnapshot(
  vaultAddress: string,
  blockNumber: number
): Promise<bigint | null> {
  if (!hasPostgresConfig()) return null;
  try {
    const result = await postgresQuery<{ nav_per_share_wei: string }>(
      `SELECT nav_per_share_wei FROM vault_nav_snapshots
       WHERE vault_address = $1 AND block_number <= $2
       ORDER BY block_number DESC
       LIMIT 1`,
      [vaultAddress.toLowerCase(), blockNumber]
    );
    const row = result.rows[0];
    if (!row) return null;
    return BigInt(row.nav_per_share_wei);
  } catch {
    return null;
  }
}

/** Current on-chain NAV — the final, least-accurate fallback. Never throws;
 * an unreadable vault (bad address, RPC fully down) resolves to 0, which
 * portfolio-pnl.ts's math treats as a flat/zero-value position rather than
 * crashing the caller. */
async function currentNav(vaultAddress: string): Promise<bigint> {
  const nav = await navAtBlockTag(vaultAddress, "latest");
  return nav ?? ZERO;
}

/** Public alias — the current-NAV mark-to-market read used by the API route
 * to value a stored position "right now," independent of the historical
 * fallback chain above. Same direct-RPC path as the rest of this file (see
 * navAtBlockTag's doc comment for why lib/market/vault.ts's reader is not
 * used here). Returns 0 (never throws) if the vault is unreadable. */
export async function currentNavPerShareWei(vaultAddress: string): Promise<bigint> {
  return currentNav(vaultAddress);
}

/**
 * The real NavAtBlockResolver (lib/market/portfolio-flow-mapper.ts) used by
 * the refresh script and API route. Tries each tier in order, returns the
 * first that succeeds.
 */
export async function resolveNavAtBlock(
  vaultAddress: string,
  blockNumber: number
): Promise<bigint> {
  const exact = await historicalNavAtBlock(vaultAddress, blockNumber);
  if (exact !== null && exact > ZERO) return exact;

  const stored = await nearestStoredSnapshot(vaultAddress, blockNumber);
  if (stored !== null && stored > ZERO) return stored;

  return currentNav(vaultAddress);
}

/**
 * Record the vault's CURRENT nav as a snapshot row — called once per vault
 * per refresh-market-data run (see that script's "portfolio-nav" step).
 * This is what builds up tier-2 fallback coverage over time; there is no
 * backfill for history before this shipped.
 */
export async function recordCurrentNavSnapshot(vaultAddress: string): Promise<{
  blockNumber: number;
  navPerShareWei: bigint;
} | null> {
  if (!hasPostgresConfig()) return null;
  const [ethReserveHex, totalSupplyHex, blockNumber] = await Promise.all([
    rpcCall<string>(
      "eth_call",
      [{ to: vaultAddress, data: IFACE.encodeFunctionData("ethReserve") }, "latest"],
      { urls: SERVER_DISPLAY_RPC_URLS, timeoutMs: 8_000 }
    ),
    rpcCall<string>(
      "eth_call",
      [{ to: vaultAddress, data: IFACE.encodeFunctionData("totalSupply") }, "latest"],
      { urls: SERVER_DISPLAY_RPC_URLS, timeoutMs: 8_000 }
    ),
    currentBlockNumber(),
  ]);
  const ethReserve = ethReserveHex && ethReserveHex !== "0x" ? BigInt(ethReserveHex) : ZERO;
  const totalSupply = totalSupplyHex && totalSupplyHex !== "0x" ? BigInt(totalSupplyHex) : ZERO;
  const nav = navPerShareWei(ethReserve, totalSupply);
  await postgresQuery(
    `INSERT INTO vault_nav_snapshots (vault_address, block_number, nav_per_share_wei, eth_reserve_wei, total_supply_wei, recorded_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (vault_address, block_number) DO NOTHING`,
    [vaultAddress.toLowerCase(), blockNumber, nav.toString(), ethReserve.toString(), totalSupply.toString()]
  );
  return { blockNumber, navPerShareWei: nav };
}

async function currentBlockNumber(): Promise<number> {
  const hex = await rpcCall<string>("eth_blockNumber", [], { urls: SERVER_DISPLAY_RPC_URLS });
  return Number(BigInt(hex));
}
