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

/**
 * Prefer a real injected EVM wallet (MetaMask / Robinhood / Rabby / Coinbase).
 * Supports multi-injected provider arrays (EIP-6963-style ethereum.providers).
 */
export function getEthereumProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const w = window as InjectedWindow;
  const eth = w.ethereum;
  if (!eth) {
    return w.coinbaseWalletExtension || null;
  }
  if (Array.isArray(eth.providers) && eth.providers.length > 0) {
    // Prefer common browser wallets; otherwise first provider
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

/** Silently read connected accounts without prompting. */
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

/**
 * Wallet connect (EIP-1193 eth_requestAccounts).
 * Works with MetaMask, Robinhood Wallet, Rabby, Coinbase, Brave, etc.
 * WalletConnect v2 sessions that inject into window.ethereum are supported the same way.
 */
export async function connectWallet(): Promise<string> {
  const provider = getEthereumProvider();
  if (!provider) {
    throw new Error(
      "No wallet found. Open in Robinhood Wallet browser, or install MetaMask / another EVM wallet."
    );
  }

  // Optional permissions request (ignored if wallet doesn't support it)
  try {
    await provider.request({
      method: "wallet_requestPermissions",
      params: [{ eth_accounts: {} }],
    });
  } catch {
    // Many wallets skip this; eth_requestAccounts is enough
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
      // Some wallets need an explicit switch after add
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

function bumpGas(hexOrNum: string | undefined, bps = 1200): string | undefined {
  // +12% gas headroom for execution reliability
  if (!hexOrNum) return undefined;
  try {
    const n =
      typeof hexOrNum === "string" && hexOrNum.startsWith("0x")
        ? BigInt(hexOrNum)
        : BigInt(hexOrNum);
    const bumped = (n * BigInt(10_000 + bps)) / BigInt(10_000);
    return `0x${bumped.toString(16)}`;
  } catch {
    return typeof hexOrNum === "string" ? hexOrNum : undefined;
  }
}

export async function sendTransaction(tx: {
  to: string;
  from: string;
  data: string;
  value?: string;
  gas?: string;
  gasLimit?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
  chainId?: number | string;
}): Promise<string> {
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");

  await ensureRobinhoodChain();

  const params: Record<string, string> = {
    to: tx.to,
    from: tx.from,
    data: tx.data,
  };
  if (tx.value !== undefined && tx.value !== null && tx.value !== "") {
    params.value = toHexQuantity(tx.value);
  }
  const gas = bumpGas(tx.gasLimit || tx.gas);
  if (gas) params.gas = gas;
  if (tx.maxFeePerGas) params.maxFeePerGas = toHexQuantity(tx.maxFeePerGas);
  if (tx.maxPriorityFeePerGas) {
    params.maxPriorityFeePerGas = toHexQuantity(tx.maxPriorityFeePerGas);
  }
  if (tx.gasPrice) params.gasPrice = toHexQuantity(tx.gasPrice);
  // Prefer chain id from wallet / RH chain — avoid wallet rejecting mismatched chainId
  params.chainId = `0x${CHAIN.id.toString(16)}`;

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
    throw new Error(msg);
  }
}

/**
 * Poll until a tx is mined (or timeout). Used after approve and optionally swap.
 */
export async function waitForTransaction(
  hash: string,
  opts?: { timeoutMs?: number; intervalMs?: number; label?: string }
): Promise<{ status: "0x0" | "0x1" | string }> {
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");
  const timeoutMs = opts?.timeoutMs ?? 180_000;
  const intervalMs = opts?.intervalMs ?? 2_000;
  const label = opts?.label || "Transaction";
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const receipt = (await provider.request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    })) as { status?: string } | null;
    if (receipt && receipt.status) {
      if (receipt.status === "0x0") {
        throw new Error(`${label} reverted on-chain.`);
      }
      return { status: receipt.status };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label.toLowerCase()} confirmation.`);
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

function toHexQuantity(value: string | number | bigint): string {
  if (typeof value === "string" && value.startsWith("0x")) return value;
  const n = typeof value === "bigint" ? value : BigInt(value);
  return `0x${n.toString(16)}`;
}
