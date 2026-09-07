import {
  CHAIN,
  CONTRACT_ADDRESS,
  DRAND_BEACON_ADDRESS,
  MARKET_OFFER_CURRENCY,
  MARKET_VAULT_ADDRESSES,
  PERMIT2_ADDRESS,
  SEAPORT_ADDRESS,
  UNIVERSAL_ROUTER_ADDRESS,
} from "@/lib/constants";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import { getPreferredWalletProvider, isWalletConnectActive } from "@/lib/wallet-connect";
import { FOREIGN_CONDUIT_CONTROLLER_ADDRESS, FOREIGN_SEAPORT_ADDRESS, foreignOfferCurrency } from "@/lib/market/multichain/trading/foreign-chain-registry";

export type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  isMetaMask?: boolean;
  isCoinbaseWallet?: boolean;
  isRabby?: boolean;
  isBraveWallet?: boolean;
  isTrust?: boolean;
  isFrame?: boolean;
  providers?: Eip1193Provider[];
};

type InjectedWindow = Window & {
  ethereum?: Eip1193Provider;
  coinbaseWalletExtension?: Eip1193Provider;
};

/**
 * Active wallet provider: WalletConnect session if user chose QR, else injected.
 * All sends (vault seed, swap, market) go through this.
 */
export function getEthereumProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const preferred = getPreferredWalletProvider();
  if (preferred) return preferred;

  const w = window as InjectedWindow;
  const eth = w.ethereum;
  if (!eth) return w.coinbaseWalletExtension || null;
  if (Array.isArray(eth.providers) && eth.providers.length > 0) {
    return (
      eth.providers.find((p) => p.isMetaMask && !p.isBraveWallet) ||
      eth.providers.find((p) => p.isRabby) ||
      eth.providers.find((p) => p.isCoinbaseWallet) ||
      eth.providers.find((p) => p.isBraveWallet) ||
      eth.providers.find((p) => p.isTrust) ||
      eth.providers[0] ||
      eth
    );
  }
  return eth;
}

/** Injected-only (browser extension). Used when user explicitly picks extension. */
export function getInjectedEthereumProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const w = window as InjectedWindow;
  const eth = w.ethereum;
  if (!eth) return w.coinbaseWalletExtension || null;
  if (Array.isArray(eth.providers) && eth.providers.length > 0) {
    return (
      eth.providers.find((p) => p.isRabby) ||
      eth.providers.find((p) => p.isMetaMask && !p.isBraveWallet) ||
      eth.providers[0] ||
      eth
    );
  }
  return eth;
}

export async function getConnectedAccounts(): Promise<string[]> {
  const provider = getEthereumProvider();
  if (!provider) return [];
  try {
    const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
    return Array.isArray(accounts) ? accounts.filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Connect via browser extension only (MetaMask / Rabby extension, etc.). */
export async function connectInjectedWallet(): Promise<string> {
  const { setPreferredWalletProvider } = await import("@/lib/wallet-connect");
  // Prefer extension path — clear any WC preference for this session
  setPreferredWalletProvider(null);

  const provider = getInjectedEthereumProvider();
  if (!provider) {
    throw new Error(
      "No browser extension found. Use WalletConnect QR, or install Rabby / MetaMask."
    );
  }
  try {
    await provider.request({
      method: "wallet_requestPermissions",
      params: [{ eth_accounts: {} }],
    });
  } catch (err) {
    if ((err as { code?: number })?.code === 4001) {
      throw new Error("Connection request closed.");
    }
  }
  const accounts = (await provider.request({
    method: "eth_requestAccounts",
  })) as string[];
  if (!accounts?.[0]) throw new Error("No account returned from wallet.");
  return accounts[0];
}

/**
 * Default connect — still extension for backward compatibility on Trade/Mint.
 * Market / seed UI should open the connect modal (WalletConnect first) instead.
 */
export async function connectWallet(): Promise<string> {
  return connectInjectedWallet();
}

/**
 * Normalize eth_chainId / WalletConnect chain results.
 * Never use parseInt(decimalString, 16) — parseInt("4663", 16) === 18019.
 */
export function normalizeChainId(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "bigint") return Number(raw);
  const s = String(raw ?? "").trim();
  if (!s) throw new Error("Wallet returned empty chain id.");
  if (s.startsWith("0x") || s.startsWith("0X")) {
    const n = parseInt(s, 16);
    // Some wallets mis-encode decimal 4663 as hex 0x4663 (=18019). Treat that
    // common Robinhood misconfig as 4663 so seed/connect still work.
    if (n === 0x4663) return CHAIN.id;
    return n;
  }
  // Decimal string (e.g. "4663") — never parse as hex
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    if (n === 0x4663) return CHAIN.id; // 18019 if someone stored hex digits as decimal
    return n;
  }
  return parseInt(s, 16);
}

export function isRobinhoodChainId(id: number): boolean {
  return id === CHAIN.id || id === 0x4663; // 0x4663 misconfig → normalized away, belt-and-suspenders
}

/**
 * Read wallet chain id. Accepts hex ("0x1237"), decimal ("4663"), and numbers.
 */
