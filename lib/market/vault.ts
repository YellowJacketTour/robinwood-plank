import { BrowserProvider, Contract, Interface, JsonRpcProvider, parseEther } from "ethers";
import vaultAbi from "@/lib/market/vault-abi.json";
import { CHAIN, MARKET_VAULT_ADDRESS } from "@/lib/constants";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import {
  ensureRobinhoodChain,
  getEthereumProvider,
  sendTransaction,
  waitForTransaction,
} from "@/lib/wallet";

/**
 * Thin wrapper around contracts/MarketplankVault.sol — UNAUDITED, not
 * deployed. Every function here throws immediately if MARKET_VAULT_ADDRESS
 * isn't set, so this can't silently point at nothing.
 *
 * Audit 2026-07-27 rework:
 * - READS still use an ethers BrowserProvider (static network pins chain 4663).
 * - WRITES no longer go through the raw ethers signer. They are encoded here
 *   and sent via lib/wallet.ts sendTransaction(kind: "vault"), which re-checks
 *   eth_chainId immediately before send, enforces the `to` allowlist, and
 *   hard-fails on a reverting eth_call before the wallet popup.
 * - buyShares/sellShares REQUIRE a min-out (no more silent 0 = unbounded
 *   slippage); expected output comes from an eth_call of the swap itself.
 * - deposit() now grants the single-token ERC-721 approval it always needed
 *   (previously every first-time depositor reverted and lost gas).
 */

const VAULT_IFACE = new Interface(vaultAbi);

const ERC721_IFACE = new Interface([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function approve(address to, uint256 tokenId)",
]);

function requireVaultAddress(): string {
  if (!MARKET_VAULT_ADDRESS) {
    throw new Error("No liquidity vault deployed for this collection yet.");
  }
  return MARKET_VAULT_ADDRESS;
}

function collectionAddress(): string {
  const c = MARKET_COLLECTIONS[0];
  if (!c) throw new Error("No collection configured.");
  return c.contractAddress;
}

/** Read-only contract handle (never used to send). */
async function getVaultReader(): Promise<Contract> {
  const address = requireVaultAddress();
  await ensureRobinhoodChain();
  const injected = getEthereumProvider();
  if (!injected) throw new Error("No wallet found.");
  const provider = new BrowserProvider(injected, { chainId: CHAIN.id, name: CHAIN.name });
  return new Contract(address, vaultAbi, provider);
}

let publicVaultReaderCache: Contract | null = null;
/**
 * Same reads as getVaultReader(), but over the chain's own public RPC —
 * never touches window.ethereum. These are plain contract-state reads with
 * no notion of "which account," so they don't need a wallet at all; routing
 * them through the injected provider needlessly calls ensureRobinhoodChain()
 * (which can fire a wallet_switchEthereumChain prompt) on every poll tick.
 * Components that poll this on an interval (StuckRedeemRelay,
 * PendingRedeemClaim) were doing exactly that every 6-8s, which looked like
 * a connect popup that "keeps coming back" even with no wallet connected.
 */
function getPublicVaultReader(): Contract {
  if (publicVaultReaderCache) return publicVaultReaderCache;
  const address = requireVaultAddress();
  const provider = new JsonRpcProvider(CHAIN.rpcUrls.default, { chainId: CHAIN.id, name: CHAIN.name });
  publicVaultReaderCache = new Contract(address, vaultAbi, provider);
  return publicVaultReaderCache;
}

/**
 * The vault address is env-configurable (a real deploy output), so before the
 * first write we verify it actually wraps OUR collection — a mistyped env var
 * pointing at some other contract fails closed here instead of at the user's
 * expense.
 */
async function assertVaultWrapsOurCollection(vault: Contract): Promise<void> {
  const wrapped = (await vault.collection()) as string;
  if (wrapped.toLowerCase() !== collectionAddress().toLowerCase()) {
    throw new Error(
      "Configured vault does not wrap the RobinWood collection — refusing to transact."
    );
  }
}

