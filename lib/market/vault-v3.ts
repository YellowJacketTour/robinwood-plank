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

/** Exported so server-side readers (lib/market/vault-stats.ts) can encode/decode
 *  V3 calls through the ethCallMany batching/failover layer instead of this
 *  file's browser-oriented ethers.Contract reader. Same ABI, same Interface —
 *  just reused rather than re-built. */
export const V3_IFACE = new Interface(v3Abi);
const V3 = V3_IFACE;
const ERC721 = new Interface([
  "function getApproved(uint256) view returns (address)",
  "function isApprovedForAll(address,address) view returns (bool)",
  "function approve(address,uint256)",
  "function setApprovalForAll(address,bool)",
]);

export const SHARE_UNIT = BigInt("1000000000000000000");
const BPS = BigInt(10000);

/** Readable copy for V3's custom errors — the analog of vault.ts's map. */
const V3_ERROR_MESSAGES: Record<string, string> = {
  RequestPending: "The vault's redeem slot is busy — someone else is mid-redeem. Try again shortly.",
  PoolNotOpen: "The pool is closed — trading is paused. Deposit and redeem still work.",
  PoolAlreadyOpen: "The pool is already open.",
  EmptyVault: "The vault holds no planks to redeem right now.",
  ReservedForPendingRedeem: "That plank is reserved for an in-flight random redeem. Try another.",
  TokenNotHeld: "The vault no longer holds that plank — it was just taken. Pick another.",
  IncorrectFee: "Fee mismatch — reload and retry (the vault fee may have changed).",
  InsufficientOutput: "Price moved past your slippage tolerance. Raise it or retry.",
  InsufficientLiquidity: "Not enough liquidity in the pool for that size.",
  RandomnessNotAvailable: "The drand round for your redeem isn't on-chain yet — wait a few seconds and claim again.",
  RandomnessExpired: "Your redeem's drand round expired. You can forfeit it for a refund and retry.",
  DrawNotPinned: "The random draw hasn't been pinned yet — wait a moment and retry.",
  NoRequest: "There's no pending redeem for that wallet.",
  TooSoon: "Too soon — the request hasn't expired yet.",
  AlreadyHeld: "The vault already holds that plank.",
  SolvencyBroken: "The vault refused the trade to protect solvency. Reload and retry.",
  EthBackingBroken: "The vault refused the trade to protect its ETH backing. Reload and retry.",
  TransferFailed: "A token/ETH transfer failed. Check balances and retry.",
  NotTreasury: "Only the treasury can do that.",
};

/**
 * Decode a V3 revert into readable copy, mirroring vault.ts's decodeVaultError
 * for V3's custom-error set. Falls back to the wallet's short message.
 */
export function decodeV3Error(err: unknown): string {
  const e = err as {
    message?: string;
    shortMessage?: string;
    data?: unknown;
    error?: { data?: unknown; message?: string };
    info?: { error?: { data?: unknown; message?: string } };
    cause?: { data?: unknown; message?: string };
  };
  const msg = (e?.message || "").toLowerCase();
  if (msg.includes("user rejected") || msg.includes("user denied") || msg.includes("action_rejected")) {
    return "You rejected the request in your wallet.";
  }
  if (msg.includes("insufficient funds")) return "Not enough ETH to cover the amount plus gas.";
  const candidates = [e?.data, e?.error?.data, e?.info?.error?.data, e?.cause?.data];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.startsWith("0x") || candidate.length < 10) continue;
    try {
      const parsed = V3.parseError(candidate);
      if (parsed && V3_ERROR_MESSAGES[parsed.name]) return V3_ERROR_MESSAGES[parsed.name];
      if (parsed) return `Reverted: ${parsed.name}.`;
    } catch {
      /* not a V3-ABI error — try the next candidate */
    }
  }
  return (e?.shortMessage || e?.message || e?.error?.message || e?.info?.error?.message || "Transaction failed.").replace(/\s*\(action=.*$/i, "").slice(0, 180);
}

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
  /** planks free to redeem right now (held minus any pending random draw). */
  availableCount: number;
  /** outstanding random-redeem requests (the single vault-wide slot). */
  pendingRedeemCount: number;
  /** permanently-locked seed LP at address(0) — not any user's, never withdrawable. */
  lockedLp: bigint;
  /** account-specific (0 when no account) */
  shareBalance: bigint;
  lpBalance: bigint;
};

const ZERO = "0x0000000000000000000000000000000000000000";

export async function getV3Snapshot(addr?: string | null, account?: string | null): Promise<V3Snapshot> {
  const v = reader(addr);
  const [held, available, pendingCount, totalSupply, ethReserve, shareReserve, totalLpSupply, lockedLp, accruedFees, poolOpen, mintFeeWei, redeemFeeWei, targetPremiumWei, swapFeeBps] =
    (await Promise.all([
      v.heldTokenCount(),
      v.availableTokenCount(),
      v.pendingRedeemCount(),
      v.totalSupply(),
      v.ethReserve(),
      v.shareReserve(),
      v.totalLpSupply(),
      v.lpBalance(ZERO), // the locked seed position
      v.accruedFees(),
      v.poolOpen(),
      v.mintFeeWei(),
      v.redeemFeeWei(),
      v.targetPremiumWei(),
      v.swapFeeBps(),
    ])) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean, bigint, bigint, bigint, bigint];

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
    availableCount: Number(available),
    pendingRedeemCount: Number(pendingCount),
    lockedLp,
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