export async function getChainId(): Promise<number> {
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");
  const raw = await provider.request({ method: "eth_chainId" });
  return normalizeChainId(raw);
}

export async function switchToRobinhoodChain(): Promise<void> {
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");
  const chainIdHex = `0x${CHAIN.id.toString(16)}`;

  const switchReq = () =>
    provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });

  // WalletConnect + Rabby often never resolves switch — always race a timeout.
  const withTimeout = <T,>(p: Promise<T>, ms: number) =>
    Promise.race([
      p,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("Network switch timed out")), ms)
      ),
    ]);

  try {
    await withTimeout(switchReq() as Promise<unknown>, isWalletConnectActive() ? 3000 : 12_000);
  } catch (err) {
    const code = (err as { code?: number })?.code;
    const timedOut = err instanceof Error && err.message.includes("timed out");
    if (timedOut && isWalletConnectActive()) {
      throw new Error(
        `Switch Rabby to Robinhood Chain (${CHAIN.id}) in the app, then retry. Do not re-scan QR.`
      );
    }
    if (code === 4902 || code === -32603 || code === -32601) {
      try {
        await withTimeout(
          provider.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: chainIdHex,
                chainName: CHAIN.name,
                nativeCurrency: {
                  name: CHAIN.nativeCurrency.name,
                  symbol: CHAIN.nativeCurrency.symbol,
                  decimals: CHAIN.nativeCurrency.decimals,
                },
                rpcUrls: [CHAIN.rpcUrls.default],
                blockExplorerUrls: [CHAIN.blockExplorers.default.url],
              },
            ],
          }) as Promise<unknown>,
          isWalletConnectActive() ? 4000 : 15_000
        );
      } catch {
        if (isWalletConnectActive()) {
          throw new Error(
            `Add/switch to Robinhood Chain (${CHAIN.id}) in Rabby, then retry the seed. Automatic switch is blocked over WalletConnect.`
          );
        }
        throw err;
      }
      try {
        await withTimeout(switchReq() as Promise<unknown>, 3000);
      } catch {
        /* re-check below */
      }
      return;
    }
    if (isWalletConnectActive()) {
      throw new Error(
        `Switch Rabby network to Robinhood Chain (${CHAIN.id}), then retry. Avoid scanning a new QR while already connected.`
      );
    }
    throw err;
  }
}

/**
 * Ensure wallet is on Robinhood (4663). Throws a clear message if not.
 * WalletConnect: never hang forever on switch — timed out above.
 */
export async function ensureRobinhoodChain(): Promise<void> {
  let id: number;
  try {
    id = await getChainId();
  } catch {
    throw new Error("Could not read wallet network. Close modal, reconnect once.");
  }
  if (isRobinhoodChainId(id)) return;

  try {
    await switchToRobinhoodChain();
  } catch {
    const afterFail = await getChainId().catch(() => id);
    if (isRobinhoodChainId(afterFail)) return;
    throw new Error(
      isWalletConnectActive()
        ? `Rabby reports chain ${afterFail}, need Robinhood (${CHAIN.id}). Switch network in Rabby, then “I switched — continue” — do NOT scan a new QR.`
        : `Wallet is on chain ${afterFail}. Switch the extension to Robinhood Chain (${CHAIN.id}), then connect again.`
    );
  }

  const after = await getChainId();
  if (!isRobinhoodChainId(after)) {
    throw new Error(
      isWalletConnectActive()
        ? `Still on chain ${after}. In Rabby → Networks → Robinhood Chain (${CHAIN.id}). Then “I switched — continue” (no new QR).`
        : `Switch wallet network to Robinhood Chain (chain ${CHAIN.id}).`
    );
  }
}

/**
 * Metadata needed to prompt a wallet to add/switch to a chain it may not
 * already know about — the EIP-3085 wallet_addEthereumChain shape, kept
 * minimal to exactly what that call needs.
 */
export type ChainSwitchTarget = {
  chainId: number;
  name: string;
  nativeCurrencySymbol: string;
  rpcUrl: string;
  blockExplorerUrl: string;
};

/**
 * Generalized version of switchToRobinhoodChain/ensureRobinhoodChain, for
 * ANY target chain -- parameterized rather than duplicated, reusing the
 * exact same battle-tested WalletConnect-timeout + wallet_addEthereumChain
 * fallback logic (this app has real, documented wallet quirks around chain
 * switching; a naive from-scratch version for foreign chains would have
 * silently regressed all of that). Additive: switchToRobinhoodChain and
 * ensureRobinhoodChain above are untouched, still the Robinhood-Chain path.
 */