async function sendVaultTx(
  accountAddress: string,
  data: string,
  valueWei?: bigint,
  onSubmitted?: (hash: string) => void
): Promise<string> {
  const hash = await sendTransaction({
    to: requireVaultAddress(),
    from: accountAddress,
    data,
    value: valueWei !== undefined ? valueWei.toString() : undefined,
    kind: "vault",
  });
  // Fires as soon as the wallet returns a hash, well before confirmation —
  // lets the UI show a "pending" row immediately instead of only after
  // waitForTransaction resolves below.
  onSubmitted?.(hash);
  await waitForTransaction(hash, { label: "Vault transaction" });
  return hash;
}

/** 1.0 share, in wei (18 decimals) — the unit every redeem burns at least one of. */
export const SHARE_UNIT = BigInt(1_000_000_000_000_000_000);

/** What a redeem actually costs in shares: 1.0 + the redeem fee, plus the
 * targeted-redeem premium on top when picking a specific plank instead of a
 * random one. Exposed so the UI can show it next to the user's real balance
 * BEFORE they submit, instead of them finding out via a failed transaction —
 * previously the only way anyone found out they didn't have enough. */
export function redeemCostWei(redeemFeeBps: number, targetPremiumBps: number, targeted: boolean): bigint {
  const bps = BigInt(redeemFeeBps + (targeted ? targetPremiumBps : 0));
  return SHARE_UNIT + (SHARE_UNIT * bps) / BigInt(10_000);
}

/** Human text for this vault's own Solidity custom errors — a raw revert
 * otherwise reaches the user as opaque hex/generic "execution reverted",
 * indistinguishable whether the real cause was "you don't have enough
 * shares," "someone else's redeem is already in flight vault-wide," or
 * something else entirely. Tries every place a wallet/provider might have
 * put the raw revert data before giving up and falling back to whatever
 * message text it did get. */
const VAULT_ERROR_MESSAGES: Record<string, string> = {
  RequestPending:
    "Someone else's random redeem is already in progress — only one can be pending vault-wide at a time (this prevents front-running the draw). Try again in a few minutes, or redeem a specific plank instead.",
  EmptyVault: "The vault has no unreserved planks left to redeem right now.",
  TokenNotHeld: "That plank isn't currently held by the vault.",
  ReservedForPendingRedeem:
    "That plank is reserved for someone else's in-flight redemption, or every remaining plank is. Try again shortly.",
  NoRequest: "You don't have a pending random redemption to claim.",
  RandomnessNotAvailable: "The drand round for your redemption hasn't been relayed yet — try again in a few seconds.",
  RandomnessExpired: "Your redemption's drand round expired before it was claimed.",
  DrawNotPinned: "Your redemption's draw hasn't resolved yet — try again in a few seconds.",
  InsufficientOutput: "Price moved — try again with a fresh quote or a higher slippage tolerance.",
  PoolNotOpen: "The vault isn't open for trading yet.",
  NotTreasury: "Only the vault's treasury can do that.",
  AlreadyHeld: "The vault already holds that plank.",
};

export function decodeVaultError(err: unknown): string {
  const e = err as {
    message?: string;
    shortMessage?: string;
    data?: unknown;
    error?: { data?: unknown; message?: string };
    info?: { error?: { data?: unknown; message?: string } };
    cause?: { data?: unknown; message?: string };
  };
  const candidates = [e?.data, e?.error?.data, e?.info?.error?.data, e?.cause?.data];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.startsWith("0x") || candidate.length < 10) continue;
    try {
      const parsed = VAULT_IFACE.parseError(candidate);
      if (parsed && VAULT_ERROR_MESSAGES[parsed.name]) return VAULT_ERROR_MESSAGES[parsed.name];
      if (parsed) return `Reverted: ${parsed.name}.`;
    } catch {
      // not a vault-ABI error — try the next candidate / fall through
    }
  }
  return (
    e?.shortMessage ||
    e?.message ||
    e?.error?.message ||
    e?.info?.error?.message ||
    e?.cause?.message ||
    "Transaction failed."
  );
}

