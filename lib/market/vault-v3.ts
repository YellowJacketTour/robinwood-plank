/**
 * V3 vault call layer. V3's on-chain shape differs from V1/V2 — ETH-denominated
 * fees (wei, not bps), an explicit shareReserve, proportional LP, and payable
 * deposit/redeem — so it gets its own reader/writer rather than retrofitting the
 * V2-shaped vault.ts. Writes go through the same allowlisted wallet path.
 */
import { Contract, Interface, JsonRpcProvider } from "ethers";
import v3Abi from "@/lib/market/vault-v3-abi.json";
import { CHAIN, MARKET_VAULT_ADDRESS, READ_RPC_URL } from "@/lib/constants";
import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import {
  ensureRobinhoodChain,
  getEthereumProvider,
  sendTransaction,
  waitForTransaction,
} from "@/lib/wallet";

const V3 = new Interface(v3Abi);
const ERC721 = new Interface([
  "function getApproved(uint256) view returns (address)",
  "function isApprovedForAll(address,address) view returns (bool)",
  "function approve(address,uint256)",
]);

export const SHARE_UNIT = BigInt("1000000000000000000");
const BPS = BigInt(10000);

function vaultOr(addr?: string | null): string {
  const a = addr ?? MARKET_VAULT_ADDRESS;
  if (!a) throw new Error("No V3 vault configured.");
  return a;
}

/** Resolve READ_RPC_URL to an absolute URL. A relative dev-proxy path ("/api/…")
 *  is resolved against the browser origin — reads only ever run client-side. */
function readUrl(): string {
  if (READ_RPC_URL.startsWith("/")) {
    const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
    return origin + READ_RPC_URL;
  }
  return READ_RPC_URL;
}

let cachedProvider: JsonRpcProvider | null = null;
function provider(): JsonRpcProvider {
  if (!cachedProvider) {
    cachedProvider = new JsonRpcProvider(readUrl(), { chainId: CHAIN.id, name: CHAIN.name });
  }
  return cachedProvider;
}

function reader(addr?: string | null): Contract {
  return new Contract(vaultOr(addr), v3Abi, provider());
}

export type V3Snapshot = {
  address: string;
  held: number;
  totalSupply: bigint;
  ethReserve: bigint;
  shareReserve: bigint;
  totalLpSupply: bigint;
  accruedFees: bigint;
  poolOpen: boolean;
  mintFeeWei: bigint;
  redeemFeeWei: bigint;
  targetPremiumWei: bigint;
  swapFeeBps: number;
  /** account-specific (0 when no account) */
  shareBalance: bigint;
  lpBalance: bigint;
};

export async function getV3Snapshot(addr?: string | null, account?: string | null): Promise<V3Snapshot> {
  const v = reader(addr);
  const [held, totalSupply, ethReserve, shareReserve, totalLpSupply, accruedFees, poolOpen, mintFeeWei, redeemFeeWei, targetPremiumWei, swapFeeBps] =
    (await Promise.all([
      v.heldTokenCount(),
      v.totalSupply(),
      v.ethReserve(),
      v.shareReserve(),
      v.totalLpSupply(),
      v.accruedFees(),
      v.poolOpen(),
      v.mintFeeWei(),
      v.redeemFeeWei(),
      v.targetPremiumWei(),
      v.swapFeeBps(),
    ])) as [bigint, bigint, bigint, bigint, bigint, bigint, boolean, bigint, bigint, bigint, bigint];

  let shareBalance = BigInt(0);
  let lpBalance = BigInt(0);
  if (account) {
    [shareBalance, lpBalance] = (await Promise.all([v.balanceOf(account), v.lpBalance(account)])) as [
      bigint,
      bigint,
    ];
  }

  return {
    address: vaultOr(addr),
    held: Number(held),
    totalSupply,
    ethReserve,
    shareReserve,
    totalLpSupply,
    accruedFees,
    poolOpen,
    mintFeeWei,
    redeemFeeWei,
    targetPremiumWei,
    swapFeeBps: Number(swapFeeBps),
    shareBalance,
    lpBalance,
  };
}

// ── Quotes (pure constant-product math with the swap fee) ──────────────────

export function quoteBuy(ethIn: bigint, s: V3Snapshot): bigint {
  if (s.shareReserve === BigInt(0) || s.ethReserve === BigInt(0)) return BigInt(0);
  const inNet = (ethIn * (BPS - BigInt(s.swapFeeBps))) / BPS;
  return (inNet * s.shareReserve) / (s.ethReserve + inNet);
}

export function quoteSell(sharesIn: bigint, s: V3Snapshot): bigint {
  if (s.shareReserve === BigInt(0) || s.ethReserve === BigInt(0)) return BigInt(0);
  const inNet = (sharesIn * (BPS - BigInt(s.swapFeeBps))) / BPS;
  return (inNet * s.ethReserve) / (s.shareReserve + inNet);
}