export async function ensureChain(target: ChainSwitchTarget): Promise<void> {
  let id: number;
  try {
    id = await getChainId();
  } catch {
    throw new Error("Could not read wallet network. Close modal, reconnect once.");
  }
  if (id === target.chainId) return;

  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");
  const chainIdHex = `0x${target.chainId.toString(16)}`;

  const switchReq = () =>
    provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });

  const withTimeout = <T,>(p: Promise<T>, ms: number) =>
    Promise.race([
      p,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("Network switch timed out")), ms)),
    ]);

  try {
    await withTimeout(switchReq() as Promise<unknown>, isWalletConnectActive() ? 3000 : 12_000);
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 4902 || code === -32603 || code === -32601) {
      try {
        await withTimeout(
          provider.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: chainIdHex,
                chainName: target.name,
                nativeCurrency: { name: target.nativeCurrencySymbol, symbol: target.nativeCurrencySymbol, decimals: 18 },
                rpcUrls: [target.rpcUrl],
                blockExplorerUrls: [target.blockExplorerUrl],
              },
            ],
          }) as Promise<unknown>,
          isWalletConnectActive() ? 4000 : 15_000
        );
        await withTimeout(switchReq() as Promise<unknown>, 3000).catch(() => {});
      } catch {
        throw new Error(
          isWalletConnectActive()
            ? `Switch Rabby network to ${target.name} (chain ${target.chainId}), then retry.`
            : `Add/switch to ${target.name} (chain ${target.chainId}) in your wallet, then retry.`
        );
      }
    } else if (isWalletConnectActive()) {
      throw new Error(`Switch Rabby network to ${target.name} (chain ${target.chainId}), then retry.`);
    } else {
      throw err;
    }
  }

  const after = await getChainId();
  if (after !== target.chainId) {
    throw new Error(`Switch wallet network to ${target.name} (chain ${target.chainId}).`);
  }
}

export function toHexQuantity(value: string | number | bigint): string {
  if (typeof value === "string" && value.startsWith("0x")) return value;
  // Uniswap often returns decimal strings like "86172000"
  const n = typeof value === "bigint" ? value : BigInt(String(value));
  return `0x${n.toString(16)}`;
}

// UR routes on RH — never allow Uniswap's ~135–171k estimates (OOG reverts burn gas, no PLANK)
const MIN_SWAP_GAS = BigInt(650_000);
const MIN_APPROVE_GAS = BigInt(120_000);

function parseQuantity(raw: string | number | undefined | null): bigint | null {
  if (raw === undefined || raw === null || raw === "") return null;
  try {
    if (typeof raw === "number") return BigInt(Math.floor(raw));
    const s = String(raw).trim();
    if (!s) return null;
    if (s.startsWith("0x") || s.startsWith("0X")) return BigInt(s);
    return BigInt(s);
  } catch {
    return null;
  }
}

type FeePair = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

/**
 * Gas fees for Robinhood Chain (EIP-1559, baseFee often ~0.05–0.1 gwei).
 * Single fee style only — never mix gasPrice with maxFee*.
 * Tips scale with chain (do NOT force 1 gwei on a micro-gwei chain).
 */
async function resolveChainEip1559(
  provider: Eip1193Provider
): Promise<FeePair | null> {
  try {
    const block = (await provider.request({
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    })) as { baseFeePerGas?: string } | null;

    const baseFee = parseQuantity(block?.baseFeePerGas ?? null);
    if (!baseFee || baseFee <= BigInt(0)) return null;

    const gasPrice = parseQuantity(
      (await provider.request({ method: "eth_gasPrice", params: [] })) as string
    );

    // tip = max(gasPrice - base, 15% of base, 1 wei), then +100% for inclusion
    let tip = BigInt(1);
    if (gasPrice && gasPrice > baseFee) tip = gasPrice - baseFee;
    const minTip = (baseFee * BigInt(15)) / BigInt(100) || BigInt(1);
    if (tip < minTip) tip = minTip;
    tip = tip * BigInt(2);
    // maxFee must clear next-block base spikes: 4x base + tip
    const maxFee = baseFee * BigInt(4) + tip;
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: tip };
  } catch {
    return null;
  }
}

async function resolveFeeFields(
  provider: Eip1193Provider
): Promise<Record<string, string>> {
  const eip = await resolveChainEip1559(provider);
  if (eip) {
    return {
      maxFeePerGas: `0x${eip.maxFeePerGas.toString(16)}`,
      maxPriorityFeePerGas: `0x${eip.maxPriorityFeePerGas.toString(16)}`,
    };
  }
  try {
    const gasPrice = parseQuantity(
      (await provider.request({ method: "eth_gasPrice", params: [] })) as string
    );
    if (gasPrice && gasPrice > BigInt(0)) {
      const bumped = (gasPrice * BigInt(150)) / BigInt(100);
      return { gasPrice: `0x${bumped.toString(16)}` };
    }
  } catch {
    /* fall through */
  }
  return {};
}

