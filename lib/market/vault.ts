import { BrowserProvider, Contract, Interface, JsonRpcProvider, parseEther } from "ethers";
import vaultAbi from "@/lib/market/vault-abi.json";
import { CHAIN, MARKET_VAULT_ADDRESS, MARKET_VAULT_ADDRESSES, READ_RPC_URL } from "@/lib/constants";
import {
  collectionVaultAddresses,
  MARKET_COLLECTIONS,
} from "@/lib/market/collections";
import {
  ensureRobinhoodChain,
  getEthereumProvider,
  sendTransaction,
  waitForTransaction,
} from "@/lib/wallet";
import { relayDrandRound } from "@/lib/market/drand";
import { clearPendingVaultTx } from "@/lib/market/pendingVaultTx";
import { vaultGeneration } from "@/lib/market/vault-registry";

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

/** Vault addresses this build trusts: the env-derived primary/legacy pair
 * plus every vault linked from a collection entry — so a per-collection
 * vault is accepted the moment its collection entry ships, no env change. */
function trustedVaultAddresses(): string[] {
  const out = MARKET_VAULT_ADDRESSES.map((a) => a.toLowerCase());
  for (const address of collectionVaultAddresses()) {
    if (!out.includes(address)) out.push(address);
  }
  return out;
}

/** Default primary; pass an explicit address for legacy vault ops. */
function requireVaultAddress(vaultAddress?: string | null): string {
  if (vaultAddress) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(vaultAddress)) {
      throw new Error("Invalid vault address.");
    }
    const trusted = trustedVaultAddresses();
    if (trusted.length > 0 && !trusted.includes(vaultAddress.toLowerCase())) {
      throw new Error("That vault address is not configured for any collection.");
    }
    return vaultAddress;
  }
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

/** Resolve READ_RPC_URL to an absolute URL. A relative same-origin proxy path
 *  ("/api/rpc") is resolved against the browser origin — these reads run client
 *  side. Both the public Robinhood RPC and the local dev node block direct
 *  browser reads via CORS; the proxy does the request server-side. */
function readUrl(): string {
  if (READ_RPC_URL.startsWith("/")) {
    const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
    return origin + READ_RPC_URL;
  }
  return READ_RPC_URL;
}

/** Read-only contract handle (never used to send). */
async function getVaultReader(vaultAddress?: string | null): Promise<Contract> {
  const address = requireVaultAddress(vaultAddress);
  await ensureRobinhoodChain();
  const injected = getEthereumProvider();
  if (!injected) throw new Error("No wallet found.");
  const provider = new BrowserProvider(injected, { chainId: CHAIN.id, name: CHAIN.name });
  return new Contract(address, vaultAbi, provider);
}

