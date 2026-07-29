/**
 * Server-side random-redeem finisher (gas paid by RELAYER_PRIVATE_KEY only).
 *
 * Design goals:
 *  - Users never need a second wallet tx to free the vault slot (request is theirs;
 *    relay + claimFor run here).
 *  - Operators do not click "Settle" — cron + post-request hooks call this.
 *  - Spend gas ONLY when a vault actually has a pendingRequester (idle ticks
 *    are free RPC reads).
 *
 * This cannot change draw outcomes: submitRound verifies BLS on-chain;
 * claimRandomRedeemFor only delivers the already-pinned NFT to the requester.
 */

import { Contract, JsonRpcProvider, Wallet, ZeroAddress } from "ethers";
import {
  DRAND_BEACON_ADDRESS,
  MARKET_VAULT_ADDRESSES,
  MARKET_VAULT_ADDRESS,
} from "@/lib/constants";
import { DRAND_CHAIN_HASH } from "@/lib/market/drand";

const BEACON_ABI = [
  "function submitRound(uint64 round, uint256[2] signature)",
  "function isRoundAvailable(uint64 round) view returns (bool)",
];

const VAULT_ABI = [
  "function pendingRequester() view returns (address)",
  "function pendingRound() view returns (uint64 round, bool available)",
  "function pinPendingDraw()",
  "function claimRandomRedeemFor(address requester) returns (uint256 tokenId)",
  "function forfeitExpiredRedeem(address requester)",
];

const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
const DRAND_API = "https://api.drand.sh";

export type SettleVaultResult = {
  vault: string;
  status:
    | "idle"
    | "relayed"
    | "settled"
    | "forfeited"
    | "waiting_round"
    | "no_key"
    | "error";
  requester?: string;
  round?: string;
  txHash?: string;
  detail?: string;
};

export type SettleReport = {
  at: string;
  relayer: string | null;
  results: SettleVaultResult[];
  spentGas: boolean;
};

function parseG1(hex: string): [bigint, bigint] {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length !== 128) {
    throw new Error(`Bad drand signature length ${h.length}`);
  }
  return [BigInt("0x" + h.slice(0, 64)), BigInt("0x" + h.slice(64))];
}

async function fetchDrandRound(round: string | number): Promise<{ round: number; signature: string }> {
  const url = `${DRAND_API}/${DRAND_CHAIN_HASH}/public/${round}`;
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`drand round ${round} not published yet (${res.status})`);
  return (await res.json()) as { round: number; signature: string };
}

function vaultList(filter?: string | null): string[] {
  if (filter && /^0x[a-fA-F0-9]{40}$/.test(filter)) {
    const hit = MARKET_VAULT_ADDRESSES.find((a) => a.toLowerCase() === filter.toLowerCase());
    if (hit) return [hit];
  }
  if (MARKET_VAULT_ADDRESSES.length > 0) return [...MARKET_VAULT_ADDRESSES];
  return MARKET_VAULT_ADDRESS ? [MARKET_VAULT_ADDRESS] : [];
}

/**
 * If RELAYER_PRIVATE_KEY is unset, returns idle results (no throw) so the
 * site still works without a sponsor wallet — UI falls back to user gas.
 */
export async function settleRandomRedeems(opts?: {
  /** Only this vault (optional). */
  vault?: string | null;
  /** Prefer settling this requester if they hold the slot. */
  forRequester?: string | null;
}): Promise<SettleReport> {
  const key = process.env.RELAYER_PRIVATE_KEY?.trim();
  const rpc = process.env.RPC_URL?.trim() || DEFAULT_RPC;
  const beaconAddr = process.env.BEACON_ADDRESS?.trim() || DRAND_BEACON_ADDRESS;
  const vaults = vaultList(opts?.vault ?? null);

  if (!key) {
    return {
      at: new Date().toISOString(),
      relayer: null,
      spentGas: false,
      results: vaults.map((v) => ({
        vault: v,
        status: "no_key" as const,
        detail: "RELAYER_PRIVATE_KEY not configured",
      })),
    };
  }

  const provider = new JsonRpcProvider(rpc);
  const wallet = new Wallet(key, provider);
  const beacon = new Contract(beaconAddr, BEACON_ABI, wallet);
  const results: SettleVaultResult[] = [];
  let spentGas = false;

  for (const vaultAddr of vaults) {
    const vault = new Contract(vaultAddr, VAULT_ABI, wallet);
    try {
      const requester = (await vault.pendingRequester()) as string;
      if (!requester || requester.toLowerCase() === ZeroAddress.toLowerCase()) {
        results.push({ vault: vaultAddr, status: "idle" });
        continue;
      }

      if (
        opts?.forRequester &&
        requester.toLowerCase() !== opts.forRequester.toLowerCase()
      ) {
        // Another wallet holds the slot — still settle them so the vault unclogs.
      }

      const pend = (await vault.pendingRound()) as
        | { round: bigint; available: boolean }
        | [bigint, boolean];
      const round = Array.isArray(pend) ? pend[0] : pend.round;
      let available = Array.isArray(pend) ? pend[1] : pend.available;

      // Relay only the vault's target round — never burn gas pushing "latest"
      // when nothing is waiting (idle path already returned above).
      if (round > BigInt(0) && !available) {
        try {
          const data = await fetchDrandRound(round.toString());
          if (!(await beacon.isRoundAvailable(data.round))) {
            const sig = parseG1(data.signature);
            const tx = await beacon.submitRound(data.round, sig);
            spentGas = true;
            await tx.wait();
            results.push({
              vault: vaultAddr,
              status: "relayed",
              requester,
              round: round.toString(),
              txHash: tx.hash,
            });
          }
          available = Boolean(await beacon.isRoundAvailable(round));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/not published|isn't published/i.test(msg)) {
            results.push({
              vault: vaultAddr,
              status: "waiting_round",
              requester,
              round: round.toString(),
              detail: msg,
            });
            continue;
          }
          results.push({
            vault: vaultAddr,
            status: "error",
            requester,
            round: round.toString(),
            detail: msg.slice(0, 200),
          });
          continue;
        }
      }

      try {
        try {
          const pinTx = await vault.pinPendingDraw();
          spentGas = true;
          await pinTx.wait();
        } catch {
          /* already pinned or round not ready */
        }

        const claimTx = await vault.claimRandomRedeemFor(requester);
        spentGas = true;
        const rc = await claimTx.wait();
        results.push({
          vault: vaultAddr,
          status: "settled",
          requester,
          round: round.toString(),
          txHash: claimTx.hash,
          detail: `block ${rc?.blockNumber ?? "?"}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Try forfeit only if claim failed (likely unpinned + expired).
        try {
          const forfeitTx = await vault.forfeitExpiredRedeem(requester);
          spentGas = true;
          await forfeitTx.wait();
          results.push({
            vault: vaultAddr,
            status: "forfeited",
            requester,
            round: round.toString(),
            txHash: forfeitTx.hash,
            detail: msg.slice(0, 120),
          });
        } catch {
          results.push({
            vault: vaultAddr,
            status: available ? "error" : "waiting_round",
            requester,
            round: round.toString(),
            detail: msg.slice(0, 200),
          });
        }
      }
    } catch (err) {
      results.push({
        vault: vaultAddr,
        status: "error",
        detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
    }
  }

  return {
    at: new Date().toISOString(),
    relayer: wallet.address,
    spentGas,
    results,
  };
}