/** Prefer the higher of Uniswap quote fees vs live RH chain fees (never underprice). */
async function mergeFeeFields(
  provider: Eip1193Provider,
  uniMax: bigint | null,
  uniTip: bigint | null,
  uniLegacy: bigint | null
): Promise<Record<string, string>> {
  const chain = await resolveChainEip1559(provider);

  if (uniMax && uniTip && uniMax >= uniTip) {
    // Uniswap decimal wei → boost 30%
    let maxFee = (uniMax * BigInt(130)) / BigInt(100);
    let tip = (uniTip * BigInt(130)) / BigInt(100);
    if (chain) {
      if (maxFee < chain.maxFeePerGas) maxFee = chain.maxFeePerGas;
      if (tip < chain.maxPriorityFeePerGas) tip = chain.maxPriorityFeePerGas;
      // tip cannot exceed maxFee
      if (tip > maxFee) maxFee = tip;
    }
    return {
      maxFeePerGas: `0x${maxFee.toString(16)}`,
      maxPriorityFeePerGas: `0x${tip.toString(16)}`,
    };
  }

  if (chain) {
    return {
      maxFeePerGas: `0x${chain.maxFeePerGas.toString(16)}`,
      maxPriorityFeePerGas: `0x${chain.maxPriorityFeePerGas.toString(16)}`,
    };
  }

  if (uniLegacy && uniLegacy > BigInt(0)) {
    const bumped = (uniLegacy * BigInt(130)) / BigInt(100);
    return { gasPrice: `0x${bumped.toString(16)}` };
  }

  return resolveFeeFields(provider);
}

export type SendTxOpts = {
  to: string;
  from: string;
  data: string;
  value?: string;
  gas?: string;
  gasLimit?: string;
  /** Prefer Uniswap quote gas estimates (decimal or hex) */
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
  kind?: "swap" | "approve" | "market" | "vault" | "transfer" | "beacon";
};

/**
 * Pre-flight: eth_call + eth_estimateGas on wallet RPC.
 * For swaps we HARD-FAIL before eth_sendTransaction so users never pay gas on doomed txs.
 */
export async function simulateTransaction(tx: {
  to: string;
  from: string;
  data: string;
  value?: string;
}): Promise<{ ok: true; gasEstimate: bigint } | { ok: false; message: string }> {
  const provider = getEthereumProvider();
  if (!provider) return { ok: false, message: "No wallet found." };

  const call: Record<string, string> = {
    to: tx.to,
    from: tx.from,
    data: tx.data,
  };
  if (tx.value) {
    const v = parseQuantity(tx.value);
    if (v !== null && v > BigInt(0)) call.value = `0x${v.toString(16)}`;
  }

  try {
    await provider.request({ method: "eth_call", params: [call, "latest"] });
  } catch (err) {
    const msg =
      (err as { message?: string; data?: { message?: string } })?.message ||
      (err as { data?: { message?: string } })?.data?.message ||
      "Simulation reverted.";
    return { ok: false, message: humanizeTxError(msg, "swap") };
  }

  try {
    const estHex = (await provider.request({
      method: "eth_estimateGas",
      params: [call],
    })) as string;
    const est = parseQuantity(estHex) || MIN_SWAP_GAS;
    return { ok: true, gasEstimate: est };
  } catch (err) {
    const msg = (err as { message?: string })?.message || "Gas estimate failed.";
    return { ok: false, message: humanizeTxError(msg, "swap") };
  }
}

const APPROVE_SPENDERS = new Set([
  PERMIT2_ADDRESS.toLowerCase(),
  CONTRACT_ADDRESS.toLowerCase(),
]);

/**
 * Marketplank sends: Seaport itself (fulfill/cancel), the WETH offer currency
 * (approve/revoke), and each allowlisted collection contract (setApprovalForAll
 * / approve / revoke live ON the NFT contract, so it is the tx `to`).
 */
const MARKET_DESTINATIONS = new Set([
  SEAPORT_ADDRESS.toLowerCase(),
  MARKET_OFFER_CURRENCY.toLowerCase(),
  ...MARKET_COLLECTIONS.map((c) => c.contractAddress.toLowerCase()),
]);

/** Vault sends: any configured vault (primary + legacy + per-collection
 * vaultAddress entries), plus collection approvals. Still a build-time
 * constant set — collection entries ship with releases, never from runtime
 * data. */
function vaultDestinations(): Set<string> {
  const set = new Set(MARKET_COLLECTIONS.map((c) => c.contractAddress.toLowerCase()));
  for (const v of MARKET_VAULT_ADDRESSES) set.add(v.toLowerCase());
  for (const c of MARKET_COLLECTIONS) {
    if (c.vaultAddress) set.add(c.vaultAddress.toLowerCase());
  }
  return set;
}