const publicVaultReaderCache = new Map<string, Contract>();
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
function getPublicVaultReader(vaultAddress?: string | null): Contract {
  const address = requireVaultAddress(vaultAddress);
  const key = address.toLowerCase();
  const hit = publicVaultReaderCache.get(key);
  if (hit) return hit;
  const provider = new JsonRpcProvider(readUrl(), { chainId: CHAIN.id, name: CHAIN.name });
  const c = new Contract(address, vaultAbi, provider);
  publicVaultReaderCache.set(key, c);
  return c;
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
  onSubmitted?: (hash: string) => void,
  vaultAddress?: string | null
): Promise<string> {
  const hash = await sendTransaction({
    to: requireVaultAddress(vaultAddress),
    from: accountAddress,
    data,
    value: valueWei !== undefined ? valueWei.toString() : undefined,
    kind: "vault",
  });
  // Fires as soon as the wallet returns a hash, well before confirmation —
  // lets the UI show a "pending" row immediately instead of only after
  // waitForTransaction resolves below.
  onSubmitted?.(hash);
  try {
    await waitForTransaction(hash, { label: "Vault transaction" });
  } finally {
    // Always drop optimistic pending once the wallet tx finishes (success or
    // fail). Dual-vault activity feed is primary-only, so settle-for-others
    // on legacy never matched a stream hash and stuck "Pending · you" forever.
    clearPendingVaultTx(hash);
  }
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
  InsufficientLpCredit:
    "That exceeds your Add LP credit. You can only remove shares/ETH you previously contributed (not treasury seed or other traders' depth).",
  InsufficientLpReserve:
    "Pool reserves are lower than that amount right now (traded away). Try a smaller remove, or wait for the book to refill.",
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
  const msg = (e?.message || "").toLowerCase();
  if (msg.includes("user rejected") || msg.includes("user denied") || msg.includes("action_rejected")) {
    return "You rejected the request in your wallet.";
  }
  if (msg.includes("insufficient funds")) return "Not enough ETH to cover the amount plus gas.";
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
  onSubmitted?: (hash: string) => void,
  vaultAddress?: string | null
): Promise<string> {
  const vault = await getVaultReader(vaultAddress);
  await assertVaultWrapsOurCollection(vault);
  const vaultAddr = requireVaultAddress(vaultAddress);
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

  return sendVaultTx(
    accountAddress,
    VAULT_IFACE.encodeFunctionData("deposit", [tokenId]),
    undefined,
    onSubmitted,
    vaultAddress
  );
}

/**
 * Read-only quotes via public RPC (no wallet). Formula matches
 * MarketplankVault.buyShares/sellShares exactly:
 *   out = (in * reserveOut) / (reserveIn + in)
 * Previously these went through getVaultReader() → window.ethereum, so
 * Buy/Sell showed "—" / "Quote unavailable" without a wallet (and often
 * failed even with one when the injected provider couldn't staticCall).
 */
export async function quoteBuyShares(
  _accountAddress: string | null | undefined,
  ethAmount: string,
  vaultAddress?: string | null
): Promise<bigint | null> {
  try {
    const value = parseEther(ethAmount);
    if (value <= BigInt(0)) return null;
    const addr = requireVaultAddress(vaultAddress);
    const vault = getPublicVaultReader(addr);
    const ethReserve = (await vault.ethReserve()) as bigint;
    const shareReserve = (await vault.balanceOf(addr)) as bigint;
    if (shareReserve <= BigInt(0) || ethReserve <= BigInt(0)) return null;
    const sharesOut = (value * shareReserve) / (ethReserve + value);
    return sharesOut > BigInt(0) ? sharesOut : null;
  } catch {
    return null;
  }
}

export async function quoteSellShares(
  _accountAddress: string | null | undefined,
  sharesWei: bigint,
  vaultAddress?: string | null
): Promise<bigint | null> {
  try {
    if (sharesWei <= BigInt(0)) return null;
    const addr = requireVaultAddress(vaultAddress);
    const vault = getPublicVaultReader(addr);
    const ethReserve = (await vault.ethReserve()) as bigint;
    const shareReserve = (await vault.balanceOf(addr)) as bigint;
    if (shareReserve <= BigInt(0) || ethReserve <= BigInt(0)) return null;
    const ethOut = (sharesWei * ethReserve) / (shareReserve + sharesWei);
    return ethOut > BigInt(0) ? ethOut : null;
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
  onSubmitted?: (hash: string) => void,
  vaultAddress?: string | null
): Promise<string> {
  const vault = await getVaultReader(vaultAddress);
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
    onSubmitted,
    vaultAddress
  );
}

/** Sell shares for ETH, min-out bounded by `slippageBps`. */
export async function sellShares(
  accountAddress: string,
  sharesWei: bigint,
  slippageBps: number,
  onSubmitted?: (hash: string) => void,
  vaultAddress?: string | null
): Promise<string> {
  const vault = await getVaultReader(vaultAddress);
  await assertVaultWrapsOurCollection(vault);
  const expected = (await vault.sellShares.staticCall(sharesWei, BigInt(0), {
    from: accountAddress,
  })) as bigint;
  const minEthOut = applySlippage(expected, slippageBps);
  return sendVaultTx(
    accountAddress,
    VAULT_IFACE.encodeFunctionData("sellShares", [sharesWei, minEthOut]),
    undefined,
    onSubmitted,
    vaultAddress
  );
}