/** min-out = expected * (10000 - slippageBps) / 10000, failing closed on nonsense. */
export function applySlippage(expected: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error("Slippage must be between 0 and 9999 basis points.");
  }
  if (expected <= BigInt(0)) {
    throw new Error("Quoted output is zero — refusing to trade with no minimum output.");
  }
  const min = (expected * BigInt(10_000 - slippageBps)) / BigInt(10_000);
  if (min <= BigInt(0)) {
    throw new Error("Minimum output rounds to zero — refusing unbounded slippage.");
  }
  return min;
}

/**
 * Deposit an NFT for shares. Grants the vault the single-token approval first
 * if it doesn't already have one (approve(vault, tokenId) — consumed by the
 * transfer, never a blanket setApprovalForAll).
 */
export async function depositForShares(
  accountAddress: string,
  tokenId: string,
  onSubmitted?: (hash: string) => void
): Promise<string> {
  const vault = await getVaultReader();
  await assertVaultWrapsOurCollection(vault);
  const vaultAddr = requireVaultAddress();
  const nft = collectionAddress();
  const injected = getEthereumProvider();
  if (!injected) throw new Error("No wallet found.");

  const [approvedHex, allHex] = await Promise.all([
    injected.request({
      method: "eth_call",
      params: [{ to: nft, data: ERC721_IFACE.encodeFunctionData("getApproved", [tokenId]) }, "latest"],
    }) as Promise<string>,
    injected.request({
      method: "eth_call",
      params: [
        { to: nft, data: ERC721_IFACE.encodeFunctionData("isApprovedForAll", [accountAddress, vaultAddr]) },
        "latest",
      ],
    }) as Promise<string>,
  ]);
  const approvedTo = `0x${(approvedHex || "0x").slice(-40)}`.toLowerCase();
  const hasApproval =
    approvedTo === vaultAddr.toLowerCase() || BigInt(allHex === "0x" ? 0 : allHex) !== BigInt(0);

  if (!hasApproval) {
    const approveHash = await sendTransaction({
      to: nft,
      from: accountAddress,
      data: ERC721_IFACE.encodeFunctionData("approve", [vaultAddr, tokenId]),
      kind: "vault",
    });
    await waitForTransaction(approveHash, { label: "Deposit approval" });
  }

  return sendVaultTx(accountAddress, VAULT_IFACE.encodeFunctionData("deposit", [tokenId]), undefined, onSubmitted);
}

/**
 * Read-only quotes — the SAME staticCall buyShares/sellShares already use
 * internally to compute their min-out, exposed standalone so the UI can show
 * "you receive ~Y" live, before signing anything. staticCall never sends a
 * transaction or spends gas; it's a plain eth_call under the hood. Returns
 * null on any failure (no liquidity, bad amount, RPC hiccup) — the caller
 * shows "quote unavailable" rather than a stale or fabricated number.
 */
export async function quoteBuyShares(
  accountAddress: string,
  ethAmount: string
): Promise<bigint | null> {
  try {
    const vault = await getVaultReader();
    await assertVaultWrapsOurCollection(vault);
    const value = parseEther(ethAmount);
    if (value <= BigInt(0)) return null;
    return (await vault.buyShares.staticCall(BigInt(0), {
      value,
      from: accountAddress,
    })) as bigint;
  } catch {
    return null;
  }
}

export async function quoteSellShares(
  accountAddress: string,
  sharesWei: bigint
): Promise<bigint | null> {
  try {
    if (sharesWei <= BigInt(0)) return null;
    const vault = await getVaultReader();
    await assertVaultWrapsOurCollection(vault);
    return (await vault.sellShares.staticCall(sharesWei, BigInt(0), {
      from: accountAddress,
    })) as bigint;
  } catch {
    return null;
  }
}

/**
 * Buy shares with ETH. The expected output is quoted by eth_call-ing the swap
 * itself, then bounded by `slippageBps` — there is no zero-min path anymore.
 */