export function assertSafeSwapDestination(to: string, kind: string) {
  if (kind === "swap") {
    if (to.toLowerCase() !== UNIVERSAL_ROUTER_ADDRESS.toLowerCase()) {
      throw new Error(
        "Blocked unsafe swap target. Official widget only sends to Uniswap Universal Router on Robinhood Chain — never a bridge."
      );
    }
    return;
  }
  if (kind === "approve") {
    if (!APPROVE_SPENDERS.has(to.toLowerCase())) {
      throw new Error(
        "Blocked unsafe approval target. Approvals only go to Permit2 or the $PLANK contract."
      );
    }
    return;
  }
  if (kind === "market") {
    if (!MARKET_DESTINATIONS.has(to.toLowerCase())) {
      throw new Error(
        "Blocked unsafe marketplace target. Market transactions only go to Seaport, the offer currency, or an allowlisted collection."
      );
    }
    return;
  }
  if (kind === "vault") {
    if (MARKET_VAULT_ADDRESSES.length === 0) {
      throw new Error("No liquidity vault deployed — vault transactions are disabled.");
    }
    if (!vaultDestinations().has(to.toLowerCase())) {
      throw new Error(
        "Blocked unsafe vault target. Vault transactions only go to a configured vault (primary or legacy) or an allowlisted collection."
      );
    }
    return;
  }
  if (kind === "transfer") {
    // Deliberately not restricted to MARKET_COLLECTIONS — sending works for
    // any ERC-721 collection, not just the ones listed on this marketplace,
    // so the destination is whatever contract the user themselves supplies.
    // This is safe to leave open unlike "approve": a safeTransferFrom call
    // only ever moves the ONE token the signer explicitly signs for in that
    // same transaction — it can't grant standing access to anything else,
    // so an unexpected destination can't be leveraged into a broader drain
    // the way an unexpected approval target could. The one other valid
    // target under this kind is our own known fee recipient (a plain ETH
    // payment, no calldata — see lib/market/send-fee.ts). Both cases are
    // intentionally unrestricted here; nothing to check.
    return;
  }
  if (kind === "beacon") {
    // The drand beacon's submitRound is permissionless (verifies a BLS
    // signature on-chain, no privilege in calling it — see
    // lib/market/drand.ts) but the destination still needs to be exactly
    // OUR deployed beacon, not an arbitrary contract someone could trick a
    // user into sending calldata to.
    if (to.toLowerCase() !== DRAND_BEACON_ADDRESS.toLowerCase()) {
      throw new Error("Blocked unsafe beacon target. Relay transactions only go to the vault's own drand beacon.");
    }
    return;
  }
  // Unknown kind: fail closed rather than let an unclassified send through.
  throw new Error(`Blocked transaction of unknown kind "${kind}".`);
}

/**
 * assertSafeSwapDestination's foreign-chain sibling, for the Marketplank-
 * native listing feature. NOT the same allowlist as MARKET_DESTINATIONS
 * above -- that Set is a build-time constant of Robinhood-chain-only
 * addresses (curated MARKET_COLLECTIONS, Robinhood's own Seaport/WETH), so
 * a foreign collection's contract address would never be in it even though
 * the transaction itself is entirely legitimate.
 *
 * Preserves the same security property (an explicit, small, contextually-
 * justified allowlist -- never an open "any address goes"): the only
 * destinations permitted for one foreign-chain market transaction are
 * Seaport's canonical address (same on every chain), that chain's real
 * offer currency (if this send is offer-related), and the ONE collection
 * contract address the caller explicitly names for THIS listing/buy/
 * approval -- passed in per-call by the caller, never read from a static,
 * open-ended list, since foreign collections number in the thousands and
 * are not curated the way MARKET_COLLECTIONS is.
 */
export function assertSafeForeignMarketDestination(
  to: string,
  chainSlug: string,
  /**
   * The collection contract(s) this action sequence is for. A single
   * string for every existing single-collection flow (listing, offer,
   * same-collection bundle); an array for a SWAP, which can span multiple
   * distinct NFT contracts on both its offer and consideration sides (see
   * lib/market/order-validation.ts's validateSwapOrder) -- each needs its
   * own approval transaction reaching that SPECIFIC contract, not just
   * "the one collection." Still an explicit, closed allowlist either way;
   * widening to accept a set does not loosen what gets through, it only
   * lets the set legitimately contain more than one real address.
   */
  contractAddress: string | string[]
): void {
  const lower = to.toLowerCase();
  const contractAddresses = Array.isArray(contractAddress) ? contractAddress : [contractAddress];
  const allowed = new Set([
    FOREIGN_SEAPORT_ADDRESS.toLowerCase(),
    // AUDIT lens 3 D3 (2026-09-06): foreign offer creation/acceptance now
    // routes through sendForeignTransaction instead of a raw signer. Those
    // action sequences can target the conduit controller / OpenSea's
    // conduit (Seaport 1.6 approval plumbing) as well as Seaport itself.
    FOREIGN_CONDUIT_CONTROLLER_ADDRESS.toLowerCase(),
    OPENSEA_CONDUIT_ADDRESS.toLowerCase(),
    ...contractAddresses.map((a) => a.toLowerCase()),
  ]);
  // The chain's wrapped-native token (WETH/WBNB/WAVAX) is the ERC-20 an
  // offer approval (`approve(conduit, amount)`) is sent TO.
  const offerCurrency = foreignOfferCurrency(chainSlug);
  if (offerCurrency) allowed.add(offerCurrency.toLowerCase());
  if (!allowed.has(lower)) {
    throw new Error(
      `Blocked unsafe foreign-chain marketplace target. Transactions for this listing only go to Seaport, ` +
        `its conduit, this chain's offer currency, or the collection contract(s) "${contractAddresses.join(", ")}" themselves.`
    );
  }
}

/** OpenSea's conduit (key 0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000), the same address on every chain OpenSea supports. */
export const OPENSEA_CONDUIT_ADDRESS = "0x1E0049783F008A0085193E00003D00cd54003c71";

/**
 * Build + send a tx with RH-chain-aware gas.
 *
 * CRITICAL:
 * - Swaps simulate first — never broadcast a tx that will revert (wastes gas).
 * - Never retry without a hard gas floor (OOG reverts burned gas; felt like "site took ETH").
 * - Only RH chain; swaps only to Universal Router.
 */
