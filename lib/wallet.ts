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
  if (!eth) {
    return w.coinbaseWalletExtension || null;
  }
  if (Array.isArray(eth.providers) && eth.providers.length > 0) {
    const ranked =
      eth.providers.find((p) => p.isMetaMask && !p.isBraveWallet) ||
      eth.providers.find((p) => p.isRabby) ||
      eth.providers.find((p) => p.isCoinbaseWallet) ||
      eth.providers.find((p) => p.isBraveWallet) ||
      eth.providers.find((p) => p.isTrust) ||
      eth.providers[0];
    return ranked || eth;
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
      "No wallet found. Open in Robinhood Wallet browser, or install MetaMask / another EVM wallet."
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
        /* already on chain */
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

function toHexQuantity(value: string | number | bigint): string {
  if (typeof value === "string" && value.startsWith("0x")) return value;
  const n = typeof value === "bigint" ? value : BigInt(value);
  return `0x${n.toString(16)}`;
}

/** Minimum gas limit for Universal Router swaps — Uniswap often underestimates. */
const MIN_SWAP_GAS = BigInt(350_000);
const MIN_APPROVE_GAS = BigInt(80_000);

function normalizeGasLimit(
  raw: string | number | undefined,
  kind: "swap" | "approve"
): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  try {
    const n =
      typeof raw === "string" && raw.startsWith("0x") ? BigInt(raw) : BigInt(raw);
    // +40% headroom for integrator fee routes
    let bumped = (n * BigInt(140)) / BigInt(100);
    const floor = kind === "approve" ? MIN_APPROVE_GAS : MIN_SWAP_GAS;
    if (bumped < floor) bumped = floor;
    // Cap absurd values
    if (bumped > BigInt(2_000_000)) bumped = BigInt(2_000_000);
    return `0x${bumped.toString(16)}`;
  } catch {
    return undefined;
  }
}

/**
 * Competitive gas fees from the wallet's own RPC (same chain user is on).
 * Uses ONE fee style only (EIP-1559 OR legacy) so Rabby sim does not break.
 */
async function resolveFeeFields(
  provider: Eip1193Provider
): Promise<Record<string, string>> {
  try {
    const block = (await provider.request({
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    })) as { baseFeePerGas?: string } | null;

    const baseFee = block?.baseFeePerGas ? BigInt(block.baseFeePerGas) : null;

    if (baseFee && baseFee > BigInt(0)) {
      // EIP-1559: tip ~ network gasPrice fraction, maxFee = 2*base + tip
      let tip = BigInt(0);
      try {
        const gp = BigInt(
          (await provider.request({ method: "eth_gasPrice", params: [] })) as string
        );
        tip = gp > baseFee ? gp - baseFee : baseFee / BigInt(10);
      } catch {
        tip = baseFee / BigInt(10) || BigInt(1);
      }
      // Boost tip for inclusion (stuck txs often underpriced)
      if (tip < BigInt(1_000_000_000)) tip = BigInt(1_000_000_000); // 1 gwei floor when possible
      const maxPriority = tip;
      const maxFee = baseFee * BigInt(2) + maxPriority;
      return {
        maxFeePerGas: `0x${maxFee.toString(16)}`,
        maxPriorityFeePerGas: `0x${maxPriority.toString(16)}`,
      };
    }

    // Legacy gasPrice — bump 25% for inclusion
    const gp = BigInt(
      (await provider.request({ method: "eth_gasPrice", params: [] })) as string
    );
    const bumped = (gp * BigInt(125)) / BigInt(100);
    return { gasPrice: `0x${bumped.toString(16)}` };
  } catch {
    return {};
  }
}

export type SendTxOpts = {
  to: string;
  from: string;
  data: string;
  value?: string;
  gas?: string;
  gasLimit?: string;
  kind?: "swap" | "approve";
};

/**
 * Send swap/approve with safe gas so txs don't sit pending forever.
 */