// ── Bulk (cart) ────────────────────────────────────────────────────────────
// The vault exposes depositMany/redeemTargetMany (MAX_BATCH 50) with an exact
// msg.value == fee*n. These back the NFTX-style multi-select cart.
const MAX_BATCH = 50;

/** Redeem a chosen set of held planks in one tx. value = (redeem+premium)*n. */
export async function v3RedeemTargetMany(account: string, tokenIds: string[], s: V3Snapshot, addr?: string | null): Promise<string> {
  if (tokenIds.length === 0 || tokenIds.length > MAX_BATCH) throw new Error(`Pick 1–${MAX_BATCH} planks.`);
  const value = (s.redeemFeeWei + s.targetPremiumWei) * BigInt(tokenIds.length);
  return send(account, V3.encodeFunctionData("redeemTargetMany", [tokenIds]), value, addr);
}

/** Deposit a chosen set of owned planks in one tx. value = mintFee*n. Uses a
 *  single setApprovalForAll (depositMany pulls N NFTs — N approvals is wasteful). */
export async function v3DepositMany(account: string, tokenIds: string[], s: V3Snapshot, addr?: string | null): Promise<string> {
  if (tokenIds.length === 0 || tokenIds.length > MAX_BATCH) throw new Error(`Pick 1–${MAX_BATCH} planks.`);
  const vaultAddr = vaultOr(addr);
  const nft = NFT_CONTRACT_ADDRESS;
  const injected = getEthereumProvider();
  if (!injected) throw new Error("No wallet found.");
  const allHex = (await injected.request({
    method: "eth_call",
    params: [{ to: nft, data: ERC721.encodeFunctionData("isApprovedForAll", [account, vaultAddr]) }, "latest"],
  })) as string;
  const approvedForAll = BigInt(allHex === "0x" ? 0 : allHex) !== BigInt(0);
  if (!approvedForAll) {
    const h = await sendTransaction({
      to: nft,
      from: account,
      data: ERC721.encodeFunctionData("setApprovalForAll", [vaultAddr, true]),
      kind: "vault",
    });
    await waitForTransaction(h, { label: "Approve deposits" });
  }
  const value = s.mintFeeWei * BigInt(tokenIds.length);
  return send(account, V3.encodeFunctionData("depositMany", [tokenIds]), value, addr);
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

// ── Stuck-slot rescue (the analog of legacy StuckRedeemRelay/PendingRedeemClaim).
// The vault has ONE redeem slot; if a requester walks away between request and
// claim, everyone's trades block until it clears. These permissionless calls let
// anyone free it: settle-and-deliver to the requester once their round is on
// chain, or forfeit an expired-and-never-pinned request. No fee — paid at request.

/** Permissionlessly settle someone else's pinned redeem, delivering to them. */
export async function v3ClaimRandomRedeemFor(account: string, requester: string, addr?: string | null): Promise<string> {
  return send(account, V3.encodeFunctionData("claimRandomRedeemFor", [requester]), undefined, addr);
}

/** Permissionlessly forfeit an expired, never-pinned request to free the slot. */
export async function v3ForfeitExpiredRedeem(account: string, requester: string, addr?: string | null): Promise<string> {
  return send(account, V3.encodeFunctionData("forfeitExpiredRedeem", [requester]), undefined, addr);
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
    // A 404 (route disabled outside dev) or any non-OK response means there is no
    // relayer here — signal that explicitly so the caller stops polling a dead
    // endpoint for the full timeout instead of treating it as "still working".
    if (res.status === 404) return "no_relay";
    if (!res.ok) return "no_relay";
    const data = (await res.json()) as { status?: string };
    return data.status ?? "no_relay";
  } catch {
    // Network failure reaching the relay — same as no relay.
    return "no_relay";
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
    // A transient read blip must NOT abort here — the request already committed
    // on-chain; treat an unreadable poll as "still pending" and keep going.
    let pend: V3Pending | null = null;
    try {
      pend = await getV3Pending(addr, account);
    } catch {
      /* transient — retry next tick */
    }
    if (pend && !pend.isMe) {
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
  // maxSharesIn is an upper BOUND (the contract pulls exactly ceilDiv(value·S/E)
  // from current reserves and reverts only if that exceeds this cap). The quote
  // is off a client-cached snapshot, so give it real headroom for reserve drift
  // between quote and submit — otherwise an active pool reverts InsufficientOutput.
  const maxShares = (sharesUsed * BigInt(10000 + 300)) / BPS + BigInt(1);
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

// ── Price history (share price = ethReserve / shareReserve, over time) ───────
export type PricePoint = { ts: number; price: number };

/** Sample the vault's share price over recent blocks for the Price chart. Reads
 *  historical reserves via blockTag calls (needs an archive node in prod; the
 *  local dev node keeps full state). Lazy — call only when the Price tab opens. */
export async function getV3PriceSeries(addr?: string | null, points = 24, lookbackBlocks = 100_000): Promise<PricePoint[]> {
  const v = reader(addr);
  const p = provider();
  const latest = await p.getBlockNumber();
  const from = Math.max(0, latest - lookbackBlocks);
  const step = Math.max(1, Math.floor((latest - from) / Math.max(1, points - 1)));
  const blocks: number[] = [];
  for (let b = from; b < latest; b += step) blocks.push(b);
  blocks.push(latest);
  const out: PricePoint[] = [];
  await Promise.all(
    blocks.map(async (b) => {
      try {
        const [eth, sh, blk] = await Promise.all([
          v.ethReserve.staticCall({ blockTag: b }) as Promise<bigint>,
          v.shareReserve.staticCall({ blockTag: b }) as Promise<bigint>,
          p.getBlock(b),
        ]);
        if (sh > BigInt(0) && blk) out.push({ ts: Number(blk.timestamp), price: Number(eth) / Number(sh) });
      } catch {
        /* block before deploy / archive miss — skip */
      }
    })
  );
  return out.sort((a, b) => a.ts - b.ts);
}

// ── Activity feed (recent vault events) ────────────────────────────────────
export type V3ActivityKind = "buy" | "sell" | "deposit" | "redeem" | "lp-add" | "lp-remove";
export type V3Activity = {
  kind: V3ActivityKind;
  tokenId?: string;   // deposit / redeem — drives the row thumbnail
  eth?: bigint;       // ETH in/out
  shares?: bigint;    // shares in/out
  targeted?: boolean; // redeem: targeted vs random
  who: string;        // short actor address
  block: number;
  ts: number;         // unix seconds (0 if unknown)
  tx: string;         // tx hash
  key: string;
  image?: string;     // resolved client-side for deposit/redeem thumbnails
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Read the vault's recent trade events for the Activity tab. Lazy — call only
 *  when the tab is opened. Bounded lookback so it stays cheap on a long chain. */
export async function getV3Activity(addr?: string | null, lookback = 50_000): Promise<V3Activity[]> {
  const v = reader(addr);
  const p = provider();
  const latest = await p.getBlockNumber();
  const from = Math.max(0, latest - lookback);
  type Raw = Omit<V3Activity, "who" | "key" | "ts"> & { who: string; ti: number; name: string };
  const rows: Raw[] = [];
  const grab = async (name: string, fmt: (a: readonly unknown[]) => Partial<Raw> & { who: string }) => {
    try {
      const logs = await v.queryFilter(v.filters[name](), from, latest);
      for (const log of logs) {
        const args = ("args" in log ? (log.args as readonly unknown[]) : []) ?? [];
        rows.push({ ...fmt(args), block: log.blockNumber, tx: log.transactionHash, ti: log.index ?? 0, name } as Raw);
      }
    } catch {
      /* event not present / node hiccup — skip */
    }
  };
  await Promise.all([
    grab("Bought", (a) => ({ kind: "buy", who: String(a[0]), eth: a[1] as bigint, shares: a[2] as bigint })),
    grab("Sold", (a) => ({ kind: "sell", who: String(a[0]), shares: a[1] as bigint, eth: a[2] as bigint })),
    grab("Deposited", (a) => ({ kind: "deposit", who: String(a[0]), tokenId: (a[1] as bigint).toString() })),
    grab("Redeemed", (a) => ({ kind: "redeem", who: String(a[0]), tokenId: (a[1] as bigint).toString(), targeted: Boolean(a[2]) })),
    grab("LiquidityAdded", (a) => ({ kind: "lp-add", who: String(a[0]), shares: a[1] as bigint, eth: a[2] as bigint })),
    grab("LiquidityRemoved", (a) => ({ kind: "lp-remove", who: String(a[0]), shares: a[1] as bigint, eth: a[2] as bigint })),
  ]);
  rows.sort((x, y) => y.block - x.block || y.ti - x.ti);
  const top = rows.slice(0, 25);
  // block timestamps (unique blocks only) for relative-time display
  const tsMap = new Map<number, number>();
  await Promise.all(
    [...new Set(top.map((r) => r.block))].map(async (b) => {
      try {
        const blk = await p.getBlock(b);
        if (blk) tsMap.set(b, Number(blk.timestamp));
      } catch {
        /* skip */
      }
    })
  );
  return top.map((r) => ({
    kind: r.kind, tokenId: r.tokenId, eth: r.eth, shares: r.shares, targeted: r.targeted,
    who: short(r.who), block: r.block, ts: tsMap.get(r.block) ?? 0, tx: r.tx,
    key: `${r.block}-${r.ti}-${r.name}`,
  }));
}