export async function sendTransaction(tx: SendTxOpts): Promise<string> {
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");

  await ensureRobinhoodChain();
  const chainId = await getChainId();
  if (!isRobinhoodChainId(chainId)) {
    throw new Error(
      `Wrong network (chain ${chainId}). Switch to ${CHAIN.name} (${CHAIN.id}). This site never bridges to Ethereum.`
    );
  }

  const kind = tx.kind || "swap";
  assertSafeSwapDestination(tx.to, kind);

  const base: Record<string, string> = {
    to: tx.to,
    from: tx.from,
    data: tx.data,
  };
  if (tx.value !== undefined && tx.value !== null && tx.value !== "") {
    const v = parseQuantity(tx.value);
    if (v !== null && v > BigInt(0)) {
      base.value = `0x${v.toString(16)}`;
    } else if (
      typeof tx.value === "string" &&
      tx.value.startsWith("0x") &&
      tx.value !== "0x" &&
      tx.value !== "0x0"
    ) {
      base.value = tx.value;
    }
  }

  // --- Swaps AND market/vault sends: must simulate successfully before the
  // wallet popup. Only bare `approve` skips the hard-fail (a failed approve
  // estimate falls back to the gas floor). ---
  let gasLimit = parseQuantity(tx.gasLimit ?? tx.gas);
  if (kind !== "approve") {
    const sim = await simulateTransaction({
      to: base.to,
      from: base.from,
      data: base.data,
      value: base.value,
    });
    if (!sim.ok) {
      throw new Error(
        `${sim.message} — no tx was sent (your ETH is still in the wallet except prior gas).`
      );
    }
    gasLimit = (sim.gasEstimate * BigInt(180)) / BigInt(100);
  } else {
    try {
      const estHex = (await provider.request({
        method: "eth_estimateGas",
        params: [base],
      })) as string;
      const est = parseQuantity(estHex);
      if (est) gasLimit = (est * BigInt(180)) / BigInt(100);
    } catch {
      /* approve: keep floor */
    }
  }

  // Swap keeps its hard 650k floor (UR OOG-revert history). Market/vault txs
  // are sized by their own hard-fail simulation above, so they take the
  // smaller floor like approvals do.
  const floor = kind === "swap" ? MIN_SWAP_GAS : MIN_APPROVE_GAS;
  if (!gasLimit || gasLimit < floor) gasLimit = floor;
  // Cap only swaps — Seaport sweeps / vault multi-ops can legitimately
  // estimate above 3M; capping them caused OOG after a successful sim.
  if (kind === "swap" && gasLimit > BigInt(3_000_000)) {
    gasLimit = BigInt(3_000_000);
  } else if (kind !== "swap" && gasLimit > BigInt(12_000_000)) {
    gasLimit = BigInt(12_000_000);
  }

  const fees = await mergeFeeFields(
    provider,
    parseQuantity(tx.maxFeePerGas),
    parseQuantity(tx.maxPriorityFeePerGas),
    parseQuantity(tx.gasPrice)
  );

  // Re-assert chain immediately before broadcast (TOCTOU: user can switch
  // networks after simulation).
  const chainIdAgain = await getChainId();
  if (!isRobinhoodChainId(chainIdAgain)) {
    throw new Error(
      `Wrong network (chain ${chainIdAgain}). Switch back to ${CHAIN.name} before confirming.`
    );
  }

  const gasHex = `0x${gasLimit.toString(16)}`;
  // Only shapes that KEEP the gas floor — never bare under-gassed sends
  const attempts: Record<string, string>[] = [
    { ...base, gas: gasHex, gasLimit: gasHex, ...fees },
    { ...base, gas: gasHex, ...fees },
  ];

  let lastMsg = "Transaction rejected.";
  for (let i = 0; i < attempts.length; i++) {
    try {
      return (await provider.request({
        method: "eth_sendTransaction",
        params: [attempts[i]],
      })) as string;
    } catch (err) {
      const msg =
        (err as { message?: string; shortMessage?: string })?.shortMessage ||
        (err as { message?: string })?.message ||
        "Transaction rejected.";
      lastMsg = msg;
      if (/user rejected|denied|4001/i.test(msg)) {
        throw new Error("Transaction cancelled in wallet.");
      }
      if (
        /TRANSFER_FAILED|insufficient funds|exceeds balance|allowance|TRANSFER_FROM|execution reverted|STF|Too little received|Too much requested|INSUFFICIENT/i.test(
          msg
        )
      ) {
        throw new Error(humanizeTxError(msg, kind));
      }
    }
  }
  throw new Error(humanizeTxError(lastMsg, kind));
}

export type SendForeignTxOpts = {
  to: string;
  from: string;
  data: string;
  value?: string;
  chainSlug: string;
  chainId: number;
  chainName: string;
  nativeCurrencySymbol: string;
  rpcUrl: string;
  blockExplorerUrl: string;
  /** The collection contract(s) this transaction is for -- see assertSafeForeignMarketDestination's own doc comment on the single-vs-array distinction. */
  contractAddress: string | string[];
};