export async function buyShares(
  accountAddress: string,
  ethAmount: string,
  slippageBps: number,
  onSubmitted?: (hash: string) => void
): Promise<string> {
  const vault = await getVaultReader();
  await assertVaultWrapsOurCollection(vault);
  const value = parseEther(ethAmount);
  const expected = (await vault.buyShares.staticCall(BigInt(0), {
    value,
    from: accountAddress,
  })) as bigint;
  const minSharesOut = applySlippage(expected, slippageBps);
  return sendVaultTx(
    accountAddress,
    VAULT_IFACE.encodeFunctionData("buyShares", [minSharesOut]),
    value,
    onSubmitted
  );
}

/** Sell shares for ETH, min-out bounded by `slippageBps`. */
export async function sellShares(
  accountAddress: string,
  sharesWei: bigint,
  slippageBps: number,
  onSubmitted?: (hash: string) => void
): Promise<string> {
  const vault = await getVaultReader();
  await assertVaultWrapsOurCollection(vault);
  const expected = (await vault.sellShares.staticCall(sharesWei, BigInt(0), {
    from: accountAddress,
  })) as bigint;
  const minEthOut = applySlippage(expected, slippageBps);
  return sendVaultTx(
    accountAddress,
    VAULT_IFACE.encodeFunctionData("sellShares", [sharesWei, minEthOut]),
    undefined,
    onSubmitted
  );
}

/**
 * !!! FLAGGED FOR THE UI OWNER — the random-redemption flow is now TWO
 * transactions, and this function only does the first half.
 *
 * It always was two on-chain steps (the commit-reveal split), but this wrapper
 * still called a `redeemRandom()` that has not existed since revision 2, so it
 * reverted unconditionally. It is corrected here to the real entry point.
 *
 * The full flow after the revision-4 drand rework:
 *   1. requestRandomRedeem()  — burns the shares, anchors to a FUTURE drand
 *      round (see getPendingRound below).
 *   2. wait ~3-6 seconds for that round to be published and relayed on-chain
 *      by anyone (scripts/relay-drand.ts, or any other relayer).
 *   3. claimRandomRedeem()    — delivers the NFT.
 *
 * Between 1 and 2, claimRandomRedeem reverts with RandomnessNotAvailable.
 * components/market/SwapPanel.tsx currently fires this and considers the
 * redemption done; it needs a second step and a short "waiting for drand
 * round N" state. That UI work is intentionally NOT done here so it does not
 * collide with whatever else is in flight on that component.
 */
export async function requestRandomRedeem(
  accountAddress: string,
  onSubmitted?: (hash: string) => void
): Promise<string> {
  const vault = await getVaultReader();
  await assertVaultWrapsOurCollection(vault);
  const held = (await vault.heldTokenCount()) as bigint;
  if (held <= BigInt(0)) {
    throw new Error("The vault holds no NFTs to redeem right now.");
  }
  return sendVaultTx(
    accountAddress,
    VAULT_IFACE.encodeFunctionData("requestRandomRedeem", []),
    undefined,
    onSubmitted
  );
}

/** Step 2: claim once the target drand round has been relayed. */
export async function claimRandomRedeem(
  accountAddress: string,
  onSubmitted?: (hash: string) => void
): Promise<string> {
  const vault = await getVaultReader();
  await assertVaultWrapsOurCollection(vault);
  return sendVaultTx(
    accountAddress,
    VAULT_IFACE.encodeFunctionData("claimRandomRedeem", []),
    undefined,
    onSubmitted
  );
}

/** The drand round the in-flight request waits on, and whether it has landed. */
export async function getPendingRound(): Promise<{ round: bigint; available: boolean }> {
  const vault = getPublicVaultReader();
  const [round, available] = (await vault.pendingRound()) as [bigint, boolean];
  return { round, available };
}

/** address(0) when nobody has an in-flight random redemption (there is only
 * ever one vault-wide slot — see contracts/MarketplankVault.sol). */
export async function getPendingRequester(): Promise<string> {
  const vault = getPublicVaultReader();
  return (await vault.pendingRequester()) as string;
}