/** ETH-driven add: shares pulled to match, LP minted. Mirrors the contract. */
export function quoteAddLiquidity(ethIn: bigint, s: V3Snapshot): { sharesUsed: bigint; lpMinted: bigint } {
  if (s.ethReserve === BigInt(0) || s.totalLpSupply === BigInt(0)) {
    return { sharesUsed: BigInt(0), lpMinted: BigInt(0) };
  }
  const sharesUsed = (ethIn * s.shareReserve + s.ethReserve - BigInt(1)) / s.ethReserve; // ceilDiv
  const lpMinted = (ethIn * s.totalLpSupply) / s.ethReserve;
  return { sharesUsed, lpMinted };
}

export function quoteRemoveLiquidity(lpIn: bigint, s: V3Snapshot): { ethOut: bigint; sharesOut: bigint } {
  if (s.totalLpSupply === BigInt(0)) return { ethOut: BigInt(0), sharesOut: BigInt(0) };
  return {
    ethOut: (lpIn * s.ethReserve) / s.totalLpSupply,
    sharesOut: (lpIn * s.shareReserve) / s.totalLpSupply,
  };
}

const applySlip = (x: bigint, slipBps: number) => (x * BigInt(10000 - slipBps)) / BPS;

// ── Writes (allowlisted wallet path) ───────────────────────────────────────

async function send(account: string, data: string, valueWei?: bigint, addr?: string | null): Promise<string> {
  await ensureRobinhoodChain();
  const hash = await sendTransaction({
    to: vaultOr(addr),
    from: account,
    data,
    value: valueWei !== undefined ? valueWei.toString() : undefined,
    kind: "vault",
  });
  await waitForTransaction(hash, { label: "Vault transaction" });
  return hash;
}

export async function v3Buy(account: string, ethWei: bigint, s: V3Snapshot, slipBps = 100): Promise<string> {
  const minOut = applySlip(quoteBuy(ethWei, s), slipBps);
  return send(account, V3.encodeFunctionData("buyShares", [minOut]), ethWei);
}

export async function v3Sell(account: string, sharesWei: bigint, s: V3Snapshot, slipBps = 100): Promise<string> {
  const minEth = applySlip(quoteSell(sharesWei, s), slipBps);
  return send(account, V3.encodeFunctionData("sellShares", [sharesWei, minEth]));
}

export async function v3Deposit(account: string, tokenId: string, s: V3Snapshot, addr?: string | null): Promise<string> {
  const vaultAddr = vaultOr(addr);
  const nft = NFT_CONTRACT_ADDRESS;
  const injected = getEthereumProvider();
  if (!injected) throw new Error("No wallet found.");
  const [approvedHex, allHex] = (await Promise.all([
    injected.request({
      method: "eth_call",
      params: [{ to: nft, data: ERC721.encodeFunctionData("getApproved", [tokenId]) }, "latest"],
    }),
    injected.request({
      method: "eth_call",
      params: [{ to: nft, data: ERC721.encodeFunctionData("isApprovedForAll", [account, vaultAddr]) }, "latest"],
    }),
  ])) as [string, string];
  const approvedTo = `0x${(approvedHex || "0x").slice(-40)}`.toLowerCase();
  const hasApproval = approvedTo === vaultAddr.toLowerCase() || BigInt(allHex === "0x" ? 0 : allHex) !== BigInt(0);
  if (!hasApproval) {
    const h = await sendTransaction({
      to: nft,
      from: account,
      data: ERC721.encodeFunctionData("approve", [vaultAddr, tokenId]),
      kind: "vault",
    });
    await waitForTransaction(h, { label: "Deposit approval" });
  }
  return send(account, V3.encodeFunctionData("deposit", [tokenId]), s.mintFeeWei, addr);
}

export async function v3RedeemTarget(account: string, tokenId: string, s: V3Snapshot): Promise<string> {
  return send(account, V3.encodeFunctionData("redeemTarget", [tokenId]), s.redeemFeeWei + s.targetPremiumWei);
}

// ── Random redeem (two-step, commit-reveal via drand) ──────────────────────
// Step 1 burns one share now and pins a future drand round; step 2 claims the
// NFT once that round's randomness is on-chain. The claim is permissionless, so
// a relayer can finish for the user (no second wallet popup). See the contract
// header for the anti-sniping rationale.

export type V3Pending = { requester: string; round: bigint; available: boolean; isMe: boolean };
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/** The vault holds ONE redeem slot at a time; read who owns it and its round. */
export async function getV3Pending(addr?: string | null, account?: string | null): Promise<V3Pending> {
  const v = reader(addr);
  const requester = (await v.pendingRequester()) as string;
  if (requester === ZERO_ADDR) {
    return { requester, round: BigInt(0), available: false, isMe: false };
  }
  const [round, available] = (await v.pendingRound()) as [bigint, boolean];
  return {
    requester,
    round,
    available,
    isMe: Boolean(account) && requester.toLowerCase() === account!.toLowerCase(),
  };
}