/**
 * sendTransaction's foreign-chain sibling, for the Marketplank-native
 * listing feature (buildListing/buildOffer/fulfillOrder's approval and
 * fulfillment broadcasts on a foreign EVM chain). Deliberately a SEPARATE
 * function, not a chainSlug parameter added to sendTransaction: that
 * function's `ensureRobinhoodChain()` + `isRobinhoodChainId` + the
 * build-time MARKET_DESTINATIONS allowlist are all Robinhood-chain-specific
 * by design (this app "never bridges to Ethereum" for its EXISTING flows,
 * an intentional security property this function must not weaken) -- a
 * missed/defaulted chain parameter on the original function would be a real
 * way to accidentally widen what it accepts. Same gas-resolution/simulate/
 * retry logic as sendTransaction, parameterized by the target chain instead
 * of hardcoded to it.
 */
export async function sendForeignTransaction(tx: SendForeignTxOpts): Promise<string> {
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");

  await ensureChain({
    chainId: tx.chainId,
    name: tx.chainName,
    nativeCurrencySymbol: tx.nativeCurrencySymbol,
    rpcUrl: tx.rpcUrl,
    blockExplorerUrl: tx.blockExplorerUrl,
  });
  const chainId = await getChainId();
  if (chainId !== tx.chainId) {
    throw new Error(`Wrong network (chain ${chainId}). Switch to ${tx.chainName} (${tx.chainId}).`);
  }

  assertSafeForeignMarketDestination(tx.to, tx.chainSlug, tx.contractAddress);

  const base: Record<string, string> = {
    to: tx.to,
    from: tx.from,
    data: tx.data,
  };
  if (tx.value !== undefined && tx.value !== null && tx.value !== "") {
    const v = parseQuantity(tx.value);
    if (v !== null && v > BigInt(0)) {
      base.value = `0x${v.toString(16)}`;
    } else if (
      typeof tx.value === "string" &&
      tx.value.startsWith("0x") &&
      tx.value !== "0x" &&
      tx.value !== "0x0"
    ) {
      base.value = tx.value;
    }
  }

  // Same hard-fail-before-broadcast discipline as sendTransaction: simulate
  // first, never send a tx that will revert. Market sends (listing
  // approvals, fulfillment) always simulate here -- there is no bare
  // "approve" fast path the way sendTransaction has, since a foreign
  // approval is exactly as consequential as any other foreign market send.
  const sim = await simulateTransaction({
    to: base.to,
    from: base.from,
    data: base.data,
    value: base.value,
  });
  if (!sim.ok) {
    throw new Error(`${sim.message} — no tx was sent (your ETH is still in the wallet except prior gas).`);
  }
  let gasLimit = (sim.gasEstimate * BigInt(180)) / BigInt(100);
  if (gasLimit < MIN_APPROVE_GAS) gasLimit = MIN_APPROVE_GAS;
  if (gasLimit > BigInt(12_000_000)) gasLimit = BigInt(12_000_000);

  const fees = await mergeFeeFields(provider, null, null, null);

  // Re-assert chain immediately before broadcast (TOCTOU: user can switch
  // networks after simulation).
  const chainIdAgain = await getChainId();
  if (chainIdAgain !== tx.chainId) {
    throw new Error(`Wrong network (chain ${chainIdAgain}). Switch back to ${tx.chainName} before confirming.`);
  }

  const gasHex = `0x${gasLimit.toString(16)}`;
  const attempts: Record<string, string>[] = [
    { ...base, gas: gasHex, gasLimit: gasHex, ...fees },
    { ...base, gas: gasHex, ...fees },
  ];

  let lastMsg = "Transaction rejected.";
  for (let i = 0; i < attempts.length; i++) {
    try {
      return (await provider.request({
        method: "eth_sendTransaction",
        params: [attempts[i]],
      })) as string;
    } catch (err) {
      const msg =
        (err as { message?: string; shortMessage?: string })?.shortMessage ||
        (err as { message?: string })?.message ||
        "Transaction rejected.";
      lastMsg = msg;
      if (/user rejected|denied|4001/i.test(msg)) {
        throw new Error("Transaction cancelled in wallet.");
      }
      if (
        /TRANSFER_FAILED|insufficient funds|exceeds balance|allowance|TRANSFER_FROM|execution reverted|STF|Too little received|Too much requested|INSUFFICIENT/i.test(
          msg
        )
      ) {
        throw new Error(humanizeTxError(msg, "market"));
      }
    }
  }
  throw new Error(humanizeTxError(lastMsg, "market"));
}

function humanizeTxError(msg: string, kind: string): string {
  if (/insufficient funds|exceeds balance/i.test(msg)) {
    return "Insufficient funds. For buys leave ~0.004+ ETH free for gas after the buy amount.";
  }
  if (/TRANSFER_FAILED/i.test(msg)) {
    return "Swap would fail (TRANSFER_FAILED). Fresh quote, slip 2.5–3%, leave ETH for gas. No tx sent.";
  }
  if (/allowance|transfer amount exceeds|TRANSFER_FROM/i.test(msg)) {
    return "Token approval needed. Confirm the approve step, then swap again.";
  }
  if (/Too little received|INSUFFICIENT_OUTPUT|slippage/i.test(msg)) {
    return "Price moved — raise slippage to 2.5–3% and get a fresh quote.";
  }
  if (/simulation|estimateGas|intrinsic gas|gas required|out of gas/i.test(msg)) {
    return `Would fail on ${kind} (simulation). Fresh quote, higher slip, leave ETH for gas. No doomed tx sent.`;
  }
  if (/nonce|already known|replacement/i.test(msg)) {
    return "Pending tx in wallet — Speed Up or Cancel the old one, then retry.";
  }
  return msg.slice(0, 280);
}