export async function redeemTarget(
  accountAddress: string,
  tokenId: string,
  onSubmitted?: (hash: string) => void
): Promise<string> {
  const vault = await getVaultReader();
  await assertVaultWrapsOurCollection(vault);
  // Pre-check the vault actually holds this token so the user doesn't burn
  // gas on a guaranteed TokenNotHeld revert (the wallet-side simulation would
  // also catch it, but this gives a readable message first).
  const injected = getEthereumProvider();
  if (!injected) throw new Error("No wallet found.");
  let owner = "";
  try {
    const hex = (await injected.request({
      method: "eth_call",
      params: [
        { to: collectionAddress(), data: ERC721_IFACE.encodeFunctionData("ownerOf", [tokenId]) },
        "latest",
      ],
    })) as string;
    owner = `0x${hex.slice(-40)}`.toLowerCase();
  } catch {
    throw new Error(`Token #${tokenId} does not exist.`);
  }
  if (owner !== requireVaultAddress().toLowerCase()) {
    throw new Error(`Token #${tokenId} is not held by the vault.`);
  }
  return sendVaultTx(
    accountAddress,
    VAULT_IFACE.encodeFunctionData("redeemTarget", [tokenId]),
    undefined,
    onSubmitted
  );
}

export async function getVaultShareBalance(account: string): Promise<bigint> {
  const vault = await getVaultReader();
  return vault.balanceOf(account);
}

export async function getVaultHeldCount(): Promise<bigint> {
  const vault = await getVaultReader();
  return vault.heldTokenCount();
}

/**
 * Treasury-only bootstrap trio. Documented on-chain sequence
 * (contracts/MarketplankVault.sol seedShares() dev comment):
 *   1. treasury deposit()s NFTs — same public deposit() everyone uses,
 *      minting shares to the treasury itself (see depositForShares above).
 *   2. treasury calls seedShares(shares) with ETH attached — moves those
 *      shares AND the ETH into the pool atomically, so it's never live with
 *      one empty side.
 *   3. treasury calls openPool() — one-way, opens buy/sell to everyone,
 *      forever. No withdrawal path exists for seeded ETH by design.
 * Every function here reverts on-chain (NotTreasury) if called by anyone
 * else — this is a UX nicety, not the actual access control.
 */
export async function getVaultTreasury(): Promise<string> {
  const vault = await getVaultReader();
  return vault.treasury();
}

export async function getPoolStatus(): Promise<{
  open: boolean;
  ethReserveWei: bigint;
  shareReserve: bigint;
  heldCount: bigint;
  treasuryShareBalance: bigint;
}> {
  const vault = await getVaultReader();
  const treasury = (await vault.treasury()) as string;
  const [open, ethReserveWei, shareReserve, heldCount, treasuryShareBalance] = await Promise.all([
    vault.poolOpen() as Promise<boolean>,
    vault.ethReserve() as Promise<bigint>,
    vault.balanceOf(requireVaultAddress()) as Promise<bigint>,
    vault.heldTokenCount() as Promise<bigint>,
    vault.balanceOf(treasury) as Promise<bigint>,
  ]);
  return { open, ethReserveWei, shareReserve, heldCount, treasuryShareBalance };
}

/** Step 2: move `shares` (already held by the treasury from prior deposits)
 * plus `ethAmount` ETH into the pool, atomically. Treasury-only on-chain. */
export async function seedShares(
  accountAddress: string,
  shares: bigint,
  ethAmount: string
): Promise<string> {
  const vault = await getVaultReader();
  await assertVaultWrapsOurCollection(vault);
  if (shares <= BigInt(0)) throw new Error("Enter a positive share amount to seed.");
  const value = ethAmount ? parseEther(ethAmount) : BigInt(0);
  return sendVaultTx(
    accountAddress,
    VAULT_IFACE.encodeFunctionData("seedShares", [shares]),
    value
  );
}

/** Step 3: the one-way, permanent switch. Treasury-only on-chain. */
export async function openPool(accountAddress: string): Promise<string> {
  const vault = await getVaultReader();
  await assertVaultWrapsOurCollection(vault);
  return sendVaultTx(accountAddress, VAULT_IFACE.encodeFunctionData("openPool", []));
}
