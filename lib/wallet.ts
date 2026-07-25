import { CHAIN } from "@/lib/constants";

export type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  isMetaMask?: boolean;
  providers?: Eip1193Provider[];
};

type InjectedWindow = Window & {
  ethereum?: Eip1193Provider;
};

export function getEthereumProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const eth = (window as InjectedWindow).ethereum;
  if (!eth) return null;
  // Prefer MetaMask when multiple injected providers exist.
  if (Array.isArray(eth.providers) && eth.providers.length > 0) {
    const mm = eth.providers.find((p) => p.isMetaMask);
    return mm || eth.providers[0];
  }
  return eth;
}

export async function connectWallet(): Promise<string> {
  const provider = getEthereumProvider();
  if (!provider) {
    throw new Error("No wallet found. Install Robinhood Wallet or MetaMask.");
  }
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
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
    // 4902 = chain not added
    if (code === 4902 || code === -32603) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: chainIdHex,
            chainName: CHAIN.name,
            nativeCurrency: CHAIN.nativeCurrency,
            rpcUrls: [CHAIN.rpcUrls.default],
            blockExplorerUrls: [CHAIN.blockExplorers.default.url],
          },
        ],
      });
      return;
    }
    throw err;
  }
}

export async function ensureRobinhoodChain(): Promise<void> {
  const id = await getChainId();
  if (id !== CHAIN.id) {
    await switchToRobinhoodChain();
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
}): Promise<string> {
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");

  const params: Record<string, string> = {
    to: tx.to,
    from: tx.from,
    data: tx.data,
  };
  if (tx.value) params.value = toHexQuantity(tx.value);
  const gas = tx.gasLimit || tx.gas;
  if (gas) params.gas = toHexQuantity(gas);
  if (tx.maxFeePerGas) params.maxFeePerGas = toHexQuantity(tx.maxFeePerGas);
  if (tx.maxPriorityFeePerGas) params.maxPriorityFeePerGas = toHexQuantity(tx.maxPriorityFeePerGas);
  if (tx.gasPrice) params.gasPrice = toHexQuantity(tx.gasPrice);

  const hash = (await provider.request({
    method: "eth_sendTransaction",
    params: [params],
  })) as string;
  return hash;
}

export async function signTypedData(
  address: string,
  domain: unknown,
  types: Record<string, unknown>,
  value: unknown
): Promise<string> {
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");

  // Strip EIP712Domain from types if present — wallets re-add it from domain.
  const typesCopy = { ...types } as Record<string, unknown>;
  delete typesCopy.EIP712Domain;

  const primaryType =
    (typeof value === "object" &&
      value !== null &&
      "details" in (value as object) &&
      "spender" in (value as object) &&
      "PermitSingle") ||
    Object.keys(typesCopy).find((k) => k === "PermitSingle" || k === "PermitBatch") ||
    Object.keys(typesCopy)[0] ||
    "PermitSingle";

  const payload = JSON.stringify({
    domain,
    types: typesCopy,
    primaryType,
    message: value,
  });

  return (await provider.request({
    method: "eth_signTypedData_v4",
    params: [address, payload],
  })) as string;
}

function toHexQuantity(value: string | number | bigint): string {
  if (typeof value === "string" && value.startsWith("0x")) return value;
  const n = typeof value === "bigint" ? value : BigInt(value);
  return `0x${n.toString(16)}`;
}
