/**
 * V3 vault call layer. V3's on-chain shape differs from V1/V2 — ETH-denominated
 * fees (wei, not bps), an explicit shareReserve, proportional LP, and payable
 * deposit/redeem — so it gets its own reader/writer rather than retrofitting the
 * V2-shaped vault.ts. Writes go through the same allowlisted wallet path.
 */
import { Contract, Interface, JsonRpcProvider } from "ethers";
import v3Abi from "@/lib/market/vault-v3-abi.json";
import { CHAIN, MARKET_VAULT_ADDRESS } from "@/lib/constants";
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

let cachedProvider: JsonRpcProvider | null = null;
function reader(addr?: string | null): Contract {
  if (!cachedProvider) {
    cachedProvider = new JsonRpcProvider(CHAIN.rpcUrls.default, { chainId: CHAIN.id, name: CHAIN.name });
  }
  return new Contract(vaultOr(addr), v3Abi, cachedProvider);
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

export function formatUnits(wei: bigint, dp = 4): string {
  const whole = wei / SHARE_UNIT;
  const frac = (wei % SHARE_UNIT).toString().padStart(18, "0").slice(0, dp);
  return `${whole}.${frac}`;
}