export async function sendTransaction(tx: SendTxOpts): Promise<string> {
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");

  await ensureRobinhoodChain();

  const kind = tx.kind || "swap";
  const params: Record<string, string> = {
    to: tx.to,
    from: tx.from,
    data: tx.data,
  };

  if (tx.value !== undefined && tx.value !== null && tx.value !== "") {
    params.value = toHexQuantity(tx.value);
  }

  const gas = normalizeGasLimit(tx.gasLimit || tx.gas, kind);
  if (gas) params.gas = gas;

  // Competitive fees — single style only
  const fees = await resolveFeeFields(provider);
  Object.assign(params, fees);

  try {
    const hash = (await provider.request({
      method: "eth_sendTransaction",
      params: [params],
    })) as string;
    return hash;
  } catch (err) {
    const msg =
      (err as { message?: string; shortMessage?: string })?.shortMessage ||
      (err as { message?: string })?.message ||
      "Transaction rejected.";
    if (/user rejected|denied|4001/i.test(msg)) {
      throw new Error("Transaction cancelled in wallet.");
    }
    // Retry once without gas limit if estimate/sim failed (wallet re-estimates)
    if (/simulation|estimateGas|intrinsic gas|gas required|underpriced/i.test(msg)) {
      try {
        const retry: Record<string, string> = {
          to: tx.to,
          from: tx.from,
          data: tx.data,
        };
        if (params.value) retry.value = params.value;
        Object.assign(retry, fees);
        const hash = (await provider.request({
          method: "eth_sendTransaction",
          params: [retry],
        })) as string;
        return hash;
      } catch (err2) {
        const msg2 =
          (err2 as { message?: string })?.message ||
          "Wallet rejected the transaction.";
        if (/user rejected|denied|4001/i.test(msg2)) {
          throw new Error("Transaction cancelled in wallet.");
        }
        throw new Error(
          "Wallet simulation failed. Keep extra ETH for gas (don't spend 100% of balance), get a fresh quote, and try again."
        );
      }
    }
    throw new Error(msg);
  }
}

export type TxReceiptStatus = {
  status: "pending" | "success" | "reverted";
  blockNumber?: string;
};

/** One-shot receipt check (for UI polling). */
export async function getTransactionStatus(hash: string): Promise<TxReceiptStatus> {
  const provider = getEthereumProvider();
  if (!provider) return { status: "pending" };
  try {
    const receipt = (await provider.request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    })) as { status?: string; blockNumber?: string } | null;
    if (!receipt) return { status: "pending" };
    if (receipt.status === "0x0") return { status: "reverted", blockNumber: receipt.blockNumber };
    if (receipt.status === "0x1") return { status: "success", blockNumber: receipt.blockNumber };
    return { status: "pending" };
  } catch {
    return { status: "pending" };
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
    if (receipt && receipt.status) {
      if (receipt.status === "0x0") {
        throw new Error(`${label} reverted on-chain. Try a smaller amount or higher slip.`);
      }
      return { status: receipt.status };
    }

    // Detect dropped/replaced: if node no longer knows the tx after 45s
    if (elapsed > 45_000) {
      try {
        const tx = (await provider.request({
          method: "eth_getTransactionByHash",
          params: [hash],
        })) as { hash?: string } | null;
        if (!tx) {
          throw new Error(
            `${label} was dropped from the mempool (often underpriced gas). Speed up or re-send in your wallet, or try again with a fresh quote.`
          );
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("dropped")) throw e;
      }
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `${label} still pending after ${Math.round(timeoutMs / 1000)}s — open your wallet to Speed Up, or wait. Check the explorer link.`
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
    else if (keys.length > 0) {
      if (value && typeof value === "object") {
        const msgKeys = Object.keys(value as object);
        const match = keys.find((k) => {
          const fields = typesCopy[k] as { name: string }[] | undefined;
          if (!Array.isArray(fields)) return false;
          return fields.every((f) => msgKeys.includes(f.name));
        });
        if (match) primaryType = match;
        else primaryType = keys[0];
      } else {
        primaryType = keys[0];
      }
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

/** Native ETH balance in wei (bigint). */
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
