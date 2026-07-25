import { CHAIN } from "@/lib/constants";

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

const MIN_SWAP_GAS = BigInt(400_000);
const MIN_APPROVE_GAS = BigInt(100_000);

function parseQuantity(raw: string | number | undefined | null): bigint | null {
  if (raw === undefined || raw === null || raw === "") return null;
  try {
    if (typeof raw === "number") return BigInt(Math.floor(raw));
    if (raw.startsWith("0x") || raw.startsWith("0X")) return BigInt(raw);
    return BigInt(raw);
  } catch {
    return null;
  }
}

/**
 * Gas fees for Robinhood Chain (EIP-1559 with very small baseFee ~0.07 gwei).
 * Single fee style only — never mix gasPrice with maxFee*.
 * Tips scaled to chain (do NOT force 1 gwei on a micro-gwei chain).
 */
async function resolveFeeFields(
  provider: Eip1193Provider
): Promise<Record<string, string>> {
  try {
    const block = (await provider.request({
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    })) as { baseFeePerGas?: string } | null;

    const baseFee = parseQuantity(block?.baseFeePerGas ?? null);
    const gasPrice = parseQuantity(
      (await provider.request({ method: "eth_gasPrice", params: [] })) as string
    );

    if (baseFee && baseFee > BigInt(0)) {
      // tip = max(gasPrice - base, 10% of base, 1 wei)
      let tip = BigInt(1);
      if (gasPrice && gasPrice > baseFee) tip = gasPrice - baseFee;
      const minTip = baseFee / BigInt(10) || BigInt(1);
      if (tip < minTip) tip = minTip;
      // +50% tip for inclusion without overpaying like a 1 gwei floor
      tip = (tip * BigInt(150)) / BigInt(100);
      const maxFee = baseFee * BigInt(3) + tip;
      return {
        maxFeePerGas: `0x${maxFee.toString(16)}`,
        maxPriorityFeePerGas: `0x${tip.toString(16)}`,
      };
    }

    if (gasPrice && gasPrice > BigInt(0)) {
      const bumped = (gasPrice * BigInt(150)) / BigInt(100);
      return { gasPrice: `0x${bumped.toString(16)}` };
    }
  } catch {
    /* fall through */
  }
  return {};
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
  kind?: "swap" | "approve";
};

/**
 * Build + send a tx with RH-chain-aware gas.
 * 1) eth_estimateGas on wallet RPC when possible
 * 2) Floor gas limits (UR swaps need >> 135k Uniswap estimate)
 * 3) EIP-1559 fees from block baseFee (or legacy gasPrice)
 * 4) Retry without hard gas limit if sim fails
 */
export async function sendTransaction(tx: SendTxOpts): Promise<string> {
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");

  await ensureRobinhoodChain();

  const kind = tx.kind || "swap";
  const base: Record<string, string> = {
    to: tx.to,
    from: tx.from,
    data: tx.data,
  };
  if (tx.value !== undefined && tx.value !== null && tx.value !== "") {
    base.value = toHexQuantity(tx.value);
  }

  // --- Gas limit: estimate on wallet RPC, then floor ---
  let gasLimit = parseQuantity(tx.gasLimit ?? tx.gas);
  try {
    const estHex = (await provider.request({
      method: "eth_estimateGas",
      params: [base],
    })) as string;
    const est = parseQuantity(estHex);
    if (est) {
      // +50% headroom for integrator-fee UR routes
      gasLimit = (est * BigInt(150)) / BigInt(100);
    }
  } catch {
    // keep provided / floor
  }
  const floor = kind === "approve" ? MIN_APPROVE_GAS : MIN_SWAP_GAS;
  if (!gasLimit || gasLimit < floor) gasLimit = floor;
  if (gasLimit > BigInt(2_500_000)) gasLimit = BigInt(2_500_000);

  // --- Fees: prefer Uniswap quote eip1559 if valid, else chain ---
  let fees: Record<string, string> = {};
  const uniMax = parseQuantity(tx.maxFeePerGas);
  const uniTip = parseQuantity(tx.maxPriorityFeePerGas);
  const uniLegacy = parseQuantity(tx.gasPrice);
  if (uniMax && uniTip && uniMax >= uniTip) {
    // Uniswap returns decimal wei strings — convert + boost 20% for inclusion
    const maxFee = (uniMax * BigInt(120)) / BigInt(100);
    const tip = (uniTip * BigInt(120)) / BigInt(100);
    fees = {
      maxFeePerGas: `0x${maxFee.toString(16)}`,
      maxPriorityFeePerGas: `0x${tip.toString(16)}`,
    };
  } else if (uniLegacy && uniLegacy > BigInt(0)) {
    const bumped = (uniLegacy * BigInt(130)) / BigInt(100);
    fees = { gasPrice: `0x${bumped.toString(16)}` };
  } else {
    fees = await resolveFeeFields(provider);
  }

  const params: Record<string, string> = {
    ...base,
    gas: `0x${gasLimit.toString(16)}`,
    ...fees,
  };

  try {
    return (await provider.request({
      method: "eth_sendTransaction",
      params: [params],
    })) as string;
  } catch (err) {
    const msg =
      (err as { message?: string; shortMessage?: string })?.shortMessage ||
      (err as { message?: string })?.message ||
      "Transaction rejected.";
    if (/user rejected|denied|4001/i.test(msg)) {
      throw new Error("Transaction cancelled in wallet.");
    }

    // Retry: drop gas limit, keep fees (wallet re-estimates limit)
    try {
      const retry: Record<string, string> = { ...base, ...fees };
      return (await provider.request({
        method: "eth_sendTransaction",
        params: [retry],
      })) as string;
    } catch (err2) {
      // Last resort: only to/data/value — pure wallet estimate
      try {
        return (await provider.request({
          method: "eth_sendTransaction",
          params: [base],
        })) as string;
      } catch (err3) {
        const msg3 =
          (err3 as { message?: string })?.message ||
          (err2 as { message?: string })?.message ||
          msg;
        if (/user rejected|denied|4001/i.test(msg3)) {
          throw new Error("Transaction cancelled in wallet.");
        }
        throw new Error(
          humanizeTxError(msg3, kind)
        );
      }
    }
  }
}

function humanizeTxError(msg: string, kind: string): string {
  if (/insufficient funds|exceeds balance/i.test(msg)) {
    return "Insufficient funds. For buys leave ~0.002+ ETH for gas after the amount.";
  }
  if (/allowance|transfer amount exceeds|TRANSFER_FROM/i.test(msg)) {
    return "Token approval needed. Confirm the approve step, then swap again.";
  }
  if (/simulation|estimateGas|intrinsic gas|gas required/i.test(msg)) {
    return `Wallet simulation failed on ${kind}. Fresh quote, higher slip (2–3%), leave ETH for gas, retry.`;
  }
  if (/nonce|already known|replacement/i.test(msg)) {
    return "Pending tx in wallet — Speed Up or Cancel the old one, then retry.";
  }
  return msg.slice(0, 280);
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
          `${label} reverted on-chain. Try smaller size or higher slip (2–3%).`
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
