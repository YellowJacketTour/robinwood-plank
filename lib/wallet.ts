import {
  CHAIN,
  CONTRACT_ADDRESS,
  MARKET_OFFER_CURRENCY,
  MARKET_VAULT_ADDRESS,
  PERMIT2_ADDRESS,
  SEAPORT_ADDRESS,
  UNIVERSAL_ROUTER_ADDRESS,
} from "@/lib/constants";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";

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

export function getEthereumProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
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

export async function connectWallet(): Promise<string> {
  const provider = getEthereumProvider();
  if (!provider) {
    throw new Error(
      "No wallet found. Open in Robinhood Wallet browser, or install MetaMask / Rabby."
    );
  }
  try {
    await provider.request({
      method: "wallet_requestPermissions",
      params: [{ eth_accounts: {} }],
    });
  } catch {
    /* optional */
  }
  const accounts = (await provider.request({
    method: "eth_requestAccounts",
  })) as string[];
  if (!accounts?.[0]) throw new Error("No account returned from wallet.");
  return accounts[0];
}

export async function getChainId(): Promise<number> {
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");
  const hex = (await provider.request({ method: "eth_chainId" })) as string;
  return parseInt(hex, 16);
}

export async function switchToRobinhoodChain(): Promise<void> {
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");
  const chainIdHex = `0x${CHAIN.id.toString(16)}`;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 4902 || code === -32603 || code === -32601) {
      await provider.request({
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
      });
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: chainIdHex }],
        });
      } catch {
        /* ok */
      }
      return;
    }
    throw err;
  }
}

export async function ensureRobinhoodChain(): Promise<void> {
  const id = await getChainId();
  if (id !== CHAIN.id) {
    await switchToRobinhoodChain();
    const after = await getChainId();
    if (after !== CHAIN.id) {
      throw new Error(`Switch wallet network to ${CHAIN.name} (chain ${CHAIN.id}).`);
    }
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
  kind?: "swap" | "approve" | "market" | "vault" | "transfer";
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

/** Vault sends: the vault itself, plus collection contracts for the deposit approval. */
function vaultDestinations(): Set<string> {
  const set = new Set(MARKET_COLLECTIONS.map((c) => c.contractAddress.toLowerCase()));
  if (MARKET_VAULT_ADDRESS) set.add(MARKET_VAULT_ADDRESS.toLowerCase());
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
    if (!MARKET_VAULT_ADDRESS) {
      throw new Error("No liquidity vault deployed — vault transactions are disabled.");
    }
    if (!vaultDestinations().has(to.toLowerCase())) {
      throw new Error(
        "Blocked unsafe vault target. Vault transactions only go to the configured vault or an allowlisted collection."
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
  // Unknown kind: fail closed rather than let an unclassified send through.
  throw new Error(`Blocked transaction of unknown kind "${kind}".`);
}

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
  if (chainId !== CHAIN.id) {
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
  if (gasLimit > BigInt(3_000_000)) gasLimit = BigInt(3_000_000);

  const fees = await mergeFeeFields(
    provider,
    parseQuantity(tx.maxFeePerGas),
    parseQuantity(tx.maxPriorityFeePerGas),
    parseQuantity(tx.gasPrice)
  );

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