/** Step 1: burn a share, request a random draw. Pays redeemFeeWei only. */
export async function v3RequestRandomRedeem(account: string, s: V3Snapshot): Promise<string> {
  return send(account, V3.encodeFunctionData("requestRandomRedeem", []), s.redeemFeeWei);
}

/** Step 2 (user-paid fallback): claim the NFT the request was pinned to. */
export async function v3ClaimRandomRedeem(account: string): Promise<string> {
  return send(account, V3.encodeFunctionData("claimRandomRedeem", []));
}

/**
 * Kick the dev relay to finish a pending random redeem without a second wallet
 * prompt: it injects the mock beacon's randomness for the pinned round and
 * claims on the requester's behalf. DEV-LOCAL ONLY — 404s in a real build.
 *
 * PRODUCTION (Phase B): this is where the gas-sponsored settle-random relayer
 * takes over, exactly as it does for V1/V2 — but the relayer's vault list must
 * include the V3 address first, or a random redeem would strand at step 2. Until
 * that wiring lands, the finish path below falls back to a user-paid claim.
 */
async function kickDevRelay(vaultAddr: string, requester: string): Promise<string | null> {
  try {
    const res = await fetch("/api/dev-relay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vault: vaultAddr, requester }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { status?: string };
    return data.status ?? null;
  } catch {
    return null;
  }
}

/**
 * One-shot random redeem: the user signs ONLY the request; the finish is
 * relayed. Falls back to a user-paid claim if no relayer is available. Resolves
 * when the NFT has been delivered and the slot is free.
 */
export async function v3RandomRedeem(
  account: string,
  s: V3Snapshot,
  addr?: string | null,
  onProgress?: (m: string) => void
): Promise<string> {
  const vaultAddr = vaultOr(addr);
  onProgress?.("Requesting random redeem (one signature)…");
  const requestHash = await v3RequestRandomRedeem(account, s);

  onProgress?.("Drawing your plank via drand…");
  const started = Date.now();
  // Give the relay a few rounds to inject randomness and claim for us.
  while (Date.now() - started < 60_000) {
    const relayStatus = await kickDevRelay(vaultAddr, account);
    const pend = await getV3Pending(addr, account);
    if (!pend.isMe) {
      // Slot cleared for us → the NFT was delivered.
      onProgress?.("Redeem complete — plank delivered.");
      return requestHash;
    }
    if (relayStatus === "no_relay") break; // no sponsor here — user finishes
    await new Promise((r) => setTimeout(r, 2_000));
  }

  // Fallback: user pays for the claim themselves (needs the round on-chain).
  onProgress?.("Finishing with your wallet…");
  await v3ClaimRandomRedeem(account);
  onProgress?.("Redeem complete — plank delivered.");
  return requestHash;
}

export async function v3AddLiquidity(account: string, ethWei: bigint, s: V3Snapshot, slipBps = 100): Promise<string> {
  const { sharesUsed, lpMinted } = quoteAddLiquidity(ethWei, s);
  // Cap pulled shares a touch above the quote for rounding; floor LP for slippage.
  const maxShares = (sharesUsed * BigInt(10000 + 50)) / BPS + BigInt(1);
  const minLp = applySlip(lpMinted, slipBps);
  return send(account, V3.encodeFunctionData("addLiquidity", [maxShares, minLp]), ethWei);
}

export async function v3RemoveLiquidity(account: string, lpIn: bigint, s: V3Snapshot, slipBps = 100): Promise<string> {
  const { ethOut, sharesOut } = quoteRemoveLiquidity(lpIn, s);
  return send(
    account,
    V3.encodeFunctionData("removeLiquidity", [lpIn, applySlip(ethOut, slipBps), applySlip(sharesOut, slipBps)])
  );
}

/** The connected account's native ETH balance on the configured chain. */
export async function getEthBalance(account: string): Promise<bigint> {
  return provider().getBalance(account);
}

const ERC721_BAL = new Interface(["function balanceOf(address) view returns (uint256)"]);
/** How many collection planks the account holds (redeemed / not yet deposited). */
export async function getPlankBalance(account: string): Promise<number> {
  const c = new Contract(NFT_CONTRACT_ADDRESS, ERC721_BAL, provider());
  try {
    return Number((await c.balanceOf(account)) as bigint);
  } catch {
    return 0;
  }
}

export function formatUnits(wei: bigint, dp = 4): string {
  const whole = wei / SHARE_UNIT;
  const frac = (wei % SHARE_UNIT).toString().padStart(18, "0").slice(0, dp);
  return `${whole}.${frac}`;
}