/**
 * Step 1 of random redemption only — burns shares and anchors a future drand
 * round. NFT delivery is claimRandomRedeem() after the round is on-chain
 * (see SwapPanel PendingRedeemClaim). Full flow:
 *   1. requestRandomRedeem()
 *   2. wait for drand publish + relay (GH Actions cron, in-app Relay, or any wallet)
 *   3. claimRandomRedeem()
 */
export async function requestRandomRedeem(
  accountAddress: string,
  onSubmitted?: (hash: string) => void,
  vaultAddress?: string | null
): Promise<string> {
  const vault = await getVaultReader(vaultAddress);
  await assertVaultWrapsOurCollection(vault);
  const held = (await vault.heldTokenCount()) as bigint;
  if (held <= BigInt(0)) {
    throw new Error("The vault holds no NFTs to redeem right now.");
  }
  return sendVaultTx(
    accountAddress,
    VAULT_IFACE.encodeFunctionData("requestRandomRedeem", []),
    undefined,
    onSubmitted,
    vaultAddress
  );
}

/** Step 2: claim once the target drand round has been relayed. */
export async function claimRandomRedeem(
  accountAddress: string,
  onSubmitted?: (hash: string) => void,
  vaultAddress?: string | null
): Promise<string> {
  const vault = await getVaultReader(vaultAddress);
  await assertVaultWrapsOurCollection(vault);
  return sendVaultTx(
    accountAddress,
    VAULT_IFACE.encodeFunctionData("claimRandomRedeem", []),
    undefined,
    onSubmitted,
    vaultAddress
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * After requestRandomRedeem is confirmed, immediately push randomness and
 * claim so the single vault-wide slot is not left for the next user to free.
 *
 * Flow:
 *   1. Wait until pendingRequester is this account and round is set
 *   2. Relay drand (permissionless) as soon as the public API has the round
 *   3. claimRandomRedeem — NFT lands, slot frees
 *
 * Retries while the round is not yet published (a few seconds is normal).
 */
export async function finishRandomRedeem(
  accountAddress: string,
  vaultAddress?: string | null,
  opts?: {
    onProgress?: (message: string) => void;
    onSubmitted?: (hash: string) => void;
    /** Max wait for drand publish + claim (default ~3 min). */
    timeoutMs?: number;
  }
): Promise<string> {
  const onProgress = opts?.onProgress;
  const timeoutMs = opts?.timeoutMs ?? 180_000;
  const started = Date.now();
  const me = accountAddress.toLowerCase();
  const zero = "0x0000000000000000000000000000000000000000";

  onProgress?.("Waiting for redeem slot + drand round…");
  let round = BigInt(0);
  let available = false;

  while (Date.now() - started < timeoutMs) {
    // A transient read failure here must NOT abort the flow — the share is
    // already burned on-chain. Skip this tick and retry rather than throwing.
    let who: string | null = null;
    try {
      who = (await getPendingRequester(vaultAddress)).toLowerCase();
    } catch {
      await sleep(1_500);
      continue;
    }
    if (who === zero) {
      throw new Error(
        "No pending random redeem for your wallet — request may have already settled or failed."
      );
    }
    if (who !== me) {
      throw new Error(
        "Another wallet holds the vault redeem slot right now. Wait for them to finish, or use Settle for them if available."
      );
    }
    try {
      const pend = await getPendingRound(vaultAddress);
      round = pend.round;
      available = pend.available;
    } catch {
      await sleep(1_500);
      continue;
    }
    if (round > BigInt(0)) break;
    await sleep(1_500);
  }
  if (round <= BigInt(0)) {
    throw new Error("Timed out waiting for the vault to pin a drand round. Try Claim again.");
  }

  // Relay until on-chain (or already available)
  if (!available) {
    let relayed = false;
    while (Date.now() - started < timeoutMs) {
      onProgress?.(
        relayed
          ? "Waiting for randomness to confirm on-chain…"
          : `Relaying drand round ${round.toString()}…`
      );
      try {
        await relayDrandRound(accountAddress, round);
        relayed = true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Round not published yet — keep polling
        if (/isn't published|not published|try again shortly/i.test(msg)) {
          await sleep(2_000);
          const again = await getPendingRound(vaultAddress);
          available = again.available;
          if (available) break;
          continue;
        }
        // Maybe someone else already relayed
        const again = await getPendingRound(vaultAddress);
        if (again.available) {
          available = true;
          break;
        }
        throw e;
      }
      const check = await getPendingRound(vaultAddress);
      available = check.available;
      if (available) break;
      await sleep(1_500);
    }
    if (!available) {
      throw new Error(
        `Timed out relaying drand round ${round.toString()}. Keep this tab open and press Claim when ready.`
      );
    }
  }

  onProgress?.("Claiming your NFT (frees the redeem slot)…");
  return claimRandomRedeem(accountAddress, opts?.onSubmitted, vaultAddress);
}

/**
 * Kick server relayer (no user gas) to relay + claimFor pending redeems.
 * Returns true if the slot cleared for this account (or vault idle).
 */
export async function kickServerRandomSettle(
  vaultAddress?: string | null,
  forRequester?: string | null
): Promise<{ ok: boolean; status?: string; detail?: string }> {
  // DEV-LOCAL: the production settle-random relayer uses the real drand API and
  // the real beacon's submitRound; against the local mock beacon it can't work.
  // Route through the dev relay instead (it injects the mock round + claims for
  // the requester, and is generic across V1/V2/V3 — same beacon).
  if (process.env.NEXT_PUBLIC_DEV_LOCAL_CHAIN === "1") {
    try {
      const res = await fetch("/api/dev-relay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vault: vaultAddress, requester: forRequester }),
      });
      if (!res.ok) return { ok: false, status: "no_key", detail: `dev-relay HTTP ${res.status}` };
      const d = (await res.json()) as { status?: string; detail?: string };
      if (d.status === "settled" || d.status === "idle") return { ok: true, status: d.status };
      return { ok: false, status: d.status, detail: d.detail };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
  try {
    const qs = new URLSearchParams({ public: "1" });
    if (vaultAddress) qs.set("vault", vaultAddress);
    if (forRequester) qs.set("for", forRequester);
    const res = await fetch(`/api/market/vault/settle-random?${qs}`, {
      method: "POST",
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, detail: `settle HTTP ${res.status}` };
    const data = (await res.json()) as {
      results?: Array<{ status: string; requester?: string; detail?: string }>;
      spentGas?: boolean;
    };
    const me = forRequester?.toLowerCase();
    const results = data.results ?? [];
    if (results.some((r) => r.status === "settled" || r.status === "forfeited" || r.status === "idle")) {
      if (!me) return { ok: true, status: results[0]?.status };
      const mine = results.find(
        (r) => r.requester && r.requester.toLowerCase() === me && (r.status === "settled" || r.status === "forfeited")
      );
      if (mine) return { ok: true, status: mine.status };
      // Slot free for someone else / idle
      if (results.every((r) => r.status === "idle")) return { ok: true, status: "idle" };
    }
    const waiting = results.find((r) => r.status === "waiting_round");
    if (waiting) return { ok: false, status: "waiting_round", detail: waiting.detail };
    const err = results.find((r) => r.status === "error" || r.status === "no_key");
    return { ok: false, status: err?.status, detail: err?.detail };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * One-shot random redeem: user signs ONLY requestRandomRedeem.
 * Relay + claimFor are sponsored by the server relayer when configured
 * (no second wallet popup / no user gas for finish). Falls back to the
 * user-paid finish path if the sponsor is offline.
 */
export async function requestAndFinishRandomRedeem(
  accountAddress: string,
  vaultAddress?: string | null,
  opts?: {
    onProgress?: (message: string) => void;
    onSubmitted?: (hash: string) => void;
    timeoutMs?: number;
  }
): Promise<string> {
  opts?.onProgress?.("Requesting random redeem (one wallet signature)…");
  const requestHash = await requestRandomRedeem(accountAddress, opts?.onSubmitted, vaultAddress);

  const timeoutMs = opts?.timeoutMs ?? 180_000;
  const started = Date.now();
  opts?.onProgress?.("Server finishing for you (no extra gas)…");

  while (Date.now() - started < timeoutMs) {
    const kick = await kickServerRandomSettle(vaultAddress, accountAddress);
    if (kick.ok && (kick.status === "settled" || kick.status === "forfeited" || kick.status === "idle")) {
      // Confirm slot is free for us — a transient read here shouldn't abort a
      // flow whose request already committed; just re-poll next tick.
      try {
        const who = (await getPendingRequester(vaultAddress)).toLowerCase();
        const me = accountAddress.toLowerCase();
        const zero = "0x0000000000000000000000000000000000000000";
        if (who === zero || who !== me) {
          opts?.onProgress?.("Redeem complete — NFT delivered, slot free.");
          return requestHash;
        }
      } catch {
        /* transient — retry */
      }
    }
    if (kick.status === "no_key") break; // fall through to user gas
    await new Promise((r) => setTimeout(r, 2_500));
  }

  // Sponsor missing or stuck — last resort: user-paid relay+claim.
  opts?.onProgress?.("Auto-finish busy — using your wallet to claim…");
  await finishRandomRedeem(accountAddress, vaultAddress, opts);
  return requestHash;
}

/**
 * Permissionless settle: deliver someone else's pinned random redeem to them.
 * Prevents a abandoned claim from locking the single vault-wide redeem slot.
 */
export async function claimRandomRedeemFor(
  accountAddress: string,
  requester: string,
  onSubmitted?: (hash: string) => void,
  vaultAddress?: string | null
): Promise<string> {
  const vault = await getVaultReader(vaultAddress);
  await assertVaultWrapsOurCollection(vault);
  return sendVaultTx(
    accountAddress,
    VAULT_IFACE.encodeFunctionData("claimRandomRedeemFor", [requester]),
    undefined,
    onSubmitted,
    vaultAddress
  );
}

/**
 * Permissionless forfeit of an expired, never-pinned request — frees the
 * vault-wide slot. Redeemer loses the burned share (treasury remint).
 */
export async function forfeitExpiredRedeem(
  accountAddress: string,
  requester: string,
  onSubmitted?: (hash: string) => void,
  vaultAddress?: string | null
): Promise<string> {
  const vault = await getVaultReader(vaultAddress);
  await assertVaultWrapsOurCollection(vault);
  return sendVaultTx(
    accountAddress,
    VAULT_IFACE.encodeFunctionData("forfeitExpiredRedeem", [requester]),
    undefined,
    onSubmitted,
    vaultAddress
  );
}

/** The drand round the in-flight request waits on, and whether it has landed. */
export async function getPendingRound(
  vaultAddress?: string | null
): Promise<{ round: bigint; available: boolean }> {
  const vault = getPublicVaultReader(vaultAddress);
  const [round, available] = (await vault.pendingRound()) as [bigint, boolean];
  return { round, available };
}

/** address(0) when nobody has an in-flight random redemption (there is only
 * ever one vault-wide slot — see contracts/MarketplankVault.sol). */
export async function getPendingRequester(vaultAddress?: string | null): Promise<string> {
  const vault = getPublicVaultReader(vaultAddress);
  return (await vault.pendingRequester()) as string;
}

export async function redeemTarget(
  accountAddress: string,
  tokenId: string,
  onSubmitted?: (hash: string) => void,
  vaultAddress?: string | null
): Promise<string> {
  const vault = await getVaultReader(vaultAddress);
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
  if (owner !== requireVaultAddress(vaultAddress).toLowerCase()) {
    throw new Error(`Token #${tokenId} is not held by the vault.`);
  }
  return sendVaultTx(
    accountAddress,
    VAULT_IFACE.encodeFunctionData("redeemTarget", [tokenId]),
    undefined,
    onSubmitted,
    vaultAddress
  );
}

export async function getVaultShareBalance(
  account: string,
  vaultAddress?: string | null
): Promise<bigint> {
  // Public RPC — no wallet prompt when checking balances on legacy + primary.
  const vault = getPublicVaultReader(vaultAddress);
  return vault.balanceOf(account);
}

export type VaultOnChainSnapshot = {
  address: string;
  held: number;
  totalSupply: bigint;
  shareBalance: bigint;
  ethReserve: bigint;
  shareReserve: bigint;
  mintFeeBps: number;
  redeemFeeBps: number;
  targetPremiumBps: number;
  poolOpen: boolean;
  supportsRemoveLp: boolean;
};

/** Public snapshot for migrate UI (no wallet). */
export async function getVaultOnChainSnapshot(
  vaultAddress: string,
  account?: string | null
): Promise<VaultOnChainSnapshot> {
  const vault = getPublicVaultReader(vaultAddress);
  const [held, totalSupply, ethReserve, shareReserve, mintFeeBps, redeemFeeBps, targetPremiumBps, poolOpen] =
    await Promise.all([
      vault.heldTokenCount() as Promise<bigint>,
      vault.totalSupply() as Promise<bigint>,
      vault.ethReserve() as Promise<bigint>,
      vault.balanceOf(vaultAddress) as Promise<bigint>,
      vault.mintFeeBps() as Promise<bigint>,
      vault.redeemFeeBps() as Promise<bigint>,
      vault.targetPremiumBps() as Promise<bigint>,
      vault.poolOpen() as Promise<boolean>,
    ]);
  let shareBalance = BigInt(0);
  if (account) {
    try {
      shareBalance = (await vault.balanceOf(account)) as bigint;
    } catch {
      shareBalance = BigInt(0);
    }
  }
  let supportsRemoveLp = false;
  try {
    const code = await getVaultBytecodeAt(vaultAddress);
    supportsRemoveLp = code.includes("9d7de6b3");
  } catch {
    supportsRemoveLp = false;
  }
  return {
    address: vaultAddress,
    held: Number(held),
    totalSupply,
    shareBalance,
    ethReserve,
    shareReserve,
    mintFeeBps: Number(mintFeeBps),
    redeemFeeBps: Number(redeemFeeBps),
    targetPremiumBps: Number(targetPremiumBps),
    poolOpen,
    supportsRemoveLp,
  };
}

async function getVaultBytecodeAt(addr: string): Promise<string> {
  const res = await fetch(readUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getCode",
      params: [addr, "latest"],
    }),
  });
  const json = (await res.json()) as { result?: string };
  return (json.result || "").toLowerCase();
}

async function getVaultBytecode(): Promise<string> {
  return getVaultBytecodeAt(requireVaultAddress());
}

/** True if the deployed vault bytecode includes contributeLiquidity(uint256). */
export async function vaultSupportsContributeLiquidity(
  vaultAddress?: string | null
): Promise<boolean> {
  try {
    // selector contributeLiquidity(uint256) = 0xc1244a5c (V2's absolute-credit LP)
    const code = vaultAddress
      ? await getVaultBytecodeAt(requireVaultAddress(vaultAddress))
      : await getVaultBytecode();
    return code.includes("c1244a5c");
  } catch {
    return false;
  }
}

/** True if removeLiquidity(uint256,uint256) is present (V2's tracked LP withdraw). */
export async function vaultSupportsRemoveLiquidity(
  vaultAddress?: string | null
): Promise<boolean> {
  try {
    // selector removeLiquidity(uint256,uint256) = 0x9d7de6b3 (V2 signature)
    const code = vaultAddress
      ? await getVaultBytecodeAt(requireVaultAddress(vaultAddress))
      : await getVaultBytecode();
    return code.includes("9d7de6b3");
  } catch {
    return false;
  }
}

export type LpCredit = { shareCredit: bigint; ethCredit: bigint };

/** Per-address contributeLiquidity credits (0 when vault has no credit getters). */
export async function getLpCredit(
  account: string,
  vaultAddress?: string | null
): Promise<LpCredit> {
  // Live vault (0xb2019…) has neither lpShareCredit nor removeLiquidity — never
  // eth_call those (they revert with empty data and spam RPC noise).
  if (!(await vaultSupportsRemoveLiquidity(vaultAddress))) {
    return { shareCredit: BigInt(0), ethCredit: BigInt(0) };
  }
  try {
    const vault = getPublicVaultReader(vaultAddress);
    const [shareCredit, ethCredit] = await Promise.all([
      vault.lpShareCredit(account) as Promise<bigint>,
      vault.lpEthCredit(account) as Promise<bigint>,
    ]);
    return { shareCredit, ethCredit };
  } catch {
    return { shareCredit: BigInt(0), ethCredit: BigInt(0) };
  }
}

/**
 * Capabilities of the configured vault. Existing deposits stay on the live
 * address forever until holders redeem — never silently repoint the env.
 */
export type VaultCapabilities = {
  contributeLiquidity: boolean;
  removeLiquidity: boolean;
  /** Share-side deepen via ERC-20 transfer into the vault (always true if ERC-20). */
  shareTransferLp: boolean;
};

export async function getVaultCapabilities(
  vaultAddress?: string | null
): Promise<VaultCapabilities> {
  // V3+ (current generation) has proportional LP via addLiquidity /
  // removeLiquidity(uint256,uint256,uint256) — DIFFERENT selectors than V1/V2,
  // so read the generation instead of grepping for the old selectors (which
  // would falsely report a brand-new V3 as having no LP). The precise V3 LP
  // call wiring lives in the trade/LP UI.
  if (vaultGeneration(vaultAddress ?? MARKET_VAULT_ADDRESS) >= 3) {
    return { contributeLiquidity: true, removeLiquidity: true, shareTransferLp: false };
  }
  const [contributeLiquidity, removeLiquidity] = await Promise.all([
    vaultSupportsContributeLiquidity(vaultAddress),
    vaultSupportsRemoveLiquidity(vaultAddress),
  ]);
  return {
    contributeLiquidity,
    removeLiquidity,
    // Any ERC-20 vault can receive shares; live V1/V2 uses this for ask-side depth.
    shareTransferLp: true,
  };
}

/**
 * Add depth to the Instant Swap AMM.
 * - If the vault has contributeLiquidity: shares + optional ETH (tracked credit).
 * - Else (live vault before upgrade): transfer shares to the vault address
 *   (deepens share reserve only; no remove credit; ETH cannot update ethReserve).
 */
export async function contributeLiquidity(
  accountAddress: string,
  sharesIn: bigint,
  ethInWei: bigint,
  onSubmitted?: (hash: string) => void,
  vaultAddress?: string | null
): Promise<{ hash: string; mode: "full" | "shares-only" }> {
  if (sharesIn <= BigInt(0) && ethInWei <= BigInt(0)) {
    throw new Error("Enter shares and/or ETH to add to the pool.");
  }

  // Guardrail: never add NEW liquidity to a pool that is not the current one.
  //
  // The absolute-credit LP primitive on the second-generation pool (selector
  // 0xc1244a5c) has a proven, externally exploitable flaw — see
  // the privately-held V2 LP audit, and the rule in AGENTS.md. Nothing
  // enforced that in code until 2026-08-02: the Instant Swap vault switcher
  // lists every configured pool, and this function targeted whichever one was
  // selected, so a connected user was a few clicks from funding a contract we
  // know can be emptied. The only warning lived in prose on /learn, a page they
  // need never open.
  //
  // Guarded HERE rather than in SwapPanel because a warning is not a control
  // and the panel is not guaranteed to stay the only caller.
  //
  // Scope is deliberately narrow — ADDING liquidity only:
  //   - removeLiquidity() is untouched, so /migrate can still withdraw an
  //     existing position. Getting OUT must never be blocked.
  //   - /floorboards is unaffected; the oldest pool has no LP path at all.
  //   - deposit / redeem / buy / sell on older pools all still work.
  const target = requireVaultAddress(vaultAddress);
  if (vaultGeneration(target) < 3) {
    throw new Error(
      "This is an older pool and no longer accepts liquidity. Add liquidity on the current pool instead — and if you already have a position here, withdraw it from the Migrate page."
    );
  }

  const vault = await getVaultReader(vaultAddress);
  await assertVaultWrapsOurCollection(vault);
  const open = (await vault.poolOpen()) as boolean;
  if (!open) throw new Error("The pool is not open for liquidity yet.");

  const supports = await vaultSupportsContributeLiquidity(vaultAddress);
  if (supports) {
    const hash = await sendVaultTx(
      accountAddress,
      VAULT_IFACE.encodeFunctionData("contributeLiquidity", [sharesIn]),
      ethInWei > BigInt(0) ? ethInWei : undefined,
      onSubmitted,
      vaultAddress
    );
    return { hash, mode: "full" };
  }

  // Legacy path: only shares — ERC-20 transfer to vault increases balanceOf(this).
  if (ethInWei > BigInt(0)) {
    throw new Error(
      "This vault build cannot credit ETH to the pool yet (contributeLiquidity not deployed). Add shares only, or use Sell if you want ETH out of the pool."
    );
  }
  if (sharesIn <= BigInt(0)) {
    throw new Error("Enter a share amount to add to the pool.");
  }
  const hash = await sendVaultTx(
    accountAddress,
    VAULT_IFACE.encodeFunctionData("transfer", [
      requireVaultAddress(vaultAddress),
      sharesIn,
    ]),
    undefined,
    onSubmitted,
    vaultAddress
  );
  return { hash, mode: "shares-only" };
}

/**
 * Withdraw previously contributed LP (up to credit and live reserves).
 * Requires vault with removeLiquidity — no legacy path (raw transfers never
 * minted credit).
 */
export async function removeLiquidity(
  accountAddress: string,
  sharesOut: bigint,
  ethOutWei: bigint,
  onSubmitted?: (hash: string) => void,
  vaultAddress?: string | null
): Promise<string> {
  if (sharesOut <= BigInt(0) && ethOutWei <= BigInt(0)) {
    throw new Error("Enter shares and/or ETH to remove from the pool.");
  }
  if (!(await vaultSupportsRemoveLiquidity(vaultAddress))) {
    throw new Error(
      "This vault build cannot remove LP yet (removeLiquidity not deployed). Use Sell to trade shares for ETH, or wait for the vault upgrade."
    );
  }
  const vault = await getVaultReader(vaultAddress);
  await assertVaultWrapsOurCollection(vault);
  const open = (await vault.poolOpen()) as boolean;
  if (!open) throw new Error("The pool is not open yet.");

  return sendVaultTx(
    accountAddress,
    VAULT_IFACE.encodeFunctionData("removeLiquidity", [sharesOut, ethOutWei]),
    undefined,
    onSubmitted,
    vaultAddress
  );
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