/** ERC-20 balanceOf via eth_call (for post-swap delivery checks). */
export async function getErc20Balance(
  token: string,
  owner: string
): Promise<bigint> {
  const provider = getEthereumProvider();
  if (!provider) return BigInt(0);
  try {
    const ownerClean = owner.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    const data = `0x70a08231${ownerClean}`;
    const hex = (await provider.request({
      method: "eth_call",
      params: [{ to: token, data }, "latest"],
    })) as string;
    if (!hex || hex === "0x") return BigInt(0);
    return BigInt(hex);
  } catch {
    return BigInt(0);
  }
}

export async function waitForTransaction(
  hash: string,
  opts?: {
    timeoutMs?: number;
    intervalMs?: number;
    label?: string;
    onPending?: (elapsedMs: number) => void;
  }
): Promise<{ status: "0x0" | "0x1" | string }> {
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const intervalMs = opts?.intervalMs ?? 2_000;
  const label = opts?.label || "Transaction";
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const elapsed = Date.now() - start;
    opts?.onPending?.(elapsed);

    const receipt = (await provider.request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    })) as { status?: string } | null;
    if (receipt?.status) {
      if (receipt.status === "0x0") {
        throw new Error(
          `${label} REVERTED on-chain. Your swap ETH was refunded automatically — only gas was spent (tiny). This is NOT a bridge and NOT a site fee. Raise slip to 2.5–3% and retry.`
        );
      }
      return { status: receipt.status };
    }

    if (elapsed > 40_000) {
      try {
        const tx = (await provider.request({
          method: "eth_getTransactionByHash",
          params: [hash],
        })) as { hash?: string } | null;
        if (!tx) {
          throw new Error(
            `${label} dropped from mempool (underpriced gas). Speed Up in wallet or retry with a fresh quote.`
          );
        }
      } catch (e) {
        if (e instanceof Error && /dropped|mempool/i.test(e.message)) throw e;
      }
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `${label} still pending — open wallet → Speed Up, or wait. Use the explorer link.`
  );
}

export async function signTypedData(
  address: string,
  domain: unknown,
  types: Record<string, unknown>,
  value: unknown
): Promise<string> {
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");

  const typesCopy = { ...types } as Record<string, unknown>;
  delete typesCopy.EIP712Domain;

  let primaryType = "PermitSingle";
  if (typesCopy.PermitBatch) primaryType = "PermitBatch";
  else if (typesCopy.PermitSingle) primaryType = "PermitSingle";
  else {
    const keys = Object.keys(typesCopy);
    if (keys.length === 1) primaryType = keys[0];
    else if (keys.length > 0 && value && typeof value === "object") {
      const msgKeys = Object.keys(value as object);
      const match = keys.find((k) => {
        const fields = typesCopy[k] as { name: string }[] | undefined;
        if (!Array.isArray(fields)) return false;
        return fields.every((f) => msgKeys.includes(f.name));
      });
      primaryType = match || keys[0];
    } else if (keys.length > 0) {
      primaryType = keys[0];
    }
  }

  const payload = JSON.stringify({
    domain,
    types: typesCopy,
    primaryType,
    message: value,
  });

  try {
    return (await provider.request({
      method: "eth_signTypedData_v4",
      params: [address, payload],
    })) as string;
  } catch (err) {
    const msg = (err as { message?: string })?.message || "Signature rejected.";
    if (/user rejected|denied|4001/i.test(msg)) {
      throw new Error("Signature cancelled in wallet.");
    }
    throw new Error(msg);
  }
}

/**
 * personal_sign (EIP-191) over a plain string — used by the /admin console to
 * authorize management mutations (see lib/admin-auth.ts). Note the argument
 * order: personal_sign takes [message, address], the reverse of
 * eth_signTypedData_v4 above.
 */
export async function signMessage(
  address: string,
  message: string
): Promise<string> {
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");
  try {
    return (await provider.request({
      method: "personal_sign",
      params: [message, address],
    })) as string;
  } catch (err) {
    const msg = (err as { message?: string })?.message || "Signature rejected.";
    if (/user rejected|denied|4001/i.test(msg)) {
      throw new Error("Signature cancelled in wallet.");
    }
    throw new Error(msg);
  }
}

export async function getNativeBalance(address: string): Promise<bigint> {
  const provider = getEthereumProvider();
  if (!provider) return BigInt(0);
  try {
    const hex = (await provider.request({
      method: "eth_getBalance",
      params: [address, "latest"],
    })) as string;
    return BigInt(hex || "0x0");
  } catch {
    return BigInt(0);
  }
}
